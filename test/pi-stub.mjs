// Test stub for @earendil-works/pi-coding-agent — only the runtime values the
// extension uses. getAgentDir reads an env var so tests can swap agent dirs.
export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir() {
  return process.env.__TEST_AGENT_DIR__ ?? "C:/no-such-agent-dir";
}
