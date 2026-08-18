# DenseMemPiHook

Pi extension that makes Dense-Mem memory automatic across sessions:

- **`session_start`** — recalls context from previous sessions (repo-scoped) and injects it as a message so the agent starts with memory.
- **`before_agent_start`** — appends memory instructions (from `prompts/system-prompt.md`) to the system prompt.
- **`tool_call`** — normalizes span offsets in `remember`/`correct_relationship` calls so the server accepts them on the first try.

[Dense-Mem](https://github.com/markhuangai/dense-mem) is a self-hosted HTTP MCP memory server (Streamable HTTP, contract at `/mcp`; the browser routes are first-party interfaces, not an automation API). It stages exact evidence, derives semantic state through validated server policy, and returns active evidence contexts with graph-shaped Relationship handles. Its tools (`remember`, `recall_memory`, etc.) come from [pi-mcp-adapter](https://github.com/earendil-works/pi-mcp-adapter) via your `mcp.json` config — this hook only adds the automatic context + instructions + span normalization on top.

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

### 1. Configure dense-mem in mcp.json — the only server config

Add the dense-mem server to `~/.pi/agent/mcp.json` so pi-mcp-adapter exposes the tools *and* the hook knows where to recall from:

```json
{
  "mcpServers": {
    "dense-mem": {
      "url": "https://mem.example.com/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "DENSE_MEM_TOKEN"
    }
  }
}
```

### 2. Export the token — one env var for both

`DENSE_MEM_TOKEN` is read by the MCP adapter (`bearerTokenEnv` above) **and** by this hook's session-start recall. It is the API-key credential the server resolves to an immutable actor: team + identity + membership + permanent owner alias. Recall sees team-visible memory; you can only modify evidence and Relationships your own owner alias authored (correcting someone else's Relationship is rejected server-side). There is no project isolation inside a token — repos are kept separate *lexically* by the hook's `[repo]` scoping. For hard project isolation, use a separate credential/team per project and swap the env var.

Pi does **not** load `.env` files — the var must be in the environment of the shell that launches pi. The easy way is the shipped bootstrap script: launch pi through it and your `.env` files are sourced for you:

```bash
./pi-dense-mem.sh            # sources ~/.pi/agent/.env then ./.env, then launches pi
# or: alias pi='./pi-dense-mem.sh'
```

It sources, in order (later wins):

1. `~/.pi/agent/.env` — your global **keyring**: one var per team credential. Working multiple teams? Keep all of them here (`DENSE_MEM_TOKEN`, `DENSE_MEM_ACME_TOKEN`, ...).
2. `./.env` — repo-local overrides, e.g. a `DENSE_MEM_TEAM` selector when you run per-team MCP entries.

Alternatively skip the script and export in your shell profile (`~/.zshrc`, `~/.bashrc`, direnv, or `setx` on Windows):

```bash
export DENSE_MEM_TOKEN=dm_your-profile-token-here
```

If it's missing, the hook warns once at session start and skips recall (the tools still work if the adapter has a token from elsewhere — but keep it in the one place: the env var).

### 3. Install this extension

```bash
pi install git:github.com/geekbozu/DenseMemPiHook
```

The extension will warn once at session start if it detects the server is configured but the MCP tools aren't available (e.g. pi-mcp-adapter not installed).

