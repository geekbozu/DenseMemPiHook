import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { scopeEvidence, requestIdempotencyKey, normalizeSpans } = await import("../extensions/dense-mem-hooks.ts");

function makePi(overrides = {}) {
  const handlers = {};
  const sent = [];
  const notified = [];
  const tools = overrides.tools ?? [];
  const pi = {
    on: (ev, h) => (handlers[ev] = h),
    sendMessage: (m) => sent.push(m),
    getAllTools: () => tools,
  };
  // ctx is passed per-event; build a reusable mock
  const makeCtx = (cwd) => ({
    cwd,
    ui: { notify: (msg, level) => notified.push({ msg, level }) },
  });
  return { pi, handlers, sent, notified, makeCtx };
}

function agentDirWith({ config, mcpJson } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dmhook-tools-"));
  process.env.__TEST_AGENT_DIR__ = dir;
  if (config) {
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeFileSync(join(dir, "extensions", "dense-mem-hooks.json"), JSON.stringify(config));
  }
  if (mcpJson) writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcpJson));
  return dir;
}

const cleanup = (dirs) => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};

// ── tool_call hook tests ──

test("tool_call hook: scopeEvidence adds [repo] prefix and repo label", async () => {
  const args = { evidence: [{ content: "user prefers pnpm", labels: ["pref"] }] };
  const result = scopeEvidence(args, "MyRepo");
  assert.deepEqual(result.evidence, [{ content: "[MyRepo] user prefers pnpm", labels: ["pref", "repo:MyRepo"] }]);
  // idempotent
  const result2 = scopeEvidence(result, "MyRepo");
  assert.deepEqual(result2.evidence, result.evidence, "already tagged passes through");
});

test("tool_call hook: scopeEvidence skips when no repo", async () => {
  const args = { evidence: [{ content: "user prefers pnpm", labels: ["pref"] }] };
  assert.deepEqual(scopeEvidence(args, undefined), args);
  assert.deepEqual(scopeEvidence(args, ""), args);
});

test("tool_call hook: requestIdempotencyKey is deterministic", async () => {
  const args = { evidence: [{ content: "test" }], relationships: [{ ref: "r1" }] };
  const k1 = requestIdempotencyKey(args);
  const k2 = requestIdempotencyKey(args);
  assert.equal(k1, k2, "same input → same key");
  assert.ok(k1.startsWith("sha256:"));
  // different content → different key
  const args2 = { evidence: [{ content: "different" }], relationships: [{ ref: "r1" }] };
  assert.notEqual(requestIdempotencyKey(args), requestIdempotencyKey(args2));
});

test("tool_call hook: normalizeSpans repairs wrong spans, code-point aware", async () => {
  const evidence = [{ content: "a😀b prefers pnpm" }];
  const rels = [
    {
      subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 4, end: 5 } },
      predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 0, end: 4 } },
      object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 10, end: 13 } } },
      supports: [{ evidence_index: 0, start: 0, end: 999 }],
    },
    {
      subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 2, end: 3 } }, // already exact
      predicate: { proposed_key: "likes", surface: "does not appear", span: { evidence_index: 0, start: 2, end: 3 } },
      object: { entity: { name: "a", entity_kind: "concept", span: { evidence_index: 0, start: 0, end: 1 } } },
    },
  ];
  normalizeSpans(evidence, rels);
  assert.deepEqual(rels[0], {
    subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 2, end: 3 } },
    predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 4, end: 16 } },
    object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 12, end: 16 } } },
    supports: [{ evidence_index: 0, start: 0, end: 16 }],
  });
  assert.deepEqual(rels[1], {
    subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 2, end: 3 } },
    predicate: { proposed_key: "likes", surface: "does not appear", span: { evidence_index: 0, start: 2, end: 3 } },
    object: { entity: { name: "a", entity_kind: "concept", span: { evidence_index: 0, start: 0, end: 1 } } },
  });
});

test("normalizeSpans: duplicate surface snaps to nearest occurrence", async () => {
  const evidence = [{ content: "foo bar foo" }, { content: "foo foo" }];
  const rels = [
    {
      subject: { name: "foo", entity_kind: "concept", span: { evidence_index: 0, start: 10, end: 11 } }, // near 2nd foo
      predicate: { proposed_key: "mentions", surface: "foo bar foo", span: { evidence_index: 0, start: 0, end: 4 } },
      object: { entity: { name: "bar", entity_kind: "concept", span: { evidence_index: 0, start: 3, end: 6 } } },
    },
    {
      subject: { name: "foo", entity_kind: "concept", span: { evidence_index: 1, start: 2, end: 3 } }, // equidistant
      predicate: { proposed_key: "x", surface: "does not appear", span: { evidence_index: 1, start: 0, end: 3 } },
      object: { entity: { name: "baz", entity_kind: "concept", span: { evidence_index: 1, start: 3, end: 4 } } },
    },
  ];
  normalizeSpans(evidence, rels);
  assert.equal(rels[0].subject.span.start, 8, "second occurrence wins when original span is near it");
  assert.equal(rels[0].subject.span.end, 11);
  assert.equal(rels[1].subject.span.start, 0, "tie → lower index");
  assert.deepEqual(rels[1].predicate.span, { evidence_index: 1, start: 0, end: 3 }, "absent surface untouched");
  assert.deepEqual(rels[1].object.entity.span, { evidence_index: 1, start: 3, end: 4 }, "absent surface untouched");
});

// ── session_start tests ──

