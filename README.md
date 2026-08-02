# DenseMemPiHook

Pi extension that makes Dense-Mem memory automatic across sessions:

- **`session_start`** — recalls context from previous sessions (repo-scoped) and injects it as a message so the agent starts with memory.
- **`before_agent_start`** — appends memory instructions (from `prompts/system-prompt.md`) to the system prompt.

The Dense-Mem MCP tools themselves (`dense_mem_*`) come from your own MCP config — this hook only adds the automatic context + instructions on top.

## Install

```bash
pi install git:github.com/geekbozu/DenseMemPiHook   # or a local path:
pi install /path/to/DenseMemPiHook
```

> **Don't double-load:** if you previously copied the hook into `~/.pi/agent/extensions/`, remove that copy before installing the package, or the context injection and system prompt instructions run twice.

## Config

Per-user config lives in `~/.pi/agent/extensions/dense-mem-hooks.json` (same pattern as `pi-model-sort.json`). All fields optional:

```json
{
  "server": { "url": "http://your-server:8080/mcp", "token": "dm_<your-profile-token>" },
  "timeoutMs": 5000,
  "maxContextEntries": 8,
  "systemPromptFile": "/abs/path/to/custom-system-prompt.md",
  "queriesFile": "/abs/path/to/custom-queries.md"
}
```

- **`server`** — overrides the dense-mem connection. If absent, the hook reads the `dense-mem` entry from `~/.pi/agent/mcp.json`.
- **`timeoutMs`** — per-recall timeout (default `5000`). The hook never hangs `session_start` when the server is down — it gives up and lets the agent recall via tools.
- **`maxContextEntries`** — how many memory snippets get injected (default `8`).
- **`systemPromptFile` / `queriesFile`** — override the shipped prompt files. Relative paths resolve against the config file's directory.

## Repo-level overrides & teams

Drop a `.pi/dense-mem-hooks.json` inside any repo to override the global config for that repo only. Fields merge per-layer (repo wins), and `server` merges field-by-field, so a repo can override just the token:

```json
// <repo>/.pi/dense-mem-hooks.json
{
  "server": { "token": "dm_other-team-profile-token" },
  "queriesFile": "prompts/queries.md",
  "systemPromptFile": "prompts/team-prompt.md"
}
```

Effective resolution per field: repo `.pi/dense-mem-hooks.json` > global `~/.pi/agent/extensions/dense-mem-hooks.json` > `mcp.json` (server only). Relative prompt paths resolve against the config file they came from (`<repo>/.pi/` for repo configs), so prompt overrides can live inside the repo and be shared.

**Teams:** Dense-Mem scopes memory to the team carried by the profile token. One team today = one global token. When you add teams, each repo gets its own token via `server.token` above — the same hook, no code changes. `server.url` only needs overriding when teams run on different servers.

> **Secret hygiene:** `server.token` is a credential. If a repo config needs a token, gitignore it (`.pi/dense-mem-hooks.json` in that repo's `.gitignore`) or commit only prompt/query overrides and keep tokens in the global config.

## Editing prompts

The defaults ship as editable markdown in this repo:

- `prompts/system-prompt.md` — the memory instructions appended to the system prompt. Edit freely.
- `prompts/queries.md` — recall queries, one per line. `#` comments and blank lines ignored. Queries are repo-scoped at runtime (`[repo-name] query`).

Overwrite per-user via `systemPromptFile` / `queriesFile` in the config — no need to fork the package.

### Repo awareness (non-editable)

When a session runs inside a git repo, the hook detects the repo name and appends a generated, **non-editable** block to the system prompt (`## Current Repository`) instructing the agent to include the repo name in `remember()` calls and prefix `recall_memory()` queries with it. Recall at session start is likewise scoped (`[repo-name] query`). This block is code-generated on purpose so it can't be accidentally edited away — it's what keeps memories from different repos from bleeding together.

## Development

- `extensions/dense-mem-hooks.ts` — the whole hook, one file.
- The extension loads via jiti, so no build step. Prompt files are re-read on every event, so edits apply without `/reload`.
