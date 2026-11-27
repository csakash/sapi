import type { ProviderManifest } from "../types.ts";

/**
 * Claude subscription through the unmodified `claude` CLI. The host list was measured in Phase 0
 * (docs/phase0-findings.md): with non-essential traffic off the CLI only calls api.anthropic.com;
 * the others are the documented token-refresh and sign-in hosts.
 */
export const claudeManifest: ProviderManifest = {
  id: "claude-sub",
  kind: "subscription-cli",
  displayName: "Claude subscription",
  egressHosts: ["api.anthropic.com", "platform.claude.com", "claude.ai", "claude.com"],
  modelIdPattern: /^claude-[a-z0-9]+(-[a-z0-9]+)*$/,
  supports: { tools: "none", jsonSchema: false, vision: false, params: [] },
  limitModel: "windows",
  bom: { component: "Claude Code CLI (claude)", testedVersions: ">=2.1.332" },
};
