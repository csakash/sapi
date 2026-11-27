/**
 * Provider slots with fair round-robin across clients (plan §9: 3 Claude children by default).
 *
 * Each client has its own FIFO queue. When a slot frees up, the next client in rotation that has
 * a waiting request gets it, so one busy client can't starve the others.
 */
import { GatewayError } from "./canonical.ts";

type Waiter = { resolve: (release: () => void) => void; reject: (e: unknown) => void; cleanup: () => void };

export class Scheduler {
  private running = 0;
  private readonly queues = new Map<string, Waiter[]>();
  private readonly rotation: string[] = [];
  private queued = 0;

  constructor(
    readonly capacity: number,
    private readonly maxQueue: number,
  ) {}

  get stats(): { running: number; queued: number } {
    return { running: this.running, queued: this.queued };
  }

  /**
   * Wait for a slot. Rejects with 504 after `timeoutMs`, with the signal's reason when aborted,
   * and with 429 when the queue is full.
   */
  acquire(clientId: string, signal: AbortSignal, timeoutMs: number): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.running < this.capacity && this.queued === 0) {
      this.running++;
      return Promise.resolve(this.releaser());
    }
    if (this.queued >= this.maxQueue) {
      return Promise.reject(
        new GatewayError("rate_limited", "The provider queue is full. Retry shortly.", { retryAfterSec: 5 }),
      );
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(clientId, waiter);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        this.removeWaiter(clientId, waiter);
        reject(new GatewayError("timeout", "Timed out waiting for a free provider slot."));
      }, timeoutMs);
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let q = this.queues.get(clientId);
      if (!q) {
        q = [];
        this.queues.set(clientId, q);
        this.rotation.push(clientId);
      }
      q.push(waiter);
      this.queued++;
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running--;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.running < this.capacity && this.rotation.length > 0) {
      const clientId = this.rotation.shift()!;
      const q = this.queues.get(clientId)!;
      const w = q.shift()!;
      this.queued--;
      if (q.length > 0) this.rotation.push(clientId);
      else this.queues.delete(clientId);
      w.cleanup();
      this.running++;
      w.resolve(this.releaser());
    }
  }

  private removeWaiter(clientId: string, w: Waiter): void {
    w.cleanup();
    const q = this.queues.get(clientId);
    if (!q) return;
    const i = q.indexOf(w);
    if (i < 0) return;
    q.splice(i, 1);
    this.queued--;
    if (q.length === 0) {
      this.queues.delete(clientId);
      const r = this.rotation.indexOf(clientId);
      if (r >= 0) this.rotation.splice(r, 1);
    }
  }
}
