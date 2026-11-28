/**
 * The request pipeline (plan §3, "What happens on one request"):
 *
 *   key → kill switches → rate limit → body → model alias → scope → provider switch →
 *   provider window → budget and concurrency → provider slot → adapter → client format → meter
 *
 * Everything that can refuse a request runs before any provider work starts. Every request that
 * got past authentication is metered, including the ones refused afterwards.
 */
import { assertInScope, authenticate, type Client, modelAllowed, presentedKey } from "./auth.ts";
import { checkBudget, RateLimiter } from "./budgets.ts";
import {
  asGatewayError,
  type CanonicalEvent,
  type CanonicalRequest,
  GatewayError,
  newId,
  type Usage,
} from "./canonical.ts";
import type { Config, ModelTarget, ProviderId } from "./config.ts";
import { type Db, recordEvent } from "./db.ts";
import { SSE_PING } from "./doors/common.ts";
import type { Door, DoorMeta, ParsedRequest } from "./doors/types.ts";
import { InFlightRegistry, matchingSwitch, pausedError, pausedSwitches, type SwitchTarget } from "./killswitch.ts";
import { type RequestRecord, recordLimit, recordRequest } from "./meter.ts";
import { TEMPLATE_VERSION } from "./prompts/transcript-v1.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { log } from "./redact.ts";
import { Scheduler } from "./scheduler.ts";

export type GatewayOptions = {
  db: Db;
  cfg: Config;
  adapters: Map<ProviderId, ProviderAdapter>;
  /** Poll interval for kill switches set from another process (ms). */
  switchPollMs?: number;
};

const PING_EVERY_MS = 15_000;

export class Gateway {
  readonly inflight = new InFlightRegistry();
  private readonly rate = new RateLimiter();
  private readonly schedulers = new Map<string, Scheduler>();
  private switches: SwitchTarget[] = [];
  private poller: ReturnType<typeof setInterval> | null = null;
  private authFailures = { count: 0, lastEventAt: 0 };

  constructor(private readonly o: GatewayOptions) {
    const { cfg } = o;
    for (const [id] of o.adapters) {
      const cap =
        id === "claude-sub" ? cfg.claude.max_concurrency : id === "chatgpt-sub" ? cfg.chatgpt.max_concurrency : 8;
      this.schedulers.set(id, new Scheduler(cap, cfg.clients.max_queue_per_provider));
    }
    this.refreshSwitches();
  }

  get db(): Db {
    return this.o.db;
  }

  adapter(id: ProviderId): ProviderAdapter | undefined {
    return this.o.adapters.get(id);
  }

  startPolling(): void {
    this.poller = setInterval(() => this.refreshSwitches(), this.o.switchPollMs ?? 500);
    this.poller.unref?.();
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.inflight.abortAll(new GatewayError("provider_paused", "sapi is shutting down."));
  }

  /** Re-read the switches and stop any in-flight request they now cover. */
  refreshSwitches(): void {
    this.switches = pausedSwitches(this.o.db);
    const n = this.inflight.enforce(this.switches);
    if (n > 0) log("warn", "kill switch stopped in-flight requests", { stopped: n });
  }

  authenticate(req: Request): Client {
    try {
      return authenticate(this.o.db, presentedKey(req.headers));
    } catch (e) {
      this.noteAuthFailure();
      throw e;
    }
  }

  /** Record auth failures as events, at most one row every 10 s (LOG-2 input; never the key itself). */
  private noteAuthFailure(): void {
    const f = this.authFailures;
    f.count++;
    const now = Date.now();
    if (now - f.lastEventAt >= 10_000) {
      recordEvent(this.o.db, "auth_failed", { count: f.count });
      f.count = 0;
      f.lastEventAt = now;
    }
  }

