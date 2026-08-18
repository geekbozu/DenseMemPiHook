import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const { resolveConfig, readQueries, readSystemPrompt, isGarbage, isDuplicate, buildSystemPrompt, detectRepo, stripJsonComments } = await import("../extensions/dense-mem-hooks.ts");

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

// DENSE_MEM_TOKEN is the single token source; tests set/clear it explicitly.
const setToken = (t) => (t === undefined ? delete process.env.DENSE_MEM_TOKEN : (process.env.DENSE_MEM_TOKEN = t));

function writeMcp(agent, url) {
  write(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { "dense-mem": { url } } }));
}

test("no config anywhere -> empty server, defaults, shipped prompts", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  setToken(undefined);
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server?.url, undefined);
  assert.equal(cfg.server?.token, undefined);
  assert.equal(cfg.timeoutMs, 30000);
  assert.equal(cfg.maxContextChars, 4096);
  assert.equal(cfg.recallLimit, 10);
  assert.ok(readSystemPrompt(cfg.systemPromptFile).includes("Memory System Instructions"));
  assert.deepEqual(readQueries(cfg.queriesFile), [
    "project goals, tasks, and named decisions",
    "user preferences, workflow, and conventions",
    "architecture, tech stack, and design patterns",
  ]);
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("project settings.json overrides global settings.json (behavior knobs only)", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  // Global settings in a standalone dir to avoid leaking
  const globalDir = mkdtempSync(join(tmpdir(), "dmhook-global-"));
  process.env.__TEST_AGENT_DIR__ = join(globalDir, "agent");
  mkdirSync(join(globalDir, "agent"), { recursive: true });
  write(join(globalDir, "settings.json"), JSON.stringify({
    denseMem: {
      timeoutMs: 3000,
      maxContextChars: 2048,
      recallLimit: 20,
    },
  }));
  writeMcp(join(globalDir, "agent"), "http://mcp:8080/mcp");
  setToken("dm_env");
  write(join(cwd, ".pi", "settings.json"), JSON.stringify({
    denseMem: {
      queriesFile: "queries-custom.md",
    },
  }));
  write(join(cwd, ".pi", "queries-custom.md"), "project query\n");

  const cfg = resolveConfig(cwd);
  // server comes from mcp.json + env var, not settings
  assert.equal(cfg.server.url, "http://mcp:8080/mcp");
  assert.equal(cfg.server.token, "dm_env");
  assert.equal(cfg.timeoutMs, 3000);
  assert.equal(cfg.maxContextChars, 2048);
  assert.equal(cfg.recallLimit, 20);
  assert.deepEqual(readQueries(cfg.queriesFile), ["project query"]);
  setToken(undefined);
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("server config comes from mcp.json url + DENSE_MEM_TOKEN env var", () => {
  const agent = makeAgentDir();
  writeMcp(agent, "http://mcp:8080/mcp");
  setToken("dm_env_token");
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.url, "http://mcp:8080/mcp");
  assert.equal(cfg.server.token, "dm_env_token");
  setToken(undefined);
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("settings server key is ignored (mcp.json + env var are the only auth)", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  const globalDir = mkdtempSync(join(tmpdir(), "dmhook-global-"));
  process.env.__TEST_AGENT_DIR__ = join(globalDir, "agent");
  mkdirSync(join(globalDir, "agent"), { recursive: true });
  write(join(globalDir, "settings.json"), JSON.stringify({
    denseMem: { server: { url: "http://old:1/mcp", token: "dm_old" } },
  }));
  writeMcp(join(globalDir, "agent"), "http://mcp:8080/mcp");
  setToken("dm_env");
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.url, "http://mcp:8080/mcp", "mcp.json url wins");
  assert.equal(cfg.server.token, "dm_env", "env token wins");
  setToken(undefined);
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("garbage filter: session-close, test, and debug markers are noise", () => {
  for (const g of [
    "Session completed with pi-coding-agent",
    "[Memory context from previous sessions:] something",
    "this is a test, testing if the dense-mem works",
    "debugging why dense-mem processing pipeline is stuck",
  ]) {
    assert.ok(isGarbage(g), `should be garbage: ${g}`);
  }
  assert.ok(!isGarbage("User prefers pnpm over npm"));
  assert.ok(!isGarbage("The project uses SolidJS with Tailwind v4"));
});

test("dedupe: exact and near-duplicates via normalized 80-char prefix", () => {
  const shared = "User prefers pnpm over npm for package management and likes fast tooling in every project, but tolerates slow CI when ";
  const seen = new Set();
  const a = shared + "it is a legacy monorepo";
  assert.equal(isDuplicate(a, seen), false);
  assert.equal(isDuplicate(a, seen), true, "exact repeat is duplicate");
  const b = shared + "it is a brand new codebase";
  assert.equal(isDuplicate(b, seen), true, "same 80-char prefix is near-duplicate");
  const seen2 = new Set();
  isDuplicate("Foo  Bar baz", seen2);
  assert.equal(isDuplicate("foo bar baz", seen2), true, "whitespace/case normalization");
  assert.equal(isDuplicate("", seen2), true, "empty is skipped");
});

test("repo-aware system prompt: non-editable repo block appended after editable prompt", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  const cfg = resolveConfig(cwd);
  const built = buildSystemPrompt("BASE", cfg, "myrepo");
  assert.ok(built.startsWith("BASE"));
  assert.ok(built.includes("## Current Repository"));
  assert.ok(built.includes("Repository: myrepo"));
  assert.ok(built.includes("include the repository name so memories are scoped to this repo"));
  assert.ok(built.includes("Memory System Instructions"), "editable prompt file still appended");
  const noRepo = buildSystemPrompt("BASE", cfg, undefined);
  assert.ok(noRepo.includes("Memory System Instructions"));
  assert.ok(!noRepo.includes("Current Repository"), "no repo block outside a repo");
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("stripJsonComments: JSONC comments removed, URLs and escapes in strings kept", () => {
  const src = `{
  // line comment
  "url": "https://mem.example.com/mcp?q=a//b", /* block */
  "s": "a /* not a comment */ b",
  "esc": "say \\"hi\\"" // trailing
}`;
  const parsed = JSON.parse(stripJsonComments(src));
  assert.equal(parsed.url, "https://mem.example.com/mcp?q=a//b");
  assert.equal(parsed.s, "a /* not a comment */ b");
  assert.equal(parsed.esc, 'say "hi"');
});

test("shipped example config documents the single auth surface", () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), "..", "dense-mem-hooks.example.json");
  const raw = readFileSync(example, "utf-8");
  const cfg = JSON.parse(stripJsonComments(raw));
  assert.deepEqual(Object.keys(cfg), [], "no active config fields — reference card only");
  for (const key of ["mcpServers", "bearerTokenEnv", "DENSE_MEM_TOKEN", "timeoutMs", "maxContextChars", "recallLimit", "systemPromptFile", "queriesFile"]) {
    assert.ok(raw.includes(key), `example documents ${key}`);
  }
  assert.ok(raw.includes(".env"), "example explains pi does not load .env");
});

test("detectRepo returns the git root basename inside a repo", () => {
  assert.equal(detectRepo(process.cwd()), "DenseMemPiHook");
  assert.equal(detectRepo(join(tmpdir(), "no-such-dir-xyz")), undefined);
});
