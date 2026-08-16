import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { parseToolDefs, mapMcpResult } = await import("../extensions/dense-mem-hooks.ts");

function makePi() {
  const handlers = {};
  const registered = [];
  const sent = [];
  const pi = {
    on: (ev, h) => (handlers[ev] = h),
    registerTool: (def) => registered.push(def),
    sendMessage: (m) => sent.push(m),
  };
  return { pi, handlers, registered, sent };
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

const TOOLS = [
  {
    name: "dense_mem_recall_memory",
    description: "Recall memory\nLonger description here",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  { name: "dense_mem_remember", description: "Remember something", inputSchema: { type: "object" } },
];

function startFakeMcp(tools = TOOLS) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const result =
        msg.method === "tools/list"
          ? { tools }
          : { content: [{ type: "text", text: JSON.stringify({ ok: true, method: msg.params?.name }) }] };
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close"); // don't hold keep-alive sockets open
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function stopFakeMcp(server) {
  server.closeAllConnections?.();
  server.close();
}

test("parseToolDefs extracts name/description/schema and skips nameless", () => {
  const defs = parseToolDefs({ result: { tools: [...TOOLS, { description: "no name" }] } });
  assert.equal(defs.length, 2);
  assert.equal(defs[0].name, "dense_mem_recall_memory");
  assert.equal(defs[0].description, "Recall memory\nLonger description here");
  assert.equal(defs[0].schema.properties.query.type, "string");
  assert.deepEqual(parseToolDefs({}), []);
  assert.deepEqual(parseToolDefs({ result: { tools: [{ name: 123 }] } }), []);
});

test("mapMcpResult: text content joined, isError mapped, empty fallback", () => {
  const r = mapMcpResult({ result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
  assert.equal(r.content[0].text, "a\nb");
  assert.equal(r.isError, false);
  assert.equal(mapMcpResult({ result: { content: [], isError: true } }).content[0].text, "(empty result)");
  assert.equal(mapMcpResult({ result: { isError: true } }).isError, true);
  assert.equal(mapMcpResult({}).content[0].text, "(empty result)");
});

test("mapMcpResult: JSON-RPC error envelope surfaces as a real tool error", () => {
  const r = mapMcpResult({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "relationships is required" } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "dense-mem error -32602: relationships is required");
});

test("session_start injects discovered tools when mcp.json does not manage dense-mem", async () => {
  const server = await startFakeMcp();
  const dir = agentDirWith({
    config: { server: { url: `http://127.0.0.1:${server.address().port}/mcp`, token: "dm_test" }, timeoutMs: 3000 },
  });
  const { pi, handlers, registered, sent } = makePi();
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, { cwd: dir });

  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, "dense_mem_recall_memory");
  assert.equal(registered[0].promptSnippet, "Recall memory");
  assert.equal(registered[1].name, "dense_mem_remember");
  assert.ok(registered[0].parameters, "schema passed through (Unsafe)");

  // executing a registered tool proxies tools/call (ctx.signal supported)
  const out = await registered[0].execute("call-1", { query: "x" }, new AbortController().signal);
  assert.equal(out.content[0].text, JSON.stringify({ ok: true, method: "dense_mem_recall_memory" }));
  assert.equal(out.isError, false);
  assert.equal(sent.length, 0, "recall returned no results — no context message");

  server.close();
  stopFakeMcp(server);
  cleanup([dir]);
});

test("session_start skips injection when mcp.json manages dense-mem", async () => {
  const server = await startFakeMcp();
  const dir = agentDirWith({
    config: { server: { url: `http://127.0.0.1:${server.address().port}/mcp`, token: "dm_test" } },
    mcpJson: { mcpServers: { "dense-mem": { url: "http://x/mcp", bearerToken: "dm_mcp" } } },
  });
  const { pi, handlers, registered } = makePi();
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, { cwd: dir });

  assert.equal(registered.length, 0, "mcp.json owns the tools — no double registration");

  stopFakeMcp(server);
  cleanup([dir]);
});

test("session_start survives a dead server: no tools, no crash", async () => {
  const dir = agentDirWith({
    config: { server: { url: "http://127.0.0.1:1/mcp", token: "dm_test" }, timeoutMs: 1000 },
  });
  const { pi, handlers, registered, sent } = makePi();
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, { cwd: dir }); // must not throw

  assert.equal(registered.length, 0);
  assert.equal(sent.length, 0);
  cleanup([dir]);
});

test("injected tool: server JSON-RPC error surfaces as tool error, not (empty result)", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      const out =
        msg.method === "tools/list"
          ? { result: { tools: TOOLS } }
          : { error: { code: -32602, message: "relationships is required" } };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...out }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = agentDirWith({
    config: { server: { url: `http://127.0.0.1:${server.address().port}/mcp`, token: "dm_test" }, timeoutMs: 3000 },
  });
  const { pi, handlers, registered } = makePi();
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, { cwd: dir });
  const out = await registered[1].execute("call-1", {}, new AbortController().signal); // remember

  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, "dense-mem error -32602: relationships is required");

  stopFakeMcp(server);
  cleanup([dir]);
});

