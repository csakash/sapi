/**
 * Kill switches (ARI-42 AUTH-4): global, per provider and per client.
 *
 * State lives in SQLite so `sapi pause` works from another terminal and survives restarts. The
 * gateway checks it before every request and polls it to stop requests already running: flipping
 * a switch aborts matching in-flight requests, which kills their child processes. Enforcement is
 * in code outside the model; nothing the model or a client sends can clear a switch.
 */
import { GatewayError } from "./canonical.ts";
import { type Db, recordEvent } from "./db.ts";

export type SwitchScope = "global" | "provider" | "client";
export type SwitchTarget = { scope: SwitchScope; target: string };

export function setPaused(db: Db, t: SwitchTarget, paused: boolean, actor = "cli"): void {
  const target = t.scope === "global" ? "*" : t.target;
  db.query(
    `INSERT INTO switches (scope, target, paused, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (scope, target) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`,
  ).run(t.scope, target, paused ? 1 : 0, Date.now());
  recordEvent(db, paused ? "kill_switch_on" : "kill_switch_off", { scope: t.scope, target, actor });
}

export function pausedSwitches(db: Db): SwitchTarget[] {
  return (
    db.query("SELECT scope, target FROM switches WHERE paused = 1").all() as Array<{
      scope: SwitchScope;
      target: string;
    }>
  ).map((r) => ({ scope: r.scope, target: r.target }));
}

/** Which switch, if any, stops a request for this client and provider. */
export function matchingSwitch(switches: SwitchTarget[], clientId: string, provider?: string): SwitchTarget | null {
  for (const s of switches) {
    if (s.scope === "global") return s;
    if (s.scope === "client" && s.target === clientId) return s;
    if (s.scope === "provider" && provider !== undefined && s.target === provider) return s;
  }
  return null;
}

export function pausedError(s: SwitchTarget): GatewayError {
  const what =
    s.scope === "global"
      ? "sapi is paused"
      : s.scope === "provider"
        ? `provider ${s.target} is paused`
        : "this client is paused";
  const fix =
    s.scope === "global"
      ? "sapi resume"
      : s.scope === "provider"
        ? `sapi resume --provider ${s.target}`
        : "sapi resume --client <name>";
  return new GatewayError("provider_paused", `Kill switch: ${what}. Resume with: ${fix}`);
}

type InFlight = { clientId: string; provider?: string; abort: (reason: GatewayError) => void };

/** Tracks running requests so a switch can stop them. */
export class InFlightRegistry {
  private readonly items = new Map<string, InFlight>();

  add(id: string, item: InFlight): void {
    this.items.set(id, item);
  }

  setProvider(id: string, provider: string): void {
    const it = this.items.get(id);
    if (it) it.provider = provider;
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  countForClient(clientId: string): number {
    let n = 0;
    for (const it of this.items.values()) if (it.clientId === clientId) n++;
    return n;
  }

  get size(): number {
    return this.items.size;
  }

  /** Abort every in-flight request a switch now covers. Returns how many were stopped. */
  enforce(switches: SwitchTarget[]): number {
    let n = 0;
    for (const [id, it] of this.items) {
      const s = matchingSwitch(switches, it.clientId, it.provider);
      if (s) {
        it.abort(pausedError(s));
        this.items.delete(id);
        n++;
      }
    }
    return n;
  }

  abortAll(reason: GatewayError): void {
    for (const it of this.items.values()) it.abort(reason);
    this.items.clear();
  }
}
