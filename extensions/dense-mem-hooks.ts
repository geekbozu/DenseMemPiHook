import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// This extension's own directory (resolves correctly under jiti) — prompts/ ships next to extensions/.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

// Config layers, highest priority last: repo (.pi/dense-mem-hooks.json) > global (~/.pi/agent/extensions/) > mcp.json (server only).
// Both paths are resolved lazily so getAgentDir() is read at use time.
const GLOBAL_CONFIG_PATH = () => join(getAgentDir(), "extensions", "dense-mem-hooks.json");
const REPO_CONFIG_PATH = (cwd: string) => join(cwd, CONFIG_DIR_NAME, "dense-mem-hooks.json");

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

// Resolve a layer's relative prompt paths against the directory of the file they came from.
function absolutize(cfg: HookConfig, baseDir: string): HookConfig {
  const abs = (p?: string) => (p ? (isAbsolute(p) ? p : resolve(baseDir, p)) : undefined);
  return { ...cfg, systemPromptFile: abs(cfg.systemPromptFile), queriesFile: abs(cfg.queriesFile) };
}

/** Resolve effective config for a cwd: repo overrides global, server fields merge per-layer, mcp.json fills gaps. */
export function resolveConfig(cwd: string): HookConfig {
  const global = absolutize(readJson(GLOBAL_CONFIG_PATH()) ?? {}, dirname(GLOBAL_CONFIG_PATH()));
  const repo = absolutize(readJson(REPO_CONFIG_PATH(cwd)) ?? {}, join(cwd, CONFIG_DIR_NAME));
  const cfg: HookConfig = {
    ...global,
    ...repo,
    server: { ...global.server, ...repo.server },
    repoName: repo.repoName, // repo-scoped only: a global name for every repo makes no sense
    timeoutMs: repo.timeoutMs ?? global.timeoutMs ?? DEFAULTS.timeoutMs,
    maxContextChars: repo.maxContextChars ?? global.maxContextChars ?? DEFAULTS.maxContextChars,
    recallLimit: repo.recallLimit ?? global.recallLimit ?? DEFAULTS.recallLimit,
  };
  if (!cfg.server?.url || !cfg.server?.token) {
    const mcp = readJson(join(getAgentDir(), "mcp.json")) as HookConfig & { mcpServers?: Record<string, { url?: string; bearerToken?: string }> };
    const dm = mcp?.mcpServers?.["dense-mem"];
    cfg.server = {
      url: cfg.server?.url ?? dm?.url,
      token: cfg.server?.token ?? dm?.bearerToken,
    };
  }
  return cfg;
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
  `When calling remember(), include the repository name so memories are scoped to this repo. ` +
  `When calling recall_memory(), prefix queries with the repository name.\n`;

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

async function rpc(server: { url: string; token: string }, timeoutMs: number, method: string, params: unknown, externalSignal?: AbortSignal): Promise<any> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs); // never hang session_start on a dead server
  const signal =
    externalSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
  const resp = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return resp.json();
}

async function dmCall(server: { url: string; token: string }, timeoutMs: number, method: string, args: Record<string, unknown>): Promise<string> {
  const data = await rpc(server, timeoutMs, "tools/call", { name: method, arguments: args });
  return data?.result?.content?.[0]?.text ?? "{}";
}

async function recall(server: { url: string; token: string }, timeoutMs: number, query: string, limit = 10) {
  const text = await dmCall(server, timeoutMs, "recall_memory", { query, limit });
  return JSON.parse(text)?.results ?? [];
}

/** Parse an MCP tools/list result into registerable tool defs. */
export function parseToolDefs(listResult: any): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
  const tools = listResult?.result?.tools ?? [];
  return tools
    .filter((t: any) => t?.name && typeof t.name === "string")
    .map((t: any) => ({
      name: t.name,
      description: (t.description ?? "").slice(0, 500),
      schema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    }));
}

/** Map an MCP tools/call response envelope to a pi tool result. JSON-RPC errors become real tool errors, not "(empty result)". */
export function mapMcpResult(res: any) {
  if (res?.error) {
    return {
      content: [{ type: "text" as const, text: `dense-mem error ${res.error.code}: ${res.error.message}` }],
      details: {},
      isError: true,
    };
  }
  const text = (res?.result?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  return {
    content: [{ type: "text" as const, text: text || "(empty result)" }],
    details: {},
    isError: res?.result?.isError === true,
  };
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
    const at = cps.findIndex((_, i) => needle.every((ch, j) => cps[i + j] === ch));
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

// True when the user manages dense-mem via mcp.json — pi's own MCP client already
// exposes the tools there, so the plugin must not double-register them.
function mcpManagesDenseMem(): boolean {
  try {
    const mcp = JSON.parse(readFileSync(join(getAgentDir(), "mcp.json"), "utf-8"));
    return Boolean(mcp.mcpServers?.["dense-mem"]);
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const cfg = resolveConfig(ctx.cwd);

    // Self-contained tool injection: discover the server's tools and register them,
    // unless mcp.json already manages the dense-mem server (no duplicates).
    if (cfg.server?.url && cfg.server?.token && !mcpManagesDenseMem()) {
      try {
        const list = await rpc(cfg.server, cfg.timeoutMs!, "tools/list", {});
        const repo = cfg.repoName ?? detectRepoCached(ctx.cwd); // anchor writes, not just recall queries
        for (const def of parseToolDefs(list)) {
          const snippet = def.description.split("\n")[0].slice(0, 120);
          pi.registerTool({
            name: def.name,
            label: def.name,
            description: def.description || "(no description)",
            promptSnippet: snippet || def.name,
            parameters:
              typeof (Type as any).Unsafe === "function"
                ? (Type as any).Unsafe(def.schema)
                : def.schema,
            async execute(_toolCallId, params, signal) {
              let args = (params ?? {}) as Record<string, unknown>;
              if (def.name.endsWith("remember")) {
                args = scopeEvidence(args, repo); // [repo] prefix + label
                normalizeSpans(args.evidence as unknown[], args.relationships as unknown[]); // span shift from the prefix is repaired here too
              }
              const res = await rpc(cfg.server, cfg.timeoutMs!, "tools/call", {
                name: def.name,
                arguments: args,
              }, signal);
              return mapMcpResult(res); // full envelope: errors at res.error must surface, not vanish
            },
          });
        }
      } catch {
        // server unreachable — tools skipped; context recall below still runs
      }
    }

    if (!cfg.server?.url || !cfg.server?.token) return;

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

  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = resolveConfig(ctx.cwd);
    const built = buildSystemPrompt(event.systemPrompt, cfg, cfg.repoName ?? detectRepoCached(ctx.cwd));
    if (!built) return;
    return { systemPrompt: built };
  });
}
