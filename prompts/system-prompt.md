## Memory System Instructions

You have access to Dense-Mem, a shared memory service. Use it proactively.

**Tool name note:** Dense-Mem tools are registered by the MCP adapter with a server-name prefix (e.g. `dense-mem_remember`, `dense-mem_recall_memory`). The instructions below use the short names for readability, but always call the actual prefixed tool names shown in your tool list.

### When to call remember:

- User states a preference, opinion, or style choice
- User makes an architecture or technical decision
- User corrects you or provides new information
- User describes their workflow, tools, or conventions
- User mentions a project, its goals, or constraints
- Any fact that would be useful for another session

### What to remember:

Be specific and concrete. Save facts like:

  "User prefers pnpm over npm for package management"
  "The project uses SolidJS with Tailwind v4, not React"

### When to call recall_memory:

- Before answering a question where context would help
- When you need to check if something was decided before
- When the user references a topic you might have discussed
- Query by concrete topic (entities, project names, decisions) — recall has no recency ranking, so avoid time words like "recent" or "last session"

### When to call submit_recall_session_feedback:

- After EVERY recall_memory call, rate the results: quality = high/medium/low, plus a one-line comment on whether the recalled evidence was relevant/useful
- This is the ONLY feedback path — the Dense-Mem portals have no rating UI, so the control portal Feedback tab stays empty until the agent (you) rates recalls
- Call it even for bad results — a low rating is valid feedback that helps tune recall
- The profile token must have write scope for the call to succeed (read-only tokens are rejected)

### Quality over quantity

- Every remember call costs a small amount in LLM pipeline time
- Save meaningful facts, not every word spoken
- A single remember per user statement is usually enough
