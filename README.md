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

## Editing prompts

The defaults ship as editable markdown in this repo:

- `prompts/system-prompt.md` — the memory instructions appended to the system prompt. Edit freely.
- `prompts/queries.md` — recall queries, one per line. `#` comments and blank lines ignored. Queries are repo-scoped at runtime (`[repo-name] query`).

Overwrite per-user via `systemPromptFile` / `queriesFile` in the config — no need to fork the package.

## Development

- `extensions/dense-mem-hooks.ts` — the whole hook, one file.
- The extension loads via jiti, so no build step. Prompt files are re-read on every event, so edits apply without `/reload`.
