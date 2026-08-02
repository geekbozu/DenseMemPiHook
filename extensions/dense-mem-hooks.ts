import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This extension's own directory (resolves correctly under jiti) — prompts/ ships next to extensions/.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

// Config layers, highest priority last: repo (.pi/dense-mem-hooks.json) > global (~/.pi/agent/extensions/) > mcp.json (server only).
// Both paths are resolved lazily so getAgentDir() is read at use time.
const GLOBAL_CONFIG_PATH = () => join(getAgentDir(), "extensions", "dense-mem-hooks.json");
const REPO_CONFIG_PATH = (cwd: string) => join(cwd, CONFIG_DIR_NAME, "dense-mem-hooks.json");

export interface HookConfig {
  server?: { url?: string; token?: string };
  timeoutMs?: number;
  maxContextEntries?: number;
  systemPromptFile?: string;
  queriesFile?: string;
}

const DEFAULTS = { timeoutMs: 5000, maxContextEntries: 8 };

function readJson(p: string): HookConfig | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as HookConfig;
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
    timeoutMs: repo.timeoutMs ?? global.timeoutMs ?? DEFAULTS.timeoutMs,
    maxContextEntries: repo.maxContextEntries ?? global.maxContextEntries ?? DEFAULTS.maxContextEntries,
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

async function dmCall(server: { url: string; token: string }, timeoutMs: number, method: string, args: Record<string, unknown>): Promise<string> {
  const resp = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(timeoutMs), // never hang session_start on a dead server
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: method, arguments: args },
    }),
  });
  const data: any = await resp.json();
  return data?.result?.content?.[0]?.text ?? "{}";
}

async function recall(server: { url: string; token: string }, timeoutMs: number, query: string, limit = 3) {
  const text = await dmCall(server, timeoutMs, "recall_memory", { query, limit });
  return JSON.parse(text)?.results ?? [];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const cfg = resolveConfig(ctx.cwd);
    if (!cfg.server?.url || !cfg.server?.token) return;

    const queries = readQueries(cfg.queriesFile);
    if (queries.length === 0) return;

    const repo = detectRepoCached(ctx.cwd);
    const scoped = (q: string) => (repo ? `[${repo}] ${q}` : q);

    try {
      const seen = new Set<string>();
      const all: string[] = [];
      for (const q of queries) {
        for (const r of await recall(cfg.server, cfg.timeoutMs!, scoped(q))) {
          const c = (r.context ?? r.content ?? "").trim();
          if (!c || isGarbage(c) || isDuplicate(c, seen)) continue;
          all.push(c);
        }
      }
      if (all.length === 0) return;

      pi.sendMessage({
        customType: "dense-mem-context",
        content: `[Memory context from previous sessions:]\n${all.slice(0, cfg.maxContextEntries).join("\n\n")}`,
        display: true,
      });
    } catch {
      // MCP unreachable or timed out — agent can still recall via tools
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const built = buildSystemPrompt(event.systemPrompt, resolveConfig(ctx.cwd), detectRepoCached(ctx.cwd));
    if (!built) return;
    return { systemPrompt: built };
  });
}
