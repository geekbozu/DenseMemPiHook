# DenseMemPiHook

Pi extension that makes Dense-Mem memory automatic across sessions:

- **`session_start`** — recalls context from previous sessions (repo-scoped) and injects it as a message so the agent starts with memory.
- **`before_agent_start`** — appends memory instructions (from `prompts/system-prompt.md`) to the system prompt.

The Dense-Mem MCP tools themselves (`dense_mem_*`) come from your own MCP config — this hook only adds the automatic context + instructions on top.

## What startup looks like

On a new session inside a git repo, two things happen before you type a word:

1. **`before_agent_start`** — the system prompt gains the memory instructions (from `prompts/system-prompt.md`) plus a generated repo block:

   ```
   ## Memory System Instructions

   You have access to Dense-Mem, a shared memory service. Use it proactively:
   ...

   ## Current Repository

   Repository: DenseMemPiHook

   When calling remember(), include the repository name so memories are scoped to this repo.
   When calling recall_memory(), prefix queries with the repository name.
   ```

2. **`session_start`** — the hook runs the recall queries (repo-scoped, e.g. `[DenseMemPiHook] project goals, tasks, and named decisions`), dedupes the results, and injects them as a message so the agent starts with memory:

   ```
   [Memory context from previous sessions:]
   User prefers pnpm over npm for package management
   The project uses SolidJS with Tailwind v4, not React
   ```

   Entries are capped by a char budget (`maxContextChars`, default 4096 ≈ 1k tokens; ~4 chars/token). If the server is down or times out, nothing is injected and no session-start hang — the agent can still recall via the `dense_mem_*` tools.

## Install

```bash
pi install git:github.com/geekbozu/DenseMemPiHook   # or a local path:
pi install /path/to/DenseMemPiHook
```

> **Don't double-load:** if you previously copied the hook into `~/.pi/agent/extensions/`, remove that copy before installing the package, or the context injection and system prompt instructions run twice.

## Config

Per-user config lives in `~/.pi/agent/extensions/dense-mem-hooks.json` (same pattern as `pi-model-sort.json`). All fields optional. A minimal starter with the required `server` block active and every option commented out ships at [`dense-mem-hooks.example.json`](dense-mem-hooks.example.json) — copy it, uncomment what you need. All fields at a glance:

```json
{
  "server": { "url": "https://mem.example.com/mcp", "token": "dm_your-profile-token-here" },
  "timeoutMs": 5000,
  "maxContextChars": 12000,
  "recallLimit": 10,
  "systemPromptFile": "prompts/my-system-prompt.md",
  "queriesFile": "prompts/my-queries.md"
}
```

Copy the example to `~/.pi/agent/extensions/dense-mem-hooks.json` (or `<repo>/.pi/dense-mem-hooks.json` for a repo-scoped override) and edit. **JSONC is supported: `//` line and `/* */` block comments are stripped before parsing (string-aware, so URLs like `https://...` are safe).** Trailing commas are not supported. Relative `systemPromptFile`/`queriesFile` paths resolve against the config file's directory (`~/.pi/agent/extensions/` or `<repo>/.pi/` respectively).

- **`server`** — overrides the dense-mem connection. If absent, the hook reads the `dense-mem` entry from `~/.pi/agent/mcp.json`.
- **`timeoutMs`** — per-recall timeout (default `5000`). The hook never hangs `session_start` when the server is down — it gives up and lets the agent recall via tools.
- **`maxContextChars`** — total char budget for injected memory snippets (default `4096`, ≈1k tokens). A char budget instead of an entry count because snippet length varies wildly (~150–900 chars).
- **`recallLimit`** — per-query recall size before dedupe (default `10`, the server's own default). Raise it if the injected context looks thin; `maxContextChars` still caps the total.
- **`systemPromptFile` / `queriesFile`** — override the shipped prompt files. Relative paths resolve against the config file's directory.

## Repo-level overrides & teams

Drop a `.pi/dense-mem-hooks.json` inside any repo to override the global config for that repo only. Fields merge per-layer (repo wins), and `server` merges field-by-field, so a repo can override just the token:

```jsonc
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

- `prompts/system-prompt.md` — the memory instructions appended to the system prompt. Edit freely. Includes the recall-feedback contract: after every `recall_memory()` call the agent must submit a quality rating via `submit_recall_session_feedback()` (high/medium/low + comment) — that's the only feedback path, since the portals have no rating UI.
- `prompts/queries.md` — recall queries, one per line. `#` comments and blank lines ignored. Queries are repo-scoped at runtime (`[repo-name] query`).

Overwrite per-user via `systemPromptFile` / `queriesFile` in the config — no need to fork the package.

### Repo awareness (non-editable)

When a session runs inside a git repo, the hook detects the repo name and appends a generated, **non-editable** block to the system prompt (`## Current Repository`) instructing the agent to include the repo name in `remember()` calls and prefix `recall_memory()` queries with it. Recall at session start is likewise scoped (`[repo-name] query`). This block is code-generated on purpose so it can't be accidentally edited away — it's what keeps memories from different repos from bleeding together.

### Self-contained tools (no mcp.json needed)

At session start the plugin discovers the server's tools (`tools/list`) and registers them as regular pi tools — no `mcp.json` entry required. This is the fully self-contained path for a user who only runs dense-mem via this plugin:

```json
{ "server": { "url": "http://your-server:8080/mcp", "token": "dm_<profile-token>" } }
```

**To avoid double-registration, the plugin skips injection when `mcp.json` contains a `dense-mem` server entry** — pi's own MCP client owns the tools there. Remove that entry to let the plugin own them:

```bash
# keep tools from the plugin instead of pi's MCP client
# (edit ~/.pi/agent/mcp.json and delete the dense-mem block)
```

Trade-off: pi's MCP client has a richer result surface (streaming, structured details); the plugin's injected tools proxy `tools/call` and return text content — identical for dense-mem's JSON-text results, and it uses the same `timeoutMs`. Discovery happens per session start; a dead server just means no tools (and no hang).

## Development

- `extensions/dense-mem-hooks.ts` — the whole hook, one file.
- The extension loads via jiti, so no build step. Prompt files are re-read on every event, so edits apply without `/reload`.
- Future directions (recency-aware recall, corpus summarizer) live in [`IDEAS.md`](IDEAS.md).
