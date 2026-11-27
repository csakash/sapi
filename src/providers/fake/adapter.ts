/**
 * A deterministic local provider for tests and the install e2e (plan §17). It makes no network
 * calls and runs no processes. Behaviour comes from the model ID:
 *
 *   fake-echo-1   replies "echo: <last user message>" in a few chunks
 *   fake-slow-1   streams 100 chunks, 50 ms apart (kill-switch and disconnect tests)
 *   fake-error-1  fails with an upstream error after starting
 */
import type { CanonicalEvent, CanonicalRequest, LimitWindow } from "../../canonical.ts";
import { GatewayError } from "../../canonical.ts";
import type { ProviderAdapter, ProviderManifest, Readiness } from "../types.ts";

export const fakeManifest: ProviderManifest = {
  id: "fake",
  kind: "local",
  displayName: "Fake provider (tests)",
  egressHosts: [],
  modelIdPattern: /^fake-[a-z0-9-]+$/,
  supports: { tools: "none", jsonSchema: false, vision: false, params: [] },
  limitModel: "none",
  bom: { component: "built-in fake provider" },
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal.aborted) return rej(signal.reason);
    const t = setTimeout(res, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(signal.reason);
      },
      { once: true },
    );
  });

export class FakeAdapter implements ProviderAdapter {
  readonly manifest = fakeManifest;
  /** Every request this adapter received, for tests that check what reached the provider. */
  readonly received: CanonicalRequest[] = [];
  active = 0;

  async checkReady(): Promise<Readiness> {
    return { ready: true, detail: "fake provider" };
  }

  limits(): LimitWindow[] {
    return [];
  }

  assertWindowOpen(): void {}

  async *send(req: CanonicalRequest, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    this.received.push(structuredClone(req));
    this.active++;
    try {
      yield { type: "start", providerModel: req.model };
      const last = req.messages[req.messages.length - 1]?.text ?? "";
      if (req.model === "fake-error-1")
        throw new GatewayError("upstream_error", "The fake provider failed on purpose.");
      if (req.model === "fake-slow-1") {
        for (let i = 0; i < 100; i++) {
          await sleep(50, signal);
          yield { type: "text", delta: `${i} ` };
        }
      } else {
        const text = `echo: ${last}`;
        for (let i = 0; i < text.length; i += 8) {
          await sleep(1, signal);
          yield { type: "text", delta: text.slice(i, i + 8) };
        }
      }
      const input = Math.ceil(req.messages.reduce((n, m) => n + m.text.length, 0) / 4);
      yield { type: "usage", usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, apiEquivUsd: 0 } };
      yield { type: "done", finish: "stop" };
    } finally {
      this.active--;
    }
  }
}
