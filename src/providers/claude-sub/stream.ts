/**
 * Parser for `claude -p --output-format stream-json` (ARI-42 OUT-1, GOV-4, MCP-1).
 *
 * Every line is untrusted provider output and is parsed with a Zod schema; lines of unknown
 * shape are counted and dropped. The init event is a safety check: if the child reports any tool
 * or MCP server, the request is stopped (the CLI's own output-only StructuredOutput tool is
 * allowed only when JSON-schema output was asked for).
 */
import { z } from "zod";
import { type CanonicalEvent, type FinishReason, GatewayError, type LimitWindow } from "../../canonical.ts";

const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.unknown()),
  model: z.string().max(200),
  claude_code_version: z.string().max(50).optional(),
});

const StreamEvent = z.looseObject({
  type: z.literal("stream_event"),
  event: z.looseObject({
    type: z.string(),
    delta: z
      .looseObject({ type: z.string().optional(), text: z.string().optional(), stop_reason: z.string().nullish() })
      .optional(),
  }),
});

const Window = z.looseObject({
  utilization: z.number().min(0).max(10),
  resetsAt: z.number().optional(),
  status: z.string().optional(),
});

const RateLimit = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string().optional(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    unifiedWindows: z.record(z.string().max(64), Window).optional(),
  }),
});

const Assistant = z.looseObject({ type: z.literal("assistant"), error: z.string().max(100).optional() });

const Usage = z.looseObject({
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  cache_read_input_tokens: z.number().int().min(0).default(0),
  cache_creation_input_tokens: z.number().int().min(0).default(0),
  output_tokens_details: z.looseObject({ thinking_tokens: z.number().int().min(0).optional() }).nullish(),
});

const Result = z.looseObject({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string().optional(),
  stop_reason: z.string().nullish(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  total_cost_usd: z.number().min(0).optional(),
  usage: Usage.optional(),
  api_error_status: z.number().nullish(),
});

/** Raised when the CLI says it isn't signed in; the adapter may retry once (Phase 0 finding). */
export class NotSignedInError extends GatewayError {
  constructor() {
    super("provider_not_ready", "Claude isn't signed in for sapi. Run: sapi login claude");
  }
}

const WINDOW_NAMES: Record<string, string> = { five_hour: "5h", seven_day: "weekly" };

export function windowName(key: string): string {
  if (WINDOW_NAMES[key]) return WINDOW_NAMES[key]!;
  return key
    .replace(/^seven_day_/, "weekly_")
    .replace(/^five_hour_/, "5h_")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 32);
}

export type ParserStats = { lines: number; dropped: number; apiMs?: number; durationMs?: number };

export class ClaudeStreamParser {
  private sawInit = false;
  private sawResult = false;
  private textSeen = false;
  private errorTag: string | undefined;
  private finish: FinishReason = "stop";
  /** Set when a rejected window was reported: the time it resets, in ms. */
  exhaustedUntil: number | undefined;
  readonly stats: ParserStats = { lines: 0, dropped: 0 };

  constructor(private readonly opts: { allowStructuredOutput: boolean }) {}

  get done(): boolean {
    return this.sawResult;
  }

