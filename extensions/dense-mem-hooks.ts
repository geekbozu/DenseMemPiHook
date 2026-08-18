import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This extension's own directory (resolves correctly under jiti) — prompts/ ships next to extensions/.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

export interface HookConfig {
  server?: { url?: string; token?: string };
  repoName?: string; // override the detected repo name used for memory scoping
  timeoutMs?: number;
  maxContextChars?: number;
  recallLimit?: number;
  systemPromptFile?: string;
  queriesFile?: string;
}



const DEFAULTS = { timeoutMs: 30000, maxContextChars: 4096, recallLimit: 10 }; // recallLimit = server's own DefaultLimit; ~4 chars/token

// Strip // and /* */ comments outside strings so JSON.parse can read JSONC.
// String-aware: "url": "https://..." must not be truncated at the //.
export function stripJsonComments(src: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += src[++i] ?? ""; // escaped char, e.g. \"
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      if (i < src.length) out += "\n"; // keep the newline so tokens don't merge
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length - 1 : end + 1; // for-loop i++ lands past */
      continue;
    }
    out += ch;
  }
  return out;
}

function readJson(p: string): HookConfig | undefined {
  try {
    return JSON.parse(stripJsonComments(readFileSync(p, "utf-8"))) as HookConfig;
  } catch {
    return undefined; // missing or invalid — layer skipped
  }
}



/** Read a pi settings.json and return the denseMem key if present.
 *  Behavior knobs only — server url/token live in mcp.json + DENSE_MEM_TOKEN.
 *  Relative prompt paths are absolutized against the settings file's directory.
 */
function readSettings(cwd: string): Partial<HookConfig> {
  const read = (p: string): Partial<HookConfig> => {
    try {
      const raw = (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>).denseMem as Partial<HookConfig> ?? {};
      const base = dirname(p);
      const abs = (fp?: string) => (fp ? (isAbsolute(fp) ? fp : resolve(base, fp)) : undefined);
      return { ...raw, systemPromptFile: abs(raw.systemPromptFile), queriesFile: abs(raw.queriesFile) };
    } catch {
      return {};
    }
  };
  const global = read(join(getAgentDir(), "..", "settings.json"));
  const project = read(join(cwd, CONFIG_DIR_NAME, "settings.json"));
  return { ...global, ...project };
}

/** Resolve effective config for a cwd.
 *
 * Server config is not per-hook: the "dense-mem" entry in mcp.json is the single
 * source for the URL, and the token is the DENSE_MEM_TOKEN env var — the same var
 * the MCP adapter reads via bearerTokenEnv. Loading the token is the user's job
 * (pi does not load .env files). settings.json holds behavior knobs only.
 */
export function resolveConfig(cwd: string): HookConfig {
  const settings = readSettings(cwd);
  const mcp = readJson(join(getAgentDir(), "mcp.json")) as { mcpServers?: Record<string, { url?: string }> } | undefined;
  return {
    ...settings,
    server: { url: mcp?.mcpServers?.["dense-mem"]?.url, token: process.env.DENSE_MEM_TOKEN },
    timeoutMs: settings.timeoutMs ?? DEFAULTS.timeoutMs,
    maxContextChars: settings.maxContextChars ?? DEFAULTS.maxContextChars,
    recallLimit: settings.recallLimit ?? DEFAULTS.recallLimit,
  };
}