  /** Resolve a model alias to a pinned provider model (400 for anything not in config). */
  route(alias: string, client: Client): ModelTarget & { alias: string } {
    const entry = Object.hasOwn(this.o.cfg.models, alias) ? this.o.cfg.models[alias] : undefined;
    if (!entry) {
      const shown = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias) ? ` "${alias}"` : "";
      throw new GatewayError(
        "bad_request",
        `Unknown model${shown}. GET /v1/models lists the models this key can use.`,
        { param: "model" },
      );
    }
    if ("provider" in entry) {
      assertInScope(client, alias, entry.provider);
      return { alias, provider: entry.provider, model: entry.model };
    }
    // "auto": the first route that isn't paused, is ready and is under its window threshold.
    if (this.o.cfg.models[alias] && client.scope.models && !client.scope.models.includes(alias)) {
      throw new GatewayError("forbidden", "This key isn't allowed to use that model.");
    }
    for (const target of entry.route) {
      const t = this.o.cfg.models[target];
      if (!t || !("provider" in t)) continue;
      if (!modelAllowed(client, target, t.provider)) continue;
      if (matchingSwitch(this.switches, client.id, t.provider)) continue;
      const adapter = this.o.adapters.get(t.provider);
      if (!adapter) continue;
      if (adapter.limits().some((l) => l.usedPct >= entry.switch_at_window_pct)) continue;
      try {
        adapter.assertWindowOpen();
      } catch {
        continue;
      }
      return { alias: target, provider: t.provider, model: t.model };
    }
    throw new GatewayError("provider_paused", "No provider in this route is available right now.", {
      retryAfterSec: 60,
    });
  }

  models(req: Request): Response {
    const client = this.authenticate(req);
    const data = Object.entries(this.o.cfg.models)
      .filter(([alias, e]) => {
        if ("provider" in e) return modelAllowed(client, alias, e.provider);
        return !client.scope.models || client.scope.models.includes(alias);
      })
      .map(([alias]) => ({ id: alias, object: "model", created: 0, owned_by: "sapi" }));
    return json({ object: "list", data });
  }

  /** First-token and total timeouts for a provider, in seconds. */
  private timeouts(provider: string): { firstToken: number; total: number } {
    const c = provider === "chatgpt-sub" ? this.o.cfg.chatgpt : this.o.cfg.claude;
    return { firstToken: c.first_token_timeout_s, total: c.total_timeout_s };
  }

  /** One request through one door: the same pipeline whatever the API format. */
  async handle(door: Door, req: Request, readBody: () => Promise<unknown>): Promise<Response> {
    const receivedAt = Date.now();
    const t0 = performance.now();
    const id = newId("req");
    const client = this.authenticate(req);
    const meter: RequestRecord = {
      id,
      clientId: client.id,
      receivedAt,
      door: door.name,
      status: "rejected",
      httpStatus: 0,
      headers: req.headers,
    };
    const finishMeter = (patch: Partial<RequestRecord>) => {
      try {
        recordRequest(this.o.db, { ...meter, ...patch, totalMs: Math.round(performance.now() - t0) });
      } catch (e) {
        log("error", "meter write failed", { error: (e as Error).message });
      }
    };

    // 1. Everything that can refuse the request, before any provider work.
    let canonical: CanonicalRequest;
    let adapter: ProviderAdapter;
    let parsed: ParsedRequest;
    try {
      const s = matchingSwitch(this.switches, client.id);
      if (s) throw pausedError(s);
      this.rate.take(client.id, client.budget.rpm ?? this.o.cfg.clients.default_rpm);
      parsed = door.parse(await readBody(), this.o.cfg.strict_params);
      meter.stream = parsed.stream;
      meter.ignoredParams = parsed.ignoredParams;
      const target = this.route(parsed.alias, client);
      Object.assign(meter, { provider: target.provider, modelAlias: target.alias, modelId: target.model });
      const ps = matchingSwitch(this.switches, client.id, target.provider);
      if (ps) throw pausedError(ps);
      const a = this.o.adapters.get(target.provider);
      if (!a) throw new GatewayError("provider_not_ready", "That provider isn't available in this build.");
      adapter = a;
      adapter.assertWindowOpen();
      checkBudget(this.o.db, client, this.inflight.countForClient(client.id), {
        maxConcurrency: this.o.cfg.clients.default_max_concurrency,
      });
      canonical = {
        id,
        clientId: client.id,
        door: door.name,
        alias: target.alias,
        provider: target.provider,
        model: target.model,
        messages: parsed.messages,
        stream: parsed.stream,
        ignoredParams: parsed.ignoredParams,
        ...(parsed.system !== undefined ? { system: parsed.system } : {}),
      };
      meter.templateVersion = TEMPLATE_VERSION;
    } catch (e) {
      const ge = asGatewayError(e);
      finishMeter({ status: "rejected", httpStatus: ge.status, errorKind: ge.kind });
      throw ge;
    }

    // 2. Run it.
    const ac = new AbortController();
    const abort = (reason: GatewayError) => {
      if (!ac.signal.aborted) ac.abort(reason);
    };
    this.inflight.add(id, { clientId: client.id, provider: canonical.provider, abort });
    const onClientGone = () => abort(new GatewayError("client_closed", "The client closed the connection."));
    req.signal.addEventListener("abort", onClientGone, { once: true });

    const limits = this.timeouts(canonical.provider);
    const totalTimer = setTimeout(
      () => abort(new GatewayError("timeout", `No complete answer within ${limits.total} s.`)),
      limits.total * 1000,
    );
    let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
    let release: (() => void) | undefined;
    let queueMs = 0;
    let runStart = 0;
    let ttftMs: number | undefined;
    let usage: Usage | undefined;
    let finish: "stop" | "length" | "tool_calls" = "stop";
    let providerModel = canonical.model;
    let text = "";

    const cleanup = () => {
      clearTimeout(totalTimer);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      release?.();
      release = undefined;
      this.inflight.remove(id);
      req.signal.removeEventListener("abort", onClientGone);
    };
    const meterDone = (err?: GatewayError) => {
      const runMs = runStart ? performance.now() - runStart : 0;
      finishMeter({
        status: err ? (err.kind === "client_closed" ? "aborted" : "error") : "ok",
        httpStatus: err ? err.status : 200,
        ...(err ? { errorKind: err.kind } : {}),
        queueMs: Math.round(queueMs),
        ...(ttftMs !== undefined ? { ttftMs: Math.round(ttftMs) } : {}),
        ...(usage?.apiMs !== undefined ? { overheadMs: Math.max(0, Math.round(runMs - usage.apiMs)) } : {}),
        ...(usage
          ? {
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheWrite,
              reasoningTokens: usage.reasoning,
              ...(usage.apiEquivUsd !== undefined ? { apiEquivUsd: usage.apiEquivUsd } : {}),
            }
          : {}),
      });
    };
    const observe = (ev: CanonicalEvent) => {
      if (ev.type === "start") providerModel = ev.providerModel;
      if (ev.type === "text" && ttftMs === undefined) {
        ttftMs = performance.now() - t0;
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
      }
      if (ev.type === "usage") usage = ev.usage;
      if (ev.type === "done") finish = ev.finish;
      if (ev.type === "limit") {
        try {
          recordLimit(this.o.db, canonical.provider, ev.limit);
        } catch {
          // metrics only
        }
      }
    };

    let iterator: AsyncIterator<CanonicalEvent>;
    const buffered: CanonicalEvent[] = [];
    try {
      const qStart = performance.now();
      release = await this.schedulers.get(canonical.provider)!.acquire(client.id, ac.signal, limits.firstToken * 1000);
      queueMs = performance.now() - qStart;
      runStart = performance.now();
      firstTokenTimer = setTimeout(
        () => abort(new GatewayError("timeout", `No first token within ${limits.firstToken} s.`)),
        limits.firstToken * 1000,
      );
      iterator = adapter.send(canonical, ac.signal)[Symbol.asyncIterator]();
      // Hold the response until the first text (or the end), so early failures such as "not
      // signed in" come back as proper HTTP errors instead of a broken stream.
      while (true) {
        const r = await iterator.next();
        if (r.done) break;
        observe(r.value);
        buffered.push(r.value);
        if (r.value.type === "text" || r.value.type === "done") break;
      }
    } catch (e) {
      const ge = ac.signal.aborted && ac.signal.reason instanceof GatewayError ? ac.signal.reason : asGatewayError(e);
      cleanup();
      meterDone(ge);
      throw ge;
    }

    const meta: DoorMeta = { requestId: id, created: Math.floor(receivedAt / 1000), model: providerModel };
    const headers: Record<string, string> = { "x-sapi-request-id": id };
    if (canonical.ignoredParams.length) headers["x-sapi-ignored-params"] = canonical.ignoredParams.join(",");

    if (!canonical.stream) {
      try {
        for (const ev of buffered) if (ev.type === "text") text += ev.delta;
        while (true) {
          const r = await iterator.next();
          if (r.done) break;
          observe(r.value);
          if (r.value.type === "text") text += r.value.delta;
        }
        if (ac.signal.aborted) throw ac.signal.reason;
      } catch (e) {
        const ge = ac.signal.aborted && ac.signal.reason instanceof GatewayError ? ac.signal.reason : asGatewayError(e);
        cleanup();
        meterDone(ge);
        throw ge;
      }
      cleanup();
      meterDone();
      return json(door.complete({ ...meta, model: providerModel }, text, finish, usage), 200, headers);
    }

    // Streaming.
    const writer = door.stream(meta, parsed);
    let finished = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    const end = (err?: GatewayError) => {
      if (finished) return;
      finished = true;
      if (ping) clearInterval(ping);
      cleanup();
      meterDone(err);
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        ping = setInterval(() => {
          try {
            controller.enqueue(SSE_PING);
          } catch {
            // closed
          }
        }, PING_EVERY_MS);
        for (const ev of buffered) for (const f of writer.frames(ev)) controller.enqueue(f);
      },
      pull: async (controller) => {
        try {
          // Keep reading until there is something to send: Bun doesn't call pull() again after
          // a pull that enqueued nothing (e.g. a usage or limit event).
          while (true) {
            const r = await iterator.next();
            if (r.done) {
              if (ac.signal.aborted) throw ac.signal.reason;
              end();
              controller.close();
              return;
            }
            observe(r.value);
            const frames = writer.frames(r.value);
            for (const f of frames) controller.enqueue(f);
            if (frames.length > 0) return;
          }
        } catch (e) {
          const ge =
            ac.signal.aborted && ac.signal.reason instanceof GatewayError ? ac.signal.reason : asGatewayError(e);
          end(ge);
          try {
            for (const f of writer.error(ge)) controller.enqueue(f);
            controller.close();
          } catch {
            // client already gone
          }
        }
      },
      cancel: () => {
        const reason = new GatewayError("client_closed", "The client closed the connection.");
        abort(reason);
        void iterator.return?.();
        end(reason);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}