  /** Parse one line. Throws GatewayError for an unsafe child or an error result. */
  feed(line: string): CanonicalEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    this.stats.lines++;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.stats.dropped++;
      return [];
    }
    const type = (raw as { type?: unknown })?.type;
    switch (type) {
      case "system":
        return this.onSystem(raw);
      case "stream_event":
        return this.onStreamEvent(raw);
      case "rate_limit_event":
        return this.onRateLimit(raw);
      case "assistant": {
        const a = Assistant.safeParse(raw);
        if (a.success && a.data.error) this.errorTag = a.data.error;
        return [];
      }
      case "result":
        return this.onResult(raw);
      default:
        this.stats.dropped++;
        return [];
    }
  }

  /** Call after the process exits. */
  end(exitCode: number | null): void {
    if (!this.sawInit && !this.sawResult) {
      throw new GatewayError(
        "upstream_error",
        `The claude process exited (code ${exitCode ?? "signal"}) without output.`,
      );
    }
    if (!this.sawResult)
      throw new GatewayError(
        "upstream_error",
        `The claude process exited (code ${exitCode ?? "signal"}) before finishing.`,
      );
  }

  private onSystem(raw: unknown): CanonicalEvent[] {
    if ((raw as { subtype?: unknown }).subtype !== "init") return [];
    const r = Init.safeParse(raw);
    if (!r.success)
      throw new GatewayError("upstream_error", "The claude process sent an init event sapi doesn't understand.");
    const allowed = this.opts.allowStructuredOutput ? ["StructuredOutput"] : [];
    const extraTools = r.data.tools.filter((t) => !allowed.includes(t));
    if (extraTools.length > 0 || r.data.mcp_servers.length > 0) {
      throw new GatewayError("upstream_error", "The claude process reported tools or MCP servers, so sapi stopped it.");
    }
    this.sawInit = true;
    return [{ type: "start", providerModel: r.data.model }];
  }

  private onStreamEvent(raw: unknown): CanonicalEvent[] {
    if (!this.sawInit)
      throw new GatewayError("upstream_error", "The claude process sent output before its init event.");
    const r = StreamEvent.safeParse(raw);
    if (!r.success) {
      this.stats.dropped++;
      return [];
    }
    const ev = r.data.event;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      if (ev.delta.text.length === 0) return [];
      this.textSeen = true;
      return [{ type: "text", delta: ev.delta.text }];
    }
    if (ev.type === "message_delta" && ev.delta?.stop_reason === "max_tokens") this.finish = "length";
    return [];
  }

  private onRateLimit(raw: unknown): CanonicalEvent[] {
    const r = RateLimit.safeParse(raw);
    if (!r.success) {
      this.stats.dropped++;
      return [];
    }
    const info = r.data.rate_limit_info;
    const out: CanonicalEvent[] = [];
    for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
      const limit: LimitWindow = {
        window: windowName(key),
        usedPct: Math.round(w.utilization * 1000) / 10,
        source: "reported",
      };
      if (w.resetsAt) limit.resetsAt = new Date(w.resetsAt * 1000).toISOString();
      out.push({ type: "limit", limit });
      if (w.status === "rejected" && w.resetsAt)
        this.exhaustedUntil = Math.max(this.exhaustedUntil ?? 0, w.resetsAt * 1000);
    }
    if (info.status === "rejected" && info.resetsAt)
      this.exhaustedUntil = Math.max(this.exhaustedUntil ?? 0, info.resetsAt * 1000);
    return out;
  }

  private onResult(raw: unknown): CanonicalEvent[] {
    const r = Result.safeParse(raw);
    if (!r.success)
      throw new GatewayError("upstream_error", "The claude process sent a result sapi doesn't understand.");
    this.sawResult = true;
    const res = r.data;
    this.stats.apiMs = res.duration_api_ms;
    this.stats.durationMs = res.duration_ms;
    if (res.is_error) throw this.classifyError(res.result ?? "", res.api_error_status ?? null);
    const out: CanonicalEvent[] = [];
    // Without partial messages the text only arrives in the result.
    if (!this.textSeen && res.result) out.push({ type: "text", delta: res.result });
    const u = res.usage;
    out.push({
      type: "usage",
      usage: {
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
        reasoning: u?.output_tokens_details?.thinking_tokens ?? 0,
        ...(res.total_cost_usd !== undefined ? { apiEquivUsd: res.total_cost_usd } : {}),
        ...(res.duration_api_ms !== undefined ? { apiMs: res.duration_api_ms } : {}),
      },
    });
    if (res.stop_reason === "max_tokens") this.finish = "length";
    out.push({ type: "done", finish: this.finish });
    return out;
  }

  private classifyError(text: string, apiStatus: number | null): GatewayError {
    const tag = this.errorTag;
    if (tag === "authentication_failed" || /^not logged in/i.test(text)) return new NotSignedInError();
    if (tag === "model_not_found" || apiStatus === 404) {
      return new GatewayError(
        "upstream_error",
        "The configured model ID isn't available to this Claude account. Check [models] in sapi's config.",
      );
    }
    if (tag === "rate_limit" || apiStatus === 429 || this.exhaustedUntil) {
      const retry = this.exhaustedUntil ? (this.exhaustedUntil - Date.now()) / 1000 : 60;
      return new GatewayError("provider_window_exhausted", "The Claude subscription's usage limit is reached.", {
        retryAfterSec: Math.max(1, retry),
      });
    }
    if (apiStatus !== null && apiStatus >= 500)
      return new GatewayError("upstream_error", "Anthropic's API returned a server error.");
    return new GatewayError("upstream_error", "The claude process reported an error.");
  }
}
