# DenseMemPiHook

Pi extension that makes Dense-Mem memory automatic across sessions:

- **`session_start`** — recalls context from previous sessions (repo-scoped) and injects it as a message so the agent starts with memory.
- **`before_agent_start`** — appends memory instructions (from `prompts/system-prompt.md`) to the system prompt.
- **`tool_call`** — normalizes span offsets in `remember`/`correct_relationship` calls so the server accepts them on the first try.

The Dense-Mem MCP tools themselves (`remember`, `recall_memory`, etc.) come from [pi-mcp-adapter](https://github.com/earendil-works/pi-mcp-adapter) via your `mcp.json` config — this hook only adds the automatic context + instructions + span normalization on top.

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

### 1. Configure dense-mem in mcp.json

Add the dense-mem server to `~/.pi/agent/mcp.json` so pi-mcp-adapter exposes the tools:

```json
{
  "mcpServers": {
    "dense-mem": {
      "url": "https://mem.example.com/mcp",
      "auth": "bearer",
      "bearerToken": "dm_your-profile-token-here"
    }
  }
}
```

### 2. Install this extension

```bash
pi install git:github.com/geekbozu/DenseMemPiHook
```

The extension will warn once at session start if it detects the server is configured but the MCP tools aren't available (e.g. pi-mcp-adapter not installed).

> **Don't double-load:** if you previously copied the hook into `~/.pi/agent/extensions/`, remove that copy before installing the package, or the context injection and system prompt instructions run twice.

## Config

All fields are optional. The extension reads its own config for hook-specific settings (recall queries, system prompt, timeouts) from:

- **Global:** `~/.pi/agent/extensions/dense-mem-hooks.json`
- **Repo:** `.pi/dense-mem-hooks.json` (overrides global per-field)

The MCP server connection comes from `mcp.json` (above). The hook config can optionally override it:

```json
{
  "server": { "url": "https://mem.example.com/mcp", "token": "dm_your-profile-token-here" },
  "repoName": "my-repo",
  "timeoutMs": 30000,
  "maxContextChars": 12000,
  "recallLimit": 10,
  "systemPromptFile": "prompts/my-system-prompt.md",
  "queriesFile": "prompts/my-queries.md"
}
```

Copy the example to `~/.pi/agent/extensions/dense-mem-hooks.json` (or `<repo>/.pi/dense-mem-hooks.json` for a repo-scoped override) and edit. **JSONC is supported: `//` line and `/* */` block comments are stripped before parsing (string-aware, so URLs like `https://...` are safe).** Trailing commas are not supported. Relative `systemPromptFile`/`queriesFile` paths resolve against the config file's directory (`~/.pi/agent/extensions/` or `<repo>/.pi/` respectively).

- **`server`** — overrides the dense-mem connection. If absent, the hook reads the `dense-mem` entry from `~/.pi/agent/mcp.json`.
- **`repoName`** — replaces the git-root basename used for memory scoping (`[repo] ` query prefix and the `Repository:` system-prompt block). Set it when the repo's directory name is generic or noisy (e.g. a monorepo checked out as `web`). Repo config only — a global name for every repo makes no sense, so it's ignored there.
- **`timeoutMs`** — per-recall timeout (default `30000`; 30s because recall can exceed 5s on a slow assessor). The hook never hangs `session_start` when the server is down — it gives up and lets the agent recall via tools.
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

## Known quirks

### MCP tool-name prefixing

pi-mcp-adapter registers MCP tools with a `<server-name>_` prefix (e.g. `dense-mem_remember` instead of `remember`). The prefix comes from the `mcpServers` key in your MCP config — rename the key and the tool names change. This extension handles it in two places:

1. **Tool detection** (`DENSE_MEM_TOOL_STEMS`) — matches by suffix (`endsWith("_remember")`) so any prefix works.
2. **System prompt / repo block** — uses unprefixed short names (`remember`, `recall_memory`) with an explicit note telling the LLM to call the actual prefixed tools from its tool list.

If you rename the MCP server key (e.g. `"dense-mem"` → `"dm"`), the extension adapts automatically. The system prompt instructions remain valid because they tell the LLM to use whatever tool names it sees, not hardcoded ones.

**Fragility caveat:** The non-editable repo block and shipped prompts use short names as a readability convention. If a future MCP adapter changes the prefix convention, the prompts still work (the LLM maps names from its tool list), but the `tool_call` hook's suffix matching would need updating if the prefix format changes.

## Editing prompts

The defaults ship as editable markdown in this repo:

- `prompts/system-prompt.md` — the memory instructions appended to the system prompt. Edit freely. Includes the recall-feedback contract: after every `recall_memory` call the agent must submit a quality rating via `submit_recall_session_feedback` (high/medium/low + comment) — that's the only feedback path, since the portals have no rating UI.
- `prompts/queries.md` — recall queries, one per line. `#` comments and blank lines ignored. Queries are repo-scoped at runtime (`[repo-name] query`).

Overwrite per-user via `systemPromptFile` / `queriesFile` in the config — no need to fork the package.

### Repo awareness (non-editable)

When a session runs inside a git repo, the hook detects the repo name and appends a generated, **non-editable** block to the system prompt (`## Current Repository`) instructing the agent to include the repo name in `remember` calls and prefix `recall_memory` queries with it. Recall at session start is likewise scoped (`[repo-name] query`). This block is code-generated on purpose so it can't be accidentally edited away — it's what keeps memories from different repos from bleeding together.

### Span normalization

When the LLM calls `remember` or `correct_relationship`, the `tool_call` hook automatically repairs hand-counted span offsets before submission. The server requires each surface (subject name, predicate surface, object name) to be an exact Unicode code-point slice of the evidence content — LLMs get this wrong ~4 attempts out of 5. The hook recomputes spans from verbatim surfaces (code-point aware via `Array.from`, correct for emoji/CJK) and clamps out-of-bounds supports. This runs transparently — the agent never sees the correction.

## Development

- `extensions/dense-mem-hooks.ts` — the whole hook, one file.
- The extension loads via jiti, so no build step. Prompt files are re-read on every event, so edits apply without `/reload`.
- Future directions (recency-aware recall, corpus summarizer) live in [`IDEAS.md`](IDEAS.md).
