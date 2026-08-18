import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-dense-mem.sh").replace(/\\/g, "/");

test("bootstrap: sources agent keyring + repo .env (repo wins), passes args to pi", (t) => {
  const home = mkdtempSync(join(tmpdir(), "dmhook-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "dmhook-cwd-"));
  const bin = mkdtempSync(join(tmpdir(), "dmhook-bin-"));
  try {
    // Global keyring in $HOME/.pi/agent/.env, repo .env in cwd
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", ".env"), "DENSE_MEM_TOKEN=agent_tok\nTEAM_TOKEN=acme\n");
    writeFileSync(join(cwd, ".env"), "DENSE_MEM_TOKEN=repo_tok\r\n"); // CRLF on purpose
    // Fake pi: dumps the token + args
    const fakePi = join(bin, "fake-pi");
    writeFileSync(fakePi, "#!/usr/bin/env bash\necho \"TOKEN=$DENSE_MEM_TOKEN TEAM=$TEAM_TOKEN ARGS=$*\"\n");
    chmodSync(fakePi, 0o755);

    const r = spawnSync("bash", [SCRIPT, "--version"], {
      cwd,
      env: { ...process.env, HOME: home, PI_BIN: fakePi },
      encoding: "utf-8",
    });
    if (r.error) return t.skip(`bash not available: ${r.error.message}`);

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /TOKEN=repo_tok/, "repo .env wins over agent keyring");
    assert.match(r.stdout, /TEAM=acme/, "agent keyring var (no repo override) still propagates");
    assert.match(r.stdout, /ARGS=--version/, "args pass through to pi");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