test("session_start warns + skips recall when MCP tools not found", async () => {
  const dir = agentDirWith({
    config: { server: { url: "http://127.0.0.1:1/mcp", token: "dm_test" }, timeoutMs: 1000 },
  });
  const { pi, handlers, notified, sent, makeCtx } = makePi({ tools: [] });
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, makeCtx(dir));

  assert.ok(notified.length > 0, "should notify");
  assert.ok(notified[0].msg.includes("Dense-mem tools not found"), notified[0].msg);
  assert.equal(notified[0].level, "warning");
  assert.equal(sent.length, 0, "no recall injection when tools unavailable");

  cleanup([dir]);
});

test("session_start does NOT warn when dense-mem tools are registered", async () => {
  const dir = agentDirWith({
    config: { server: { url: "http://127.0.0.1:1/mcp", token: "dm_test" }, timeoutMs: 1000 },
  });
  const { pi, handlers, notified, makeCtx } = makePi({
    tools: [
      { name: "remember", description: "Remember" },
      { name: "recall_memory", description: "Recall" },
    ],
  });
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, makeCtx(dir));

  assert.equal(notified.length, 0, "no warning when tools exist");

  cleanup([dir]);
});

test("session_start warns when tools not found even without server config", async () => {
  const dir = agentDirWith({ config: {} });
  const { pi, handlers, notified, makeCtx } = makePi({ tools: [] });
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, makeCtx(dir));

  assert.ok(notified.length > 0, "should warn about missing tools");
  assert.ok(notified[0].msg.includes("Dense-mem tools not found"), notified[0].msg);

  cleanup([dir]);
});

test("session_start survives a dead server: no crash, no context injected", async () => {
  const dir = agentDirWith({
    config: { server: { url: "http://127.0.0.1:1/mcp", token: "dm_test" }, timeoutMs: 1000 },
  });
  const { pi, handlers, sent, makeCtx } = makePi({ tools: [{ name: "remember" }] });
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, makeCtx(dir)); // must not throw

  assert.equal(sent.length, 0, "no context injected from dead server");

  cleanup([dir]);
});

test("session_start injects recall context from live server", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const results = msg.params?.name === "recall_memory"
        ? [{ context: "User prefers pnpm" }, { context: "Project uses SolidJS" }]
        : [];
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify({ results }) }] },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = agentDirWith({
      config: {
        server: { url: `http://127.0.0.1:${server.address().port}/mcp`, token: "dm_test" },
        timeoutMs: 3000,
      },
    });
    const { pi, handlers, sent, makeCtx } = makePi({ tools: [{ name: "remember" }] });
    (await import("../extensions/dense-mem-hooks.ts")).default(pi);
    await handlers.session_start({}, makeCtx(dir));

    assert.equal(sent.length, 1);
    assert.ok(sent[0].content.includes("User prefers pnpm"));
    assert.ok(sent[0].content.includes("Project uses SolidJS"));
    assert.ok(sent[0].content.startsWith("[Memory context from previous sessions:]"));

    cleanup([dir]);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("session_start deduplicates and garbage-filters recall results", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const results = [
        { context: "User prefers pnpm" },
        { context: "User prefers pnpm" }, // exact duplicate
        { context: "this is a test, testing if dense-mem works" }, // garbage
        { context: "Session completed with pi-coding-agent" }, // garbage
      ];
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify({ results }) }] },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = agentDirWith({
      config: {
        server: { url: `http://127.0.0.1:${server.address().port}/mcp`, token: "dm_test" },
        timeoutMs: 3000,
      },
    });
    const { pi, handlers, sent, makeCtx } = makePi({ tools: [{ name: "remember" }] });
    (await import("../extensions/dense-mem-hooks.ts")).default(pi);
    await handlers.session_start({}, makeCtx(dir));

    assert.equal(sent.length, 1);
    assert.ok(sent[0].content.includes("User prefers pnpm"));
    assert.ok(!sent[0].content.includes("this is a test"));
    assert.ok(!sent[0].content.includes("Session completed"));

    cleanup([dir]);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

// ── before_agent_start tests ──

test("before_agent_start injects memory instructions when tools are available", async () => {
  const dir = agentDirWith({ config: {} });
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: dir, stdio: "ignore" });
  // Must have tools registered + session_start called to set toolsAvailable=true
  const { pi, handlers, makeCtx } = makePi({ tools: [{ name: "remember" }] });
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);
  await handlers.session_start({}, makeCtx(dir)); // sets toolsAvailable

  const result = await handlers.before_agent_start(
    { systemPrompt: "BASE PROMPT" },
    makeCtx(dir),
  );

  assert.ok(result.systemPrompt.includes("BASE PROMPT"));
  assert.ok(result.systemPrompt.includes("Memory System Instructions"));
  assert.ok(result.systemPrompt.includes("## Current Repository"));
  assert.ok(result.systemPrompt.includes(dir.split(/[\\/]/).pop()));

  cleanup([dir]);
});

test("before_agent_start skips injection when tools are not available", async () => {
  const dir = agentDirWith({ config: {} });
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: dir, stdio: "ignore" });
  const { pi, handlers, makeCtx } = makePi({ tools: [] });
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);
  await handlers.session_start({}, makeCtx(dir)); // toolsAvailable stays false

  const result = await handlers.before_agent_start(
    { systemPrompt: "BASE PROMPT" },
    makeCtx(dir),
  );

  assert.equal(result, undefined, "no system prompt modification when tools missing");

  cleanup([dir]);
});
