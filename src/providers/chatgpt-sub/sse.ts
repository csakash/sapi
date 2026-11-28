/**
 * A small server-sent-events reader for provider streams. Bounded: one event may not exceed
 * 1 MiB, so a misbehaving upstream can't grow memory without limit.
 */
import { GatewayError } from "../../canonical.ts";

export type SseMessage = { event?: string; data: string };

const MAX_EVENT_BYTES = 1024 * 1024;

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  let size = 0;
  const flush = (): SseMessage | null => {
    const msg = data.length ? { ...(event ? { event } : {}), data: data.join("\n") } : null;
    event = undefined;
    data = [];
    size = 0;
    return msg;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      if (done) buf += dec.decode();
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const m = flush();
          if (m) yield m;
        } else if (!line.startsWith(":")) {
          const i = line.indexOf(":");
          const field = i === -1 ? line : line.slice(0, i);
          let v = i === -1 ? "" : line.slice(i + 1);
          if (v.startsWith(" ")) v = v.slice(1);
          if (field === "data") {
            size += v.length;
            if (size > MAX_EVENT_BYTES)
              throw new GatewayError("upstream_error", "The provider sent an oversized event.");
            data.push(v);
          } else if (field === "event") event = v.slice(0, 100);
        }
        nl = buf.indexOf("\n");
      }
      if (buf.length > MAX_EVENT_BYTES)
        throw new GatewayError("upstream_error", "The provider sent an oversized event.");
      if (done) {
        const m = flush();
        if (m) yield m;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
