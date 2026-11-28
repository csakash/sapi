/**
 * The ChatGPT subscription adapter (plan §10). It turns an internal request into one stateless
 * Responses API call and the event stream back into internal events.
 *
 *   - Every call is `POST https://api.openai.com/v1/responses` with `store: false` and
 *     `stream: true` (ARI-42 DATA-3); the system prompt goes in `instructions` (OpenAI rejects
 *     system-role items on this route), and nothing else is sent: no temperature, metadata, user
 *     or previous_response_id, and no caller header.
 *   - Only sapi's own body goes upstream: the caller's sapi key and headers never leave sapi, and
 *     the ChatGPT token only ever goes to api.openai.com (AUTH-2, GW-1).
 *   - A call counts only after `response.completed`; a stream that ends without it is an error.
 *   - On a 429 usage limit sapi pauses ChatGPT for a while instead of guessing a reset time.
 *
 * Every upstream event is parsed with Zod and unknown events are dropped (OUT-1). Error messages
 * are fixed strings; OpenAI's own text is never passed through.
 */
import { z } from "zod";
import type { CanonicalEvent, CanonicalRequest, LimitWindow, Usage } from "../../canonical.ts";
import { GatewayError } from "../../canonical.ts";
import type { EgressFetch } from "../../egress-fetch.ts";
import { VERSION } from "../../version.ts";
import type { ProviderAdapter, Readiness } from "../types.ts";
import { chatgptManifest, MODELS_URL, RESPONSES_URL, USAGE_PAGE } from "./manifest.ts";
import type { ChatGptAuth } from "./session.ts";
import { sessionState } from "./session.ts";
import { readSse } from "./sse.ts";

export type ChatGptAdapterOptions = {
  auth: ChatGptAuth;
  fetch: EgressFetch;
  now?: () => number;
  /** How long to pause after a usage-limit answer (default 15 minutes). */
  usagePauseMs?: number;
  /** Waits before retrying a 503 that came before any output (default 1 s, then 3 s). */
  retryDelaysMs?: number[];
  onEvent?: (kind: string, detail: Record<string, unknown>) => void;
};

/** The exact body sent upstream. Exported so tests can pin it down. */
export function responsesBody(req: CanonicalRequest): Record<string, unknown> {
  if (!chatgptManifest.modelIdPattern.test(req.model))
    throw new GatewayError("bad_request", "The configured ChatGPT model ID isn't valid.");
  return {
    model: req.model,
    ...(req.system ? { instructions: req.system } : {}),
    input: req.messages.map((m) => ({ type: "message", role: m.role, content: m.text })),
    store: false,
    stream: true,
  };
}

const UsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.looseObject({ cached_tokens: z.number().int().nonnegative().optional() }).nullish(),
  output_tokens_details: z.looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() }).nullish(),
});
const ErrorObj = z.looseObject({ code: z.string().nullish(), param: z.string().nullish() }).nullish();

const StreamEvent = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("response.output_text.delta"), delta: z.string() }),
  z.looseObject({
    type: z.literal("response.completed"),
    response: z.looseObject({ model: z.string().optional(), usage: UsageSchema.nullish() }),
  }),
  z.looseObject({
    type: z.literal("response.incomplete"),
    response: z.looseObject({
      usage: UsageSchema.nullish(),
      incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish(),
    }),
  }),
  z.looseObject({ type: z.literal("response.failed"), response: z.looseObject({ error: ErrorObj }) }),
  z.looseObject({ type: z.literal("error"), code: z.string().nullish() }),
]);

