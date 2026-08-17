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

test("no config anywhere -> empty server, defaults, shipped prompts", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server?.url, undefined);
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

test("project settings.json overrides global settings.json", () => {
  const agent = makeAgentDir();
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  // Global settings in a standalone dir to avoid leaking
  const globalDir = mkdtempSync(join(tmpdir(), "dmhook-global-"));
  process.env.__TEST_AGENT_DIR__ = join(globalDir, "agent");
  mkdirSync(join(globalDir, "agent"), { recursive: true });
  write(join(globalDir, "settings.json"), JSON.stringify({
    denseMem: {
      server: { url: "http://global:1/mcp", token: "dm_global" },
      timeoutMs: 3000,
      maxContextChars: 2048,
      recallLimit: 20,
    },
  }));
  write(join(cwd, ".pi", "settings.json"), JSON.stringify({
    denseMem: {
      server: { token: "dm_project" }, // url inherited from global
      queriesFile: "queries-custom.md",
    },
  }));
  write(join(cwd, ".pi", "queries-custom.md"), "project query\n");

  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.url, "http://global:1/mcp");
  assert.equal(cfg.server.token, "dm_project");
  assert.equal(cfg.timeoutMs, 3000);
  assert.equal(cfg.maxContextChars, 2048);
  assert.equal(cfg.recallLimit, 20);
  assert.deepEqual(readQueries(cfg.queriesFile), ["project query"]);
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("mcp.json fills server gaps when no settings set server", () => {
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

test("shipped example config parses (JSONC) with core fields active, options documented", () => {
  const example = join(dirname(fileURLToPath(import.meta.url)), "..", "dense-mem-hooks.example.json");
  const raw = readFileSync(example, "utf-8");
  const cfg = JSON.parse(stripJsonComments(raw)); // strict JSON.parse after stripping — no comments allowed
  assert.equal(cfg.server.url, "https://mem.example.com/mcp");
  assert.equal(cfg.server.token, "dm_your-profile-token-here");
  assert.deepEqual(Object.keys(cfg), ["server"], "only required fields active");
  // optional knobs stay documented as comments so they don't silently drift
  for (const key of ["timeoutMs", "maxContextChars", "recallLimit", "systemPromptFile", "queriesFile"]) {
    assert.ok(raw.includes(key), `example documents ${key}`);
  }
  // config source docs
  assert.ok(raw.includes(".dense-mem-token"), "example documents token file");
});

test(".dense-mem-token file in repo root provides token fallback", () => {
  const agent = makeAgentDir();
  write(join(agent, "mcp.json"), JSON.stringify({
    mcpServers: { "dense-mem": { url: "http://mcp:8080/mcp" } }, // no bearerToken
  }));
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  write(join(cwd, ".dense-mem-token"), "dm_file_token\n");
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.url, "http://mcp:8080/mcp");
  assert.equal(cfg.server.token, "dm_file_token");
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
})

test("settings.json token beats file token", () => {
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-repo-"));
  // Isolated agent+settings dir
  const globalDir = mkdtempSync(join(tmpdir(), "dmhook-global-"));
  process.env.__TEST_AGENT_DIR__ = join(globalDir, "agent");
  mkdirSync(join(globalDir, "agent"), { recursive: true });
  write(join(globalDir, "settings.json"), JSON.stringify({
    denseMem: { server: { url: "http://settings:8080/mcp", token: "dm_settings" } },
  }));
  write(join(cwd, ".dense-mem-token"), "dm_file_token\n");
  const cfg = resolveConfig(cwd);
  assert.equal(cfg.server.token, "dm_settings", "settings wins over file");
  rmSync(globalDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("detectRepo returns the git root basename inside a repo", () => {
  assert.equal(detectRepo(process.cwd()), "DenseMemPiHook");
  assert.equal(detectRepo(join(tmpdir(), "no-such-dir-xyz")), undefined);
});