> **Double-loading is self-resolving:** if the hook is loaded more than once in one pi process (e.g. an installed package *and* a stale manual copy in `~/.pi/agent/extensions/`), the copies register themselves and the winner is picked by **scope, then version, then registration order** — a project/repo-local copy beats a global one (even at a lower version, so a stale global copy never shadows the project's own), then newer wins, then the latest-registered wins. Losing copies no-op and warn once at session start. Still remove stale copies to clear the warning.

## Config

### Server + secret (one place, one var)

| What | Where |
|------|-------|
| URL | `mcp.json` → `mcpServers.dense-mem.url` |
| Token | `DENSE_MEM_TOKEN` env var (referenced from mcp.json via `bearerTokenEnv`) — the credential; resolves team + owner alias |

That's it. No per-hook server overrides, no token files. Change the URL in mcp.json; change the credential to switch team/owner.

### Behavior knobs (optional, pi settings)

Add a `denseMem` key to your pi settings file — global `~/.pi/settings.json`, or project `.pi/settings.json` for per-repo overrides (merged per-field, project wins, same semantics as pi itself):

```json
{
  "denseMem": {
    "repoName": "my-repo",
    "timeoutMs": 30000,
    "maxContextChars": 12000,
    "recallLimit": 10,
    "systemPromptFile": "prompts/my-system-prompt.md",
    "queriesFile": "prompts/my-queries.md"
  }
}
```

- **`repoName`** — replaces the git-root basename used for memory scoping (`[repo] ` query prefix and the `Repository:` system-prompt block). Set it when the repo's directory name is generic or noisy (e.g. a monorepo checked out as `web`). Repo config only — a global name for every repo makes no sense, so it's ignored there.
- **`timeoutMs`** — per-recall timeout (default `30000`; 30s because recall can exceed 5s on a slow assessor). The hook never hangs `session_start` when the server is down — it gives up and lets the agent recall via tools.
- **`maxContextChars`** — total char budget for injected memory snippets (default `4096`, ≈1k tokens). A char budget instead of an entry count because snippet length varies wildly (~150–900 chars).
- **`recallLimit`** — per-query recall size before dedupe (default `10`, within the server's 1–50 range). Raise it if the injected context looks thin; `maxContextChars` still caps the total.
- **`systemPromptFile` / `queriesFile`** — override the shipped prompt files. Relative paths resolve against the config file's directory.

## Known quirks

### MCP tool-name prefixing

pi-mcp-adapter registers MCP tools with a `<server-name>_` prefix (e.g. `dense-mem_remember` instead of `remember`). The prefix comes from the `mcpServers` key in your MCP config — rename the key and the tool names change. This extension handles it in two places:

1. **Tool detection** (`DENSE_MEM_TOOL_STEMS`) — matches by suffix (`endsWith("_remember")`) so any prefix works.
2. **System prompt / repo block** — uses unprefixed short names (`remember`, `recall_memory`) with an explicit note telling the LLM to call the actual prefixed tools from its tool list.

If you rename the MCP server key (e.g. `"dense-mem"` → `"dm"`), the extension adapts automatically. The system prompt instructions remain valid because they tell the LLM to use whatever tool names it sees, not hardcoded ones.

**Fragility caveat:** The non-editable repo block and shipped prompts use short names as a readability convention. If a future MCP adapter changes the prefix convention, the prompts still work (the LLM maps names from its tool list), but the `tool_call` hook's suffix matching would need updating if the prefix format changes.

## Editing prompts

The defaults ship as editable markdown in this repo:

- `prompts/system-prompt.md` — the memory instructions appended to the system prompt. Edit freely. Includes the recall-feedback contract: after every `recall_memory` call the agent must submit a quality rating via `submit_recall_session_feedback` (quality `high`/`medium`/`low` + comment; the tool is registered only when the server has recall feedback enabled — `recall_memory` results point to it via `suggested_actions`). That's the only feedback path, since the portals have no rating UI.
- `prompts/queries.md` — recall queries, one per line. `#` comments and blank lines ignored. Queries are repo-scoped at runtime (`[repo-name] query`).

Overwrite per-user via `systemPromptFile` / `queriesFile` in the config — no need to fork the package.

### Repo awareness (non-editable)

When a session runs inside a git repo, the hook detects the repo name and appends a generated, **non-editable** block to the system prompt (`## Current Repository`) instructing the agent to include the repo name in `remember` calls and prefix `recall_memory` queries with it. Recall at session start is likewise scoped (`[repo-name] query`). This block is code-generated on purpose so it can't be accidentally edited away — it's what keeps memories from different repos from bleeding together.

### Span normalization

When the LLM calls `remember` or `correct_relationship`, the `tool_call` hook automatically repairs hand-counted span offsets before submission. The server requires each surface (subject name, predicate surface, object name) to be an exact Unicode code-point slice of the evidence content — LLMs get this wrong ~4 attempts out of 5. The hook recomputes spans from verbatim surfaces (code-point aware via `Array.from`, correct for emoji/CJK) and clamps out-of-bounds supports. This runs transparently — the agent never sees the correction.

**Version note:** this matches the current span-based `remember` schema (≤ v2.5.0). Since v2.5.1-rc.4, Dense-Mem drops `span`/`surface`/`supports` from `remember` entirely — Relationships reference `evidence_indices` and the assessor locates exact ranges server-side. Against such a server, legacy span fields are *rejected* by closed-schema validation, so this repair needs to become a strip (it only touches fields that no longer exist).

## Development

- `extensions/dense-mem-hooks.ts` — the whole hook, one file.
- The extension loads via jiti, so no build step. Prompt files are re-read on every event, so edits apply without `/reload`.
- Future directions (recency-aware recall, corpus summarizer) live in [`IDEAS.md`](IDEAS.md).
