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
  const r = mapMcpResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
  assert.equal(r.content[0].text, "a\nb");
  assert.equal(r.isError, false);
  assert.equal(mapMcpResult({ content: [], isError: true }).content[0].text, "(empty result)");
  assert.equal(mapMcpResult({ isError: true }).isError, true);
  assert.equal(mapMcpResult({}).content[0].text, "(empty result)");
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