test("remember tool call scopes evidence: [repo] prefix + repo label, idempotent", async () => {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.method === "tools/call" && msg.params?.name === "dense_mem_remember") captured.push(msg.params.arguments);
      const result = msg.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: "{}" }] };
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = agentDirWith({
      config: { server: { url: `http://127.0.0.1:${server.address().port}/mcp`, token: "dm_test" }, timeoutMs: 3000 },
    });
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "dense-mem-hooks.json"), JSON.stringify({ repoName: "MyRepo" })); // repoName is repo-layer only
    const { pi, handlers, registered } = makePi();
    (await import("../extensions/dense-mem-hooks.ts")).default(pi);
    await handlers.session_start({}, { cwd: dir });

    const remember = registered.find((t) => t.name === "dense_mem_remember");
    const rel = {
      ref: "r1",
      subject: { name: "user", entity_kind: "person", span: { evidence_index: 0, start: 0, end: 4 } }, // wrong: content is now "[MyRepo] user prefers pnpm"
      predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 5, end: 30 } }, // wrong + overlong
      object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 0, end: 4 } } }, // wrong
      polarity: "+",
      modality: "statement",
      supports: [{ evidence_index: 0, start: 0, end: 999 }], // out of bounds → clamped
    };
    await remember.execute("c1", { evidence: [{ content: "user prefers pnpm", labels: ["pref"] }], relationships: [rel] }, new AbortController().signal);
    await remember.execute("c2", { evidence: [{ content: "[MyRepo] already anchored", labels: ["repo:MyRepo"] }] }, new AbortController().signal);
    // same content + relationships, different hand-counted spans → must hash to the same idempotency key
    const relRetry = JSON.parse(JSON.stringify(rel));
    relRetry.subject.span = { evidence_index: 0, start: 1, end: 2 };
    relRetry.predicate.span = { evidence_index: 0, start: 3, end: 28 };
    relRetry.object.entity.span = { evidence_index: 0, start: 5, end: 9 };
    await remember.execute("c3", { evidence: [{ content: "user prefers pnpm", labels: ["pref"] }], relationships: [relRetry] }, new AbortController().signal);

    const tagged = "[MyRepo] user prefers pnpm"; // [MyRepo]=0..8, "user"=9..13, "prefers pnpm"=14..26, "pnpm"=22..26
    assert.equal(captured[0].idempotency_key, captured[2].idempotency_key, "identical request after normalization → replay, no double ingest");
    assert.notEqual(captured[1].idempotency_key, captured[0].idempotency_key, "different content → different key");
    for (const c of captured) delete c.idempotency_key;
    assert.deepEqual(captured, [
      {
        evidence: [{ content: tagged, labels: ["pref", "repo:MyRepo"] }],
        relationships: [
          {
            ref: "r1",
            subject: { name: "user", entity_kind: "person", span: { evidence_index: 0, start: 9, end: 13 } },
            predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 14, end: 26 } },
            object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 22, end: 26 } } },
            polarity: "+",
            modality: "statement",
            supports: [{ evidence_index: 0, start: 0, end: 26 }],
          },
        ],
      },
      { evidence: [{ content: "[MyRepo] already anchored", labels: ["repo:MyRepo"] }] }, // untouched: idempotent
      {
        evidence: [{ content: tagged, labels: ["pref", "repo:MyRepo"] }],
        relationships: [
          {
            ref: "r1",
            subject: { name: "user", entity_kind: "person", span: { evidence_index: 0, start: 9, end: 13 } },
            predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 14, end: 26 } },
            object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 22, end: 26 } } },
            polarity: "+",
            modality: "statement",
            supports: [{ evidence_index: 0, start: 0, end: 26 }],
          },
        ],
      },
    ]);

    cleanup([dir]);
  } finally {
    stopFakeMcp(server);
  }
});

test("normalizeSpans: repairs wrong spans, leaves exact/absent surfaces alone, code-point aware", async () => {
  const { normalizeSpans } = await import("../extensions/dense-mem-hooks.ts");
  const evidence = [{ content: "a😀b prefers pnpm" }]; // code points: a=0 😀=1 b=2 ' '=3 ...
  const rels = [
    {
      subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 4, end: 5 } }, // wrong: b is at 2
      predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 0, end: 4 } }, // wrong
      object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 10, end: 13 } } }, // wrong
      supports: [{ evidence_index: 0, start: 0, end: 999 }],
    },
    {
      subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 2, end: 3 } }, // already exact
      predicate: { proposed_key: "likes", surface: "does not appear", span: { evidence_index: 0, start: 2, end: 3 } }, // absent → untouched
      object: { entity: { name: "a", entity_kind: "concept", span: { evidence_index: 0, start: 0, end: 1 } } },
    },
  ];
  normalizeSpans(evidence, rels);
  assert.deepEqual(rels[0], {
    subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 2, end: 3 } },
    predicate: { proposed_key: "prefers", surface: "prefers pnpm", span: { evidence_index: 0, start: 4, end: 16 } }, // "prefers pnpm" starts after "a😀b "
    object: { entity: { name: "pnpm", entity_kind: "product", span: { evidence_index: 0, start: 12, end: 16 } } },
    supports: [{ evidence_index: 0, start: 0, end: 16 }],
  });
  assert.deepEqual(rels[1], {
    subject: { name: "b", entity_kind: "concept", span: { evidence_index: 0, start: 2, end: 3 } },
    predicate: { proposed_key: "likes", surface: "does not appear", span: { evidence_index: 0, start: 2, end: 3 } },
    object: { entity: { name: "a", entity_kind: "concept", span: { evidence_index: 0, start: 0, end: 1 } } },
  });
});

test("session_start survives a dead server: no tools, no crash", async () => {
  const dir = agentDirWith({
    config: { server: { url: "http://127.0.0.1:1/mcp", token: "dm_test" }, timeoutMs: 1000 },
  });
  const { pi, handlers, registered, sent } = makePi();
  (await import("../extensions/dense-mem-hooks.ts")).default(pi);

  await handlers.session_start({}, { cwd: dir }); // must not throw

  assert.equal(registered.length, 0);
  assert.equal(sent.length, 0);
  cleanup([dir]);
});