/** Read queries from a file (override or shipped prompts/queries.md). One per line, # comments and blanks ignored. */
export function readQueries(overrideAbs?: string): string[] {
  const p = overrideAbs ?? join(EXT_DIR, "..", "prompts", "queries.md");
  try {
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Read the system prompt appendix from a file (override or shipped prompts/system-prompt.md). */
export function readSystemPrompt(overrideAbs?: string): string | undefined {
  const p = overrideAbs ?? join(EXT_DIR, "..", "prompts", "system-prompt.md");
  try {
    return existsSync(p) ? readFileSync(p, "utf-8").trim() : undefined;
  } catch {
    return undefined;
  }
}

// Injection-time noise: recall lexically matches these session-close/test/debug
// markers (it has no recency ranking), so they are not real memory.
const GARBAGE_PATTERNS = [
  /session completed/i,
  /memory context from previous sessions/i,
  /this is a test/i,
  /testing if the dense-mem/i,
  /debugging why dense-mem/i,
];

export function isGarbage(c: string): boolean {
  return GARBAGE_PATTERNS.some((re) => re.test(c));
}

// Near-duplicate check: normalized 80-char prefix. Mutates `seen`; returns true
// for empty input and anything already (near-)seen.
export function isDuplicate(c: string, seen: Set<string>): boolean {
  const key = c.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  if (!key || seen.has(key)) return true;
  seen.add(key);
  return false;
}

// Non-editable repo block: generated from git detection, appended after the editable prompt file.
const REPO_PROMPT = (repo: string) =>
  `## Current Repository\n\nRepository: ${repo}\n\n` +
  `When calling remember, include the repository name so memories are scoped to this repo. ` +
  `When calling recall_memory, prefix queries with the repository name.\n`;

/** Build the system prompt appendix: editable prompt file (if any) + non-editable repo block (if repo detected). */
export function buildSystemPrompt(base: string, cfg: HookConfig, repo?: string): string | undefined {
  const editable = readSystemPrompt(cfg.systemPromptFile);
  const parts = [editable, repo ? REPO_PROMPT(repo) : undefined].filter(Boolean) as string[];
  if (parts.length === 0) return undefined;
  return `${base}\n\n${parts.join("\n\n")}`;
}

export function detectRepo(cwd: string): string | undefined {
  try {
    const root = execSync("git rev-parse --show-toplevel", { cwd, timeout: 3000, encoding: "utf-8" }).trim();
    return root ? basename(root) : undefined;
  } catch {
    return;
  }
}

// detectRepo shells out per call; cache per cwd (extensions reload on session switch, so no staleness).
let cachedCwd: string | undefined;
let cachedRepo: string | undefined;
function detectRepoCached(cwd: string): string | undefined {
  if (cachedCwd === cwd) return cachedRepo;
  cachedCwd = cwd;
  cachedRepo = detectRepo(cwd);
  return cachedRepo;
}

// Direct JSON-RPC to the dense-mem server for recall queries at session start.
// The MCP adapter owns tool registration; this is only for the automatic context injection.
async function recall(server: { url: string; token: string }, timeoutMs: number, query: string, limit = 10): Promise<Array<{ context?: string; content?: string }>> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const resp = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    signal: timeoutSignal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recall_memory", arguments: { query, limit } },
    }),
  });
  const data = await resp.json();
  const text = data?.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text)?.results ?? [];
}

/** Anchor stored evidence to this repo: prefix content with [repo] (session_start recall
 *  queries are prefixed identically) and add a repo:<name> label, so scoped recall can
 *  lexically find it. Idempotent — already-tagged items pass through untouched. */
export function scopeEvidence(args: Record<string, unknown>, repo?: string): Record<string, unknown> {
  if (!repo || !Array.isArray(args.evidence)) return args;
  const tag = `[${repo}] `;
  const label = `repo:${repo}`;
  return {
    ...args,
    evidence: args.evidence.map((e) => {
      if (!e || typeof e !== "object") return e;
      const ev = e as Record<string, unknown>;
      const content = typeof ev.content === "string" ? ev.content : "";
      const labels = Array.isArray(ev.labels) ? (ev.labels as string[]) : [];
      return {
        ...ev,
        content: content.startsWith(tag) ? content : tag + content,
        labels: labels.includes(label) ? labels : [...labels, label],
      };
    }),
  };
}

