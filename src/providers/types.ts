/**
 * The provider adapter interface (plan §4). Every provider ships a manifest that lists exactly
 * which hosts it may reach; the egress allowlist and the AI-BOM come from manifests, not from
 * hand-written lists (ARI-42 GOV-1, INJ-4).
 */
import type { CanonicalEvent, CanonicalRequest, LimitWindow } from "../canonical.ts";

export type ProviderManifest = {
  id: "claude-sub" | "fake";
  kind: "subscription-cli" | "subscription-oauth" | "api-key" | "local";
  displayName: string;
  /** The only hosts this provider may reach, port 443, through the egress proxy. */
  egressHosts: string[];
  /** Pattern every configured model ID must match (keeps config text from becoming a flag). */
  modelIdPattern: RegExp;
  supports: { tools: "native" | "emulated" | "none"; jsonSchema: boolean; vision: boolean; params: string[] };
  limitModel: "windows" | "spend" | "none";
  /** AI-BOM: what this provider is, for ARI42.md and `sapi doctor`. */
  bom: { component: string; testedVersions?: string };
};

export type Readiness = { ready: true; detail: string } | { ready: false; reason: string; fix: string };

export interface ProviderAdapter {
  readonly manifest: ProviderManifest;
  /** Used by /healthz, `sapi doctor` and before routing. Cached by the adapter. */
  checkReady(): Promise<Readiness>;
  send(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent>;
  /** Latest known usage windows. */
  limits(): LimitWindow[];
  /** Fail fast when a window is known to be exhausted (429 until it resets). */
  assertWindowOpen(now?: number): void;
  close?(): Promise<void>;
}