function toUsage(u: z.infer<typeof UsageSchema> | null | undefined): Usage | undefined {
  if (!u) return undefined;
  const cached = Math.min(u.input_tokens_details?.cached_tokens ?? 0, u.input_tokens);
  return {
    input: u.input_tokens - cached,
    output: u.output_tokens,
    cacheRead: cached,
    cacheWrite: 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

const cleanCode = (s: string | null | undefined) => (s && /^[a-z0-9_.-]{1,80}$/i.test(s) ? s : "");
const cleanParam = (s: string | null | undefined) => (s && /^[A-Za-z0-9_.[\]-]{1,64}$/.test(s) ? s : undefined);

const ErrorBody = z.looseObject({ error: ErrorObj, detail: z.unknown().optional() });

type Mapped = { error: GatewayError; retry?: boolean; reauth?: boolean; pause?: boolean };

/** Map an HTTP error from the Responses API to a sapi error. Never passes OpenAI's text through. */
export function mapHttpError(status: number, body: unknown, retryAfter: string | null): Mapped {
  const b = ErrorBody.safeParse(body);
  const code = cleanCode(b.success ? b.data.error?.code : undefined);
  const param = cleanParam(b.success ? b.data.error?.param : undefined);
  const after = Math.min(3600, Math.max(1, Number(retryAfter) || 30));
  if (code === "subscription_sharing_usage_limit_exceeded") return { error: usageLimit(), pause: true };
  if (status === 401 || code === "subscription_sharing_invalid_user")
    return {
      error: new GatewayError(
        "provider_not_ready",
        "ChatGPT didn't accept sapi's sign-in. Sign in again with: sapi login chatgpt",
      ),
      reauth: true,
    };
  if (code === "subscription_sharing_user_not_eligible")
    return {
      error: new GatewayError(
        "provider_not_ready",
        "This ChatGPT account isn't eligible to use its plan in other apps. Check the plan, or sign in with another account: sapi login chatgpt",
      ),
    };
  if (code.startsWith("chatpass_v2_"))
    return {
      error: new GatewayError(
        "provider_not_ready",
        "The ChatGPT sign-in doesn't allow plan usage. Sign in again and allow it: sapi login chatgpt",
      ),
    };
  if (code === "subscription_sharing_unsupported_capability" || status === 400 || status === 404 || status === 422)
    return {
      error: new GatewayError(
        "bad_request",
        "ChatGPT refused this request. Check that the model in [models] is one your plan offers (sapi login chatgpt lists them).",
        param ? { param } : {},
      ),
    };
  if (status === 403)
    return { error: new GatewayError("upstream_error", "ChatGPT refused the request (a policy or permission check).") };
  if (status === 429)
    return {
      error: new GatewayError("provider_window_exhausted", "ChatGPT is rate limiting sapi. Try again shortly.", {
        retryAfterSec: after,
      }),
    };
  if (status === 503)
    return {
      error: new GatewayError("provider_not_ready", "ChatGPT is temporarily unavailable. Try again shortly.", {
        retryAfterSec: after,
      }),
      retry: true,
    };
  return { error: new GatewayError("upstream_error", `ChatGPT returned an error (HTTP ${status}).`) };
}

function usageLimit(retryAfterSec?: number): GatewayError {
  return new GatewayError(
    "provider_window_exhausted",
    `Your ChatGPT plan's usage limit is reached; sapi has paused ChatGPT requests for now. See ${USAGE_PAGE}`,
    retryAfterSec ? { retryAfterSec } : {},
  );
}

export type PlanModel = { slug: string; name: string };

/** GET /v1/models with the sign-in's token: the models the plan offers (visibility "list"). */
export async function planModels(f: EgressFetch, token: string): Promise<PlanModel[]> {
  const res = await f(MODELS_URL, { headers: { authorization: `Bearer ${token}`, "user-agent": `sapi/${VERSION}` } });
  if (!res.ok) throw mapHttpError(res.status, await res.json().catch(() => null), null).error;
  const M = z.looseObject({
    models: z.array(
      z.looseObject({ slug: z.string(), display_name: z.string().optional(), visibility: z.string().optional() }),
    ),
  });
  const r = M.safeParse(await res.json().catch(() => null));
  if (!r.success) return [];
  return r.data.models
    .filter((m) => m.visibility === "list" && chatgptManifest.modelIdPattern.test(m.slug))
    .map((m) => ({ slug: m.slug, name: (m.display_name ?? m.slug).replace(/[^\x20-\x7e]/g, "").slice(0, 80) }));
}

export class ChatGptAdapter implements ProviderAdapter {
  readonly manifest = chatgptManifest;
  private pausedUntil = 0;

  constructor(private readonly o: ChatGptAdapterOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async checkReady(): Promise<Readiness> {
    try {
      const st = sessionState(await this.o.auth.load(), this.now());
      if (!st.ok) return { ready: false, reason: st.reason, fix: st.fix };
      return { ready: true, detail: `signed in; sign-in renews within ${st.refreshTokenDaysLeft} days of last use` };
    } catch (e) {
      return { ready: false, reason: (e as Error).message, fix: "sapi doctor" };
    }
  }

  limits(): LimitWindow[] {
    // The API reports no usage windows; all sapi knows is whether it hit the limit.
    return this.pausedUntil > this.now() ? [{ window: "5h", usedPct: 100, source: "estimated" }] : [];
  }

  assertWindowOpen(now = this.now()): void {
    if (this.pausedUntil > now) throw usageLimit((this.pausedUntil - now) / 1000);
  }

  private pause(): void {
    this.pausedUntil = this.now() + (this.o.usagePauseMs ?? 15 * 60_000);
    this.o.onEvent?.("chatgpt_usage_limit", { paused_s: Math.round((this.o.usagePauseMs ?? 15 * 60_000) / 1000) });
  }

  /** The models this sign-in may use, as OpenAI lists them. */
  async listModels(): Promise<PlanModel[]> {
    return planModels(this.o.fetch, await this.o.auth.accessToken());
  }

  private async open(req: CanonicalRequest, signal: AbortSignal): Promise<Response> {
    const body = JSON.stringify(responsesBody(req));
    const delays = this.o.retryDelaysMs ?? [1000, 3000];
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.o.auth.accessToken(reauthed);
      let res: Response;
      try {
        res = await this.o.fetch(RESPONSES_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            "user-agent": `sapi/${VERSION}`,
          },
          body,
          signal,
          timeoutMs: 600_000,
        });
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        if (e instanceof GatewayError) throw e;
        throw new GatewayError("upstream_error", "sapi couldn't reach ChatGPT.");
      }
      if (res.ok) return res;
      const m = mapHttpError(res.status, await res.json().catch(() => null), res.headers.get("retry-after"));
      if (m.pause) this.pause();
      if (m.reauth && !reauthed) {
        reauthed = true;
        continue;
      }
      if (m.retry && attempt < delays.length) {
        await Bun.sleep(delays[attempt]!);
        if (signal.aborted) throw signal.reason;
        continue;
      }
      throw m.error;
    }
  }

  async *send(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    this.assertWindowOpen();
    const res = await this.open(req, signal);
    if (!res.body) throw new GatewayError("upstream_error", "ChatGPT sent an empty answer.");
    yield { type: "start", providerModel: req.model };
    let finished = false;
    for await (const msg of readSse(res.body)) {
      if (msg.data === "[DONE]") break;
      let raw: unknown;
      try {
        raw = JSON.parse(msg.data);
      } catch {
        continue;
      }
      const ev = StreamEvent.safeParse(raw);
      if (!ev.success) continue; // created, in_progress, output_item.*, reasoning…: not needed
      const e = ev.data;
      if (e.type === "response.output_text.delta") {
        if (e.delta) yield { type: "text", delta: e.delta };
      } else if (e.type === "response.completed") {
        const u = toUsage(e.response.usage);
        if (u) yield { type: "usage", usage: u };
        yield { type: "done", finish: "stop" };
        finished = true;
        break;
      } else if (e.type === "response.incomplete") {
        const u = toUsage(e.response.usage);
        if (u) yield { type: "usage", usage: u };
        yield { type: "done", finish: "length" };
        finished = true;
        break;
      } else {
        const code = cleanCode(e.type === "error" ? e.code : e.response.error?.code);
        if (code === "subscription_sharing_usage_limit_exceeded") {
          this.pause();
          throw usageLimit();
        }
        throw new GatewayError(
          "upstream_error",
          code === "subscription_sharing_usage_unavailable"
            ? "ChatGPT usage is temporarily unavailable. Try again shortly."
            : "ChatGPT failed the response.",
        );
      }
    }
    if (!finished) throw new GatewayError("upstream_error", "The ChatGPT stream ended before the response completed.");
  }
}