// Repair hand-counted spans before submission: the server requires each surface
// (subject.name / predicate.surface / object entity.name|value.surface) to equal the
// exact Unicode code-point slice of its evidence content (Go runes, not UTF-16 units).
// Rewrites the span from the verbatim surface; leaves it alone when the text isn't in
// the content — that's a real semantic error and the server's message is the truth.
export function normalizeSpans(evidence: unknown[], relationships: unknown[]): unknown[] {
  if (!Array.isArray(evidence) || !Array.isArray(relationships)) return relationships;
  const cpsOf = (idx: number): string[] | undefined => {
    const e = evidence[idx] as { content?: unknown } | undefined;
    return e && typeof e.content === "string" ? Array.from(e.content) : undefined;
  };
  const fixSurface = (holder: unknown, field: string) => {
    const h = holder as { span?: { evidence_index?: number; start?: number; end?: number } } | undefined;
    const span = h?.span;
    const surface = (h as Record<string, unknown> | undefined)?.[field];
    if (!span || typeof surface !== "string" || !surface) return;
    const cps = cpsOf(span.evidence_index ?? -1);
    if (!cps) return;
    if (cps.slice(span.start ?? -1, span.end ?? -1).join("") === surface) return; // already exact
    const needle = Array.from(surface);
    // The model's hand-count is close but not exact, so snap to the occurrence
    // NEAREST its original start: a span aimed at the 2nd "foo" must not silently
    // move to the 1st. Tie (equal distance) → lower index, deterministic.
    const orig = span.start ?? 0;
    let at = -1;
    let dist = Infinity;
    for (let i = 0; i + needle.length <= cps.length; i++) {
      if (!needle.every((ch, j) => cps[i + j] === ch)) continue;
      const d = Math.abs(i - orig);
      if (d < dist) { dist = d; at = i; }
    }
    if (at < 0) return; // not verbatim — leave for the server to report
    span.start = at;
    span.end = at + needle.length;
  };
  const clampEnd = (s: unknown) => {
    const sup = s as { evidence_index?: number; end?: number } | undefined;
    const cps = cpsOf(sup?.evidence_index ?? -1);
    if (!cps || typeof sup?.end !== "number") return;
    if (sup.end > cps.length) sup.end = cps.length;
  };
  for (const rel of relationships) {
    const r = rel as Record<string, unknown>;
    fixSurface(r.subject, "name");
    fixSurface(r.predicate, "surface");
    fixSurface((r.object as Record<string, unknown> | undefined)?.entity, "name");
    fixSurface((r.object as Record<string, unknown> | undefined)?.value, "surface");
    if (Array.isArray(r.supports)) for (const s of r.supports) clampEnd(s);
  }
  return relationships;
}

/** Deterministic JSON: key-sorted, so byte-identical requests hash identically
 *  regardless of the agent's property order. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Stable submission key derived from the request itself: identical (post-normalization)
 *  requests share a key, so the server's knowledge_ingests_idempotency_unique replays them
 *  instead of double-ingesting — the retry cascade and re-stored facts stop doubling.
 *  Same content + different relationship proposal still collides loudly (ErrIdempotencyConflict)
 *  rather than silently duplicating. */
export function requestIdempotencyKey(args: Record<string, unknown>): string | undefined {
  if (!Array.isArray(args.evidence)) return undefined;
  const sum = createHash("sha256")
    .update(canonicalJson({ evidence: args.evidence, relationships: args.relationships }))
    .digest("hex");
  return `sha256:${sum}`;
}

// Known dense-mem tool name stems. Matched suffix-style to handle server prefixes like "dense-mem_".
const DENSE_MEM_TOOL_STEMS = [
  "remember",
  "recall_memory",
  "correct_relationship",
  "retract_evidence",
  "submit_recall_session_feedback",
];

