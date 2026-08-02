import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This extension's own directory (resolves correctly under jiti) — prompts/ ships next to extensions/.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

// Sidecar config, same pattern as pi-model-sort.json: ~/.pi/agent/extensions/dense-mem-hooks.json
const CONFIG_PATH = join(getAgentDir(), "extensions", "dense-mem-hooks.json");

interface HookConfig {
  server?: { url?: string; token?: string };
  timeoutMs?: number;
  maxContextEntries?: number;
  systemPromptFile?: string;
  queriesFile?: string;
}

const DEFAULTS = { timeoutMs: 5000, maxContextEntries: 8 };

function loadConfig(): HookConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as HookConfig;
  } catch {
    return {}; // no config — defaults + shipped prompts
  }
}

const cfg = loadConfig();

// Server config: config file wins, else the dense-mem entry in mcp.json. Never hardcoded.
function resolveServer(): { url?: string; token?: string } {
  if (cfg.server?.url && cfg.server?.token) return { url: cfg.server.url, token: cfg.server.token };
  try {
    const mcp = JSON.parse(readFileSync(join(getAgentDir(), "mcp.json"), "utf-8"));
    const dm = mcp.mcpServers?.["dense-mem"];
    if (dm?.url && dm?.bearerToken) return { url: dm.url, token: dm.bearerToken };
  } catch {
    // no mcp.json or dense-mem not configured
  }
  return {};
}

const server = resolveServer();
const timeoutMs = cfg.timeoutMs ?? DEFAULTS.timeoutMs;
const maxEntries = cfg.maxContextEntries ?? DEFAULTS.maxContextEntries;

// Prompt source: config override (absolute, or relative to the config file) wins,
// else the shipped prompts/ directory. Returns undefined if missing — hook no-ops.
function readPrompt(rel: string, override?: string): string | undefined {
  const p = override
    ? (isAbsolute(override) ? override : resolve(dirname(CONFIG_PATH), override))
    : join(EXT_DIR, "..", "prompts", rel);
  try {
    return existsSync(p) ? readFileSync(p, "utf-8").trim() : undefined;
  } catch {
    return undefined;
  }
}

function readQueries(override?: string): string[] {
  const raw = readPrompt("queries.md", override);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function detectRepo(cwd: string): string | undefined {
  try {
    const root = execSync("git rev-parse --show-toplevel", { cwd, timeout: 3000, encoding: "utf-8" }).trim();
    return root ? basename(root) : undefined;
  } catch {
    return;
  }
}

async function dmCall(method: string, args: Record<string, unknown>): Promise<string> {
  const resp = await fetch(server.url!, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token!}` },
    signal: AbortSignal.timeout(timeoutMs), // never hang session_start on a dead server
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: method, arguments: args },
    }),
  });
  const data: any = await resp.json();
  return data?.result?.content?.[0]?.text ?? "{}";
}

async function recall(query: string, limit = 3) {
  const text = await dmCall("recall_memory", { query, limit });
  return JSON.parse(text)?.results ?? [];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!server.url || !server.token) return;

    const queries = readQueries(cfg.queriesFile);
    if (queries.length === 0) return;

    const repo = detectRepo(ctx.cwd);
    const scoped = (q: string) => (repo ? `[${repo}] ${q}` : q);

    try {
      const all: string[] = [];
      for (const q of queries) {
        for (const r of await recall(scoped(q))) {
          const c = (r.context ?? r.content ?? "").trim();
          if (c && !all.includes(c)) all.push(c);
        }
      }
      if (all.length === 0) return;

      pi.sendMessage({
        customType: "dense-mem-context",
        content: `[Memory context from previous sessions:]\n${all.slice(0, maxEntries).join("\n\n")}`,
        display: true,
      });
    } catch {
      // MCP unreachable or timed out — agent can still recall via tools
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const sysPrompt = readPrompt("system-prompt.md", cfg.systemPromptFile);
    if (!sysPrompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${sysPrompt}` };
  });
}
