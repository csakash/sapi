import type { ProviderManifest } from "../types.ts";

/**
 * ChatGPT subscription through Sign in with ChatGPT (plan §10). sapi calls OpenAI's Responses API
 * itself, so these two hosts are the whole egress allowlist for the provider: the API, and the
 * sign-in server for token refresh, revocation and its signing keys. Endpoints were checked
 * against OpenAI's discovery document (docs/providers/chatgpt-sub.md).
 */
export const chatgptManifest: ProviderManifest = {
  id: "chatgpt-sub",
  kind: "subscription-oauth",
  displayName: "ChatGPT subscription",
  egressHosts: ["api.openai.com", "auth.openai.com"],
  // Model IDs go into a JSON body, never argv; the pattern still keeps config text plain.
  modelIdPattern: /^[a-z0-9][a-z0-9.-]{1,63}$/,
  supports: { tools: "none", jsonSchema: false, vision: false, params: [] },
  limitModel: "windows",
  bom: { component: "OpenAI Responses API via Sign in with ChatGPT" },
};

export const API_BASE = "https://api.openai.com/v1";
export const RESPONSES_URL = `${API_BASE}/responses`;
export const MODELS_URL = `${API_BASE}/models`;
export const USAGE_PAGE = "https://chatgpt.com/settings/usage";