export default function (pi: ExtensionAPI) {
  // Double-load guard: the installed package and a manually copied extension
  // (e.g. ~/.pi/agent/extensions/) evaluate as different module URLs in the
  // same process. The second copy registers nothing but a one-shot warning;
  // /reload of the same file re-evaluates the same URL and stays active.
  const LOADED_BY = "__denseMemHookLoadedBy";
  const selfUrl = import.meta.url;
  const loadedBy = (globalThis as Record<string, unknown>)[LOADED_BY];
  if (loadedBy && loadedBy !== selfUrl) {
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned) return;
      warned = true;
      ctx.ui.notify(
        "DenseMemPiHook is loaded twice (installed package + a manual copy, e.g. in ~/.pi/agent/extensions/). " +
        "Remove the manual copy — this duplicate is inactive.",
        "warning",
      );
    });
    return;
  }
  (globalThis as Record<string, unknown>)[LOADED_BY] = selfUrl;

  // Module-level flag: set once per session in session_start, read by all handlers.
  // true = MCP adapter has registered dense-mem tools; false = skip everything.
  let toolsAvailable = false;

  // ── tool_call hook: normalize spans + scope evidence for remember/correct_relationship ──
  // Already implicitly gated: only fires when the LLM calls the tool.
  pi.on("tool_call", async (event) => {
    const isRemember = event.toolName === "remember" || event.toolName.endsWith("_remember");
    const isCorrect = event.toolName === "correct_relationship" || event.toolName.endsWith("_correct_relationship");
    if (!isRemember && !isCorrect) return;
    const args = event.input as Record<string, unknown> | undefined;
    if (!args) return;

    // Scope evidence: [repo] prefix + repo label (remember only — correct_relationship replaces existing)
    if (isRemember) {
      const cfg = resolveConfig(event.cwd ?? process.cwd());
      const repo = cfg.repoName ?? detectRepoCached(event.cwd ?? process.cwd());
      Object.assign(event.input, scopeEvidence(args, repo));
      // Stable idempotency key: identical requests replay server-side instead of double-ingesting
      if (typeof (event.input as Record<string, unknown>).idempotency_key === "undefined") {
        (event.input as Record<string, unknown>).idempotency_key = requestIdempotencyKey(event.input as Record<string, unknown>);
      }
    }

    // Normalize spans: repair LLM hand-counted offsets (code-point aware, handles emoji/CJK)
    normalizeSpans(
      (event.input as Record<string, unknown>).evidence as unknown[],
      (event.input as Record<string, unknown>).relationships as unknown[],
    );
  });

  // ── session_start: detect MCP tools + inject recall context ──
  pi.on("session_start", async (_event, ctx) => {
    // Check that the MCP adapter has registered dense-mem tools.
    // Everything is gated on this: no tools = no recall, no instructions.
    // Retry a few times — MCP lazy/connecting servers may not be ready yet.
    const hasTools = () => {
      const allTools = pi.getAllTools();
      return DENSE_MEM_TOOL_STEMS.some((stem) =>
        allTools.some((t) => t.name === stem || t.name.endsWith(`_${stem}`)),
      );
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      if (hasTools()) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    toolsAvailable = hasTools();

    if (!toolsAvailable) {
      ctx.ui.notify(
        "Dense-mem tools not found in MCP. " +
        "Add dense-mem to ~/.pi/agent/mcp.json and /reload, " +
        "or install pi-mcp-adapter if not already installed.",
        "warning",
      );
      return; // no tools → no recall, no instructions
    }

    const cfg = resolveConfig(ctx.cwd);
    if (!cfg.server?.url) return;
    if (!cfg.server.token) {
      ctx.ui.notify(
        "Dense-mem: DENSE_MEM_TOKEN env var not set — export it in your shell before starting pi (see README).",
        "warning",
      );
      return;
    }

    const queries = readQueries(cfg.queriesFile);
    if (queries.length === 0) return;

    const repo = cfg.repoName ?? detectRepoCached(ctx.cwd);
    const scoped = (q: string) => (repo ? `[${repo}] ${q}` : q);

    try {
      const seen = new Set<string>();
      const all: string[] = [];
      for (const q of queries) {
        for (const r of await recall(cfg.server, cfg.timeoutMs!, scoped(q), cfg.recallLimit)) {
          const c = (r.context ?? r.content ?? "").trim();
          if (!c || isGarbage(c) || isDuplicate(c, seen)) continue;
          all.push(c);
        }
      }
      if (all.length === 0) return;

      // Char budget, not entry count: snippets vary ~150-900 chars, so a count
      // cap makes context cost unpredictable. ~4 chars/token for English.
      let budget = 0;
      const capped: string[] = [];
      for (const c of all) {
        if (budget + c.length > cfg.maxContextChars) break;
        capped.push(c);
        budget += c.length;
      }

      pi.sendMessage({
        customType: "dense-mem-context",
        content: `[Memory context from previous sessions:]\n${capped.join("\n\n")}`,
        display: true,
      });
    } catch {
      // MCP unreachable or timed out — agent can still recall via tools
    }
  });

  // ── before_agent_start: inject memory instructions into system prompt ──
  // Gated on toolsAvailable (set in session_start). Don't tell the agent
  // about tools that don't exist.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!toolsAvailable) return;
    const cfg = resolveConfig(ctx.cwd);
    const built = buildSystemPrompt(event.systemPrompt, cfg, cfg.repoName ?? detectRepoCached(ctx.cwd));
    if (!built) return;
    return { systemPrompt: built };
  });
}
