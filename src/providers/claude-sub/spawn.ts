/**
 * How the Claude child is started: its argv and its environment (ARI-42 GW-1, OUT-1, OUT-4,
 * MCP-1). Both are built from config and constants only. Client text reaches the child through
 * stdin and a system-prompt file, never through argv.
 */
import { GatewayError } from "../../canonical.ts";
import { claudeManifest } from "./manifest.ts";

/** The only environment variables a Claude child (or the bridge in front of it) ever receives. */
export const CHILD_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TZ",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_UPDATES",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

export type ChildEnvInput = {
  binaryDir: string;
  home: string;
  user: string;
  profileDir: string;
  /** Only in auth = "env" mode, read from the user's 0600 claude.env file. */
  oauthToken?: string;
};

/**
 * Build the child's environment from scratch. Nothing is copied from this process's environment,
 * so provider tokens, admin tokens and anything else sapi holds can't leak into the child.
 * Proxy variables are added by the launcher.
 */
export function claudeChildEnv(i: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${i.binaryDir}:/usr/bin:/bin`,
    HOME: i.home,
    // macOS: without USER the CLI can't find its Keychain login (Phase 0 finding).
    USER: i.user,
    LOGNAME: i.user,
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    CLAUDE_CONFIG_DIR: i.profileDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_UPDATES: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (i.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = i.oauthToken;
  return env;
}

export type ArgvInput = { binary: string; modelId: string; systemPromptFile: string };

/**
 * The fixed command line (plan §9). `modelId` comes from config and is re-checked here against
 * the manifest pattern, so even a bad config can't inject a flag.
 */
export function claudeArgv(i: ArgvInput): string[] {
  if (!i.binary.startsWith("/"))
    throw new GatewayError("provider_not_ready", "The claude binary path must be absolute.");
  if (!claudeManifest.modelIdPattern.test(i.modelId)) {
    throw new GatewayError("bad_request", "The configured model ID is not a valid Claude model ID.");
  }
  if (!i.systemPromptFile.startsWith("/")) throw new Error("system prompt file must be an absolute path");
  return [
    i.binary,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    i.modelId,
    "--system-prompt-file",
    i.systemPromptFile,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--max-turns",
    "1",
    "--no-session-persistence",
    "--restricted",
    "--safe-mode",
    "--disable-slash-commands",
  ];
}
