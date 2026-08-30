import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename, isAbsolute, resolve, sep } from "node:path";
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
  // Merge global + project mcp.json, project wins (matches pi-mcp-adapter
  // precedence, where .pi/mcp.json is the highest Pi layer).
  const serverOf = (p?: { mcpServers?: Record<string, { url?: string }> }) =>
    p?.mcpServers?.["dense-mem"]?.url;
  const globalMcp = readJson(join(getAgentDir(), "mcp.json")) as
    { mcpServers?: Record<string, { url?: string }> } | undefined;
  const projectMcp = readJson(join(cwd, CONFIG_DIR_NAME, "mcp.json")) as
    { mcpServers?: Record<string, { url?: string }> } | undefined;
  return {
    ...settings,
    server: {
      url: serverOf(projectMcp) ?? serverOf(globalMcp),
      token: process.env.DENSE_MEM_TOKEN,
    },
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
    // Streamable-HTTP MCP requires this Accept; without it the server 406s.
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${server.token}`,
    },
    signal: timeoutSignal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recall_memory", arguments: { query, limit } },
    }),
  });
  // Streamable HTTP answers text/event-stream: JSON-RPC frames on "data:" lines.
  const raw = await resp.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = [...raw.matchAll(/^data: (.+)$/gm)]
      .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .find((m) => m?.id === 1 && m?.result);
  }
  const text = (payload as { result?: { content?: Array<{ text?: string }> } })?.result?.content?.[0]?.text ?? "{}";
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

type SchemaMode = "spans" | "evidence_indices";

// The remember tool's input schema is the version signal: ≤ v2.5.0 relationships
// carry subject/predicate `span` (and predicate `surface`); v2.5.1+ dropped them
// for `evidence_indices`. Sniffed once per session from the registered tool schema
// (no network call). Returns undefined when the schema can't be inspected — callers
// default to the newer variant (worst case, no direct tools registered).
export function detectSchemaMode(pi: { getAllTools(): { name: string; parameters?: unknown }[] }): SchemaMode | undefined {
  const remember = pi.getAllTools().find((t) => t.name === "remember" || t.name.endsWith("_remember"));
  const propsOf = (o: unknown): Record<string, unknown> | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const p = (o as Record<string, unknown>).properties;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : undefined;
  };
  // parameters.properties.relationships.items.properties.subject.properties
  const rootProps = propsOf(remember?.parameters);
  const itemSchema = (rootProps?.relationships as Record<string, unknown> | undefined)?.items;
  const subjectProps = propsOf((propsOf(itemSchema)?.subject) as unknown);
  if (!subjectProps) return undefined;
  return Object.prototype.hasOwnProperty.call(subjectProps, "span") ? "spans" : "evidence_indices";
}

// v2.5.1+ closed-schema validation REJECTS legacy span/surface/supports fields on
// remember; strip them so an LLM with old habits doesn't get hard rejections.
// Keeps everything else (including evidence_indices) untouched. Only called for
// remember — correct_relationship still requires `supports` with spans on both
// schema generations.
export function stripLegacySpans(relationships: unknown[]): unknown[] {
  if (!Array.isArray(relationships)) return relationships;
  const strip = (o: unknown) => {
    if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      delete rec.span;
      delete rec.surface;
    }
  };
  for (const rel of relationships) {
    const r = rel as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") continue;
    delete r.supports;
    strip(r.subject);
    strip(r.predicate);
    const obj = r.object as Record<string, unknown> | undefined;
    strip(obj?.entity);
    strip(obj?.value);
  }
  return relationships;
}

export default function (pi: ExtensionAPI) {
  // Double-load guard: the installed package and a manually copied extension
  // (e.g. ~/.pi/agent/extensions/) evaluate as different module URLs in the
  // same process. Every copy registers itself; the winner is decided by, in
  // order:
  //   1. scope — a project/repo-local copy beats a global (agent-dir) copy,
  //      even at a lower version: the project copy is the one being worked on,
  //      and a stale global copy must never shadow it;
  //   2. version (HOOK_VERSION) — bump on each release;
  //   3. registration order — latest registered wins ties.
  // Every other copy no-ops its handlers and warns once. /reload of the same
  // file re-evaluates the same URL and stays active.
  const HOOK_VERSION = 4;
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g.__denseMemHookCopies)) g.__denseMemHookCopies = [];
  const copies = g.__denseMemHookCopies as { url: string; version: number; seq: number; project: boolean }[];
  const selfUrl = import.meta.url;
  const seq = ((g.__denseMemHookSeq as number) ?? 0) + 1;
  g.__denseMemHookSeq = seq;
  const project = !fileURLToPath(selfUrl.split("?")[0]).startsWith(getAgentDir() + sep);
  copies.push({ url: selfUrl, version: HOOK_VERSION, seq, project });
  const amWinner = () => {
    let best = copies[0];
    for (const c of copies) {
      if (c.project !== best.project) { if (c.project) best = c; continue; }
      if (c.version > best.version || (c.version === best.version && c.seq > best.seq)) best = c;
    }
    return best.url === selfUrl;
  };
  // Every copy registers this; losers warn once, the winner's real session_start
  // handler (registered below) does the work.
  let warned = false;
  pi.on("session_start", (_event, ctx) => {
    if (amWinner()) return;
    if (warned) return;
    warned = true;
    ctx.ui.notify(
      "DenseMemPiHook is loaded twice; another copy is active (this duplicate e.g. in ~/.pi/agent/extensions/). " +
      "Remove the duplicate to silence this warning.",
      "warning",
    );
  });
  if (!amWinner()) return; // older/duplicate copy: only the warning above

  // Module-level flags: set once per session in session_start, read by all handlers.
  // toolsAvailable = MCP adapter has registered dense-mem tools; false = skip everything.
  // schemaMode = server schema generation (drives span repair vs strip).
  let toolsAvailable = false;
  let schemaMode: SchemaMode | undefined;

  // ── tool_call hook: scope evidence + normalize (or strip) spans for remember/correct_relationship ──
  // Already implicitly gated: only fires when the LLM calls the tool.
  pi.on("tool_call", async (event) => {
    if (!amWinner()) return;
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

    const relationships = (event.input as Record<string, unknown>).relationships as unknown[];
    if (schemaMode === "evidence_indices") {
      // v2.5.1+: remember rejects legacy spans — strip them. correct_relationship is
      // untouched: it still requires `supports` with spans on both schema generations.
      if (isRemember) stripLegacySpans(relationships);
    } else {
      // ≤ v2.5.0 (or unknown schema): repair LLM hand-counted offsets (code-point aware)
      normalizeSpans((event.input as Record<string, unknown>).evidence as unknown[], relationships);
    }
  });

  // ── MCP connection tracking ──
  // pi-mcp-adapter publishes status snapshots on pi.events when a server's
  // connection state changes (channel "pi-mcp-adapter/status/v1"). Direct tool
  // registration (pi.getAllTools) depends on the adapter's metadata cache, and
  // the dense-mem server answers tools/list with ttlMs:0, which the adapter
  // treats as "never cache" — so direct tools can be absent even while the
  // server itself is connected. Watching the status event is the reliable
  // "is it up yet" signal; we subscribe once at load so we can't miss the
  // initial connect (eager servers connect at extension load).
  const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
  let dmConnected = false;
  let dmWaiters: Array<() => void> = [];
  pi.events?.on?.(MCP_STATUS_EVENT, (data) => {
    const snap = data as { servers?: Array<{ name?: string; status?: string }> } | undefined;
    if (snap?.servers?.some((s) => s.name === "dense-mem" && s.status === "connected")) {
      dmConnected = true;
      for (const w of dmWaiters) w();
      dmWaiters = [];
    }
  });

  const hasDirectTools = () => {
    const allTools = pi.getAllTools();
    return DENSE_MEM_TOOL_STEMS.some((stem) =>
      allTools.some((t) => t.name === stem || t.name.endsWith(`_${stem}`)),
    );
  };

  // Wait (up to timeoutMs) for dense-mem to be connected or for its direct
  // tools to register. Returns false immediately if the adapter isn't loaded
  // (its proxy tool "mcp" is registered synchronously at adapter load).
  const waitForDenseMem = (timeoutMs: number): Promise<boolean> => {
    if (dmConnected || hasDirectTools()) return Promise.resolve(true);
    if (!pi.getAllTools().some((t) => t.name === "mcp")) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      };
      const t = setTimeout(() => finish(hasDirectTools()), timeoutMs);
      dmWaiters.push(() => finish(true));
    });
  };

  // ── session_start: wait for MCP tools + inject recall context ──
  pi.on("session_start", async (_event, ctx) => {
    if (!amWinner()) return;
    // Everything is gated on this: no tools = no recall, no instructions.
    // Wait for the adapter to report dense-mem connected rather than racing it.
    const cfg = resolveConfig(ctx.cwd);
    toolsAvailable = await waitForDenseMem(cfg.timeoutMs ?? DEFAULTS.timeoutMs);

    if (!toolsAvailable) {
      ctx.ui.notify(
        `Dense-mem not available after ${cfg.timeoutMs ?? DEFAULTS.timeoutMs}ms. ` +
        "Check .pi/mcp.json + DENSE_MEM_TOKEN, then /mcp reconnect dense-mem or /reload.",
        "warning",
      );
      return; // no tools → no recall, no instructions
    }

    // Feature-flag the span repair on the server's schema generation: ≤ v2.5.0
    // repairs hand-counted spans, v2.5.1+ strips legacy span fields instead.
    // Default to the newer variant if the schema can't be sniffed (up-to-date server).
    schemaMode = detectSchemaMode(pi) ?? "evidence_indices";

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
    if (!amWinner()) return;
    if (!toolsAvailable) return;
    const cfg = resolveConfig(ctx.cwd);
    const built = buildSystemPrompt(event.systemPrompt, cfg, cfg.repoName ?? detectRepoCached(ctx.cwd));
    if (!built) return;
    return { systemPrompt: built };
  });
}
