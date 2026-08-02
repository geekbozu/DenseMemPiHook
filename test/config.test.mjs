import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const { resolveConfig, readQueries, readSystemPrompt } = await import("../extensions/dense-mem-hooks.ts");

// Scratch agent dir per test so config layers are fully controlled.
function makeAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "dmhook-agent-"));
  process.env.__TEST_AGENT_DIR__ = dir;
  return dir;
}

function write(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

test("no config anywhere -> empty server, defaults, shipped prompts", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server?.url, undefined);
  assert.equal(cfg.timeoutMs, 5000);
  assert.equal(cfg.maxContextEntries, 8);
  assert.ok(readSystemPrompt(cfg.systemPromptFile).includes("Memory System Instructions"));
  assert.deepEqual(readQueries(cfg.queriesFile), [
    "recent conversations, active projects, and current tasks",
    "user preferences, workflow, and how they like things done",
    "architecture decisions, tech stack, and design patterns",
  ]);
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("repo config overrides global per-field, server fields merge", () => {
  const agent = makeAgentDir();
  write(join(agent, "extensions", "dense-mem-hooks.json"), JSON.stringify({
    server: { url: "http://global:1/mcp", token: "dm_global" },
    timeoutMs: 3000,
    maxContextEntries: 4,
  }));
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  write(join(cwd, ".pi", "dense-mem-hooks.json"), JSON.stringify({
    server: { token: "dm_repo_token" }, // url inherited from global
    queriesFile: "queries-custom.md",
  }));
  write(join(cwd, ".pi", "queries-custom.md"), "repo-only query\n");

  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.url, "http://global:1/mcp");
  assert.equal(cfg.server.token, "dm_repo_token");
  assert.equal(cfg.timeoutMs, 3000); // from global
  assert.equal(cfg.maxContextEntries, 4); // from global
  // relative queriesFile resolved against the repo .pi dir
  assert.equal(cfg.queriesFile, join(cwd, ".pi", "queries-custom.md"));
  assert.deepEqual(readQueries(cfg.queriesFile), ["repo-only query"]);
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("repo prompt override wins for system prompt injection", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  write(join(cwd, ".pi", "dense-mem-hooks.json"), JSON.stringify({
    systemPromptFile: "team-prompt.md",
  }));
  write(join(cwd, ".pi", "team-prompt.md"), "## TEAM RULES\nbehave");

  const cfg = resolveConfig(cwd);
  const injected = readSystemPrompt(cfg.systemPromptFile);
  assert.ok(injected.includes("TEAM RULES"));
  assert.ok(!injected.includes("Memory System Instructions"));
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("mcp.json fills server gaps when no config sets server", () => {
  const agent = makeAgentDir();
  write(join(agent, "mcp.json"), JSON.stringify({
    mcpServers: { "dense-mem": { url: "http://mcp:8080/mcp", bearerToken: "dm_mcp" } },
  }));
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.url, "http://mcp:8080/mcp");
  assert.equal(cfg.server.token, "dm_mcp");
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("queries parsing: comments, blanks, and whitespace are ignored", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  write(join(cwd, ".pi", "dense-mem-hooks.json"), JSON.stringify({ queriesFile: "q.md" }));
  write(join(cwd, ".pi", "q.md"), "# header comment\n\nfirst query  \n# another\nsecond\n\n");
  assert.deepEqual(readQueries(resolveConfig(cwd).queriesFile), ["first query", "second"]);
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
