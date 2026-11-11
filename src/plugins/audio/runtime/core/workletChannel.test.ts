// B3, ADR 0162 C9: the decoder worker ↔ worklet channel streams and zone IRs share, and the zone IR service on it:
// one connection per worker and node, a new one after a respawn or `disconnect()`, kernels asked for again on a renewed
// channel exactly once, and a channel that can't be made failing the request instead of throwing.
import { describe, expect, it } from "vitest";
import type { IrFailedMessage, IrPreparedMessage, IrRequest } from "../decoder/protocol";
import { ZONE_KERNEL_ID_FIRST } from "../wire.generated";
import { WorkletChannel } from "./workletChannel";
import { createZoneIrService } from "./zoneIr";

const K1 = ZONE_KERNEL_ID_FIRST;
const K2 = ZONE_KERNEL_ID_FIRST + 1;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A decoder whose worker is a list: `connectWorklet` spawns it on first use (as the client does), `crash` retires it. */
function fakeDecoder() {
  const posted: (IrRequest | { type: "connectWorklet" })[] = [];
  let listener: ((reply: IrPreparedMessage | IrFailedMessage) => void) | null = null;
  let alive = false;
  const d = {
    generation: 0,
    posted,
    connectWorklet() {
      if (!alive) {
        alive = true;
        d.generation++;
      }
      posted.push({ type: "connectWorklet" });
    },
    postIr(request: IrRequest) {
      posted.push(request);
    },
    onIr(l: (reply: IrPreparedMessage | IrFailedMessage) => void) {
      listener = l;
      return () => (listener = null);
    },
    crash() {
      alive = false;
      d.generation++;
    },
    reply(request: IrRequest) {
      if (request.type === "releaseIr") return;
      listener?.({ type: "irPrepared", token: request.token, kernelId: request.kernelId, frames: 100, truncated: false, prepareMs: 1 });
    },
  };
  return d;
}

function setup() {
  const decoder = fakeDecoder();
  const worklets: unknown[] = [];
  const channel = new WorkletChannel({ decoder: () => decoder, connectWorklet: (port) => void worklets.push(port), channel: () => ({ worker: {} as never, worklet: {} as never }) });
  const service = createZoneIrService({ worklet: { ensure: () => channel.ensure(), get connections() { return channel.connections; }, onConnect: (l) => channel.onConnect(l) } });
  const prepared: number[] = [];
  const failed: string[] = [];
  service.onPrepared = (e) => void prepared.push(e.kernelId);
  service.onFailed = (e) => void failed.push(e.message);
  const irs = () => decoder.posted.filter((m): m is IrRequest => m.type === "generateIr" || m.type === "prepareIr");
  const answerAll = () => irs().forEach((r) => decoder.reply(r));
  return { decoder, channel, worklets, service, prepared, failed, irs, answerAll };
}

describe("the worker ↔ worklet channel (B3, ADR 0162 C9)", () => {
  it("connects before the first IR request, once per worker; a crash or a disconnect connects a new one", () => {
    const s = setup();
    s.service.prepare({ kernelId: K1, preset: "hall", contextRate: 48_000, maxFrames: 48_000 });
    expect(s.decoder.posted.map((m) => m.type)).toEqual(["connectWorklet", "generateIr"]);
    expect(s.worklets.length).toBe(1);
    s.service.prepare({ kernelId: K2, preset: "room", contextRate: 48_000, maxFrames: 48_000 });
    expect(s.channel.connections).toBe(1);
    s.decoder.crash();
    s.channel.ensure();
    expect(s.channel.connections).toBe(2);
    s.channel.disconnect();
    s.channel.ensure();
    expect(s.channel.connections).toBe(3);
    expect(s.worklets.length).toBe(3);
  });

  it("a renewed channel (another user reconnected after a respawn) sends every kernel again, once each", async () => {
    const s = setup();
    s.service.prepare({ kernelId: K1, preset: "hall", contextRate: 48_000, maxFrames: 48_000 });
    s.service.prepare({ kernelId: K2, preset: "room", contextRate: 48_000, maxFrames: 48_000 });
    s.answerAll();
    expect(s.prepared).toEqual([K1, K2]);
    s.decoder.crash();
    // A stream open, say: the channel is renewed under the service.
    s.channel.ensure();
    const again = s.irs().slice(2);
    expect(again.map((r) => r.kernelId).sort()).toEqual([K1, K2]);
    again.forEach((r) => s.decoder.reply(r));
    expect(s.prepared).toEqual([K1, K2, K1, K2]);
    // A new request on the renewed channel doesn't resend anything.
    s.service.prepare({ kernelId: K2 + 1, preset: "plate", contextRate: 48_000, maxFrames: 48_000 });
    expect(s.irs().length).toBe(5);
    await flush();
    expect(s.failed).toEqual([]);
  });

  it("a request that renews the channel itself, and reprepareAll after a rebuild's disconnect, send each kernel once", () => {
    const s = setup();
    s.service.prepare({ kernelId: K1, preset: "hall", contextRate: 48_000, maxFrames: 48_000 });
    s.answerAll();
    s.decoder.crash();
    s.service.prepare({ kernelId: K2, preset: "room", contextRate: 48_000, maxFrames: 48_000 });
    expect(s.irs().slice(1).map((r) => r.kernelId).sort()).toEqual([K1, K2]);
    s.channel.disconnect();
    s.service.reprepareAll?.(44_100);
    const last = s.irs().slice(3);
    expect(last.map((r) => r.kernelId).sort()).toEqual([K1, K2]);
    expect(last.every((r) => r.contextRate === 44_100)).toBe(true);
    expect(s.channel.connections).toBe(3);
  });

  it("a channel that can't be connected fails the request (no throw)", async () => {
    const service = createZoneIrService({
      worklet: {
        ensure: () => {
          throw new Error("no port");
        },
        connections: 0,
        onConnect: () => () => {},
      },
    });
    const failed: string[] = [];
    service.onFailed = (e) => void failed.push(e.message);
    expect(() => service.prepare({ kernelId: K1, preset: "hall", contextRate: 48_000, maxFrames: 48_000 })).not.toThrow();
    await flush();
    expect(failed.length).toBe(1);
    expect(failed[0]).toContain("no port");
  });
});
