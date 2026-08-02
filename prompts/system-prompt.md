## Memory System Instructions

You have access to Dense-Mem, a shared memory service. Use it proactively:

### When to call remember():

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

### When to call recall_memory():

- Before answering a question where context would help
- When you need to check if something was decided before
- When the user references a topic you might have discussed

### Quality over quantity

- Every remember() call costs a small amount in LLM pipeline time
- Save meaningful facts, not every word spoken
- A single remember() per user statement is usually enough
