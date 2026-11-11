// ADR 0162 C9 end to end on the loopback host: a zone's impulse response reaches the worklet on the decoder worker's
// port, with the real decoder handler in process, the real `CoreDriver` and the real mixer wasm. The kernel goes from the
// worker straight to the worklet as CLIP_BEGIN/CLIP_CHUNK format 3; main only hears `irPrepared`.
//
// - a preset requested before any stream ever opened: the backend connects the worker to the worklet first, and the
//   worklet takes the kernel's clip records from that port into the core;
// - a stream opened afterwards shares the same channel (one connection, not two);
// - a decoder worker that died: the next request connects the new worker, the worklet frees the dead worker's kernels,
//   and every kernel held is prepared again on the new worker.
import { describe, expect, it, vi } from "vitest";
import { makeWav, signal } from "../decoder/testWav";
import { RATE, rig } from "../../testing/streamRig";
import { ZONE_KERNEL_ID_FIRST } from "../wire.generated";
import { zoneKernelBlobBytes } from "../worklet/coreDriver";
import type { ZoneIrService } from "../backend";

const ZONES = { maxZoneSlots: 2, zoneMaxSeconds: 1 } as const;
const K1 = ZONE_KERNEL_ID_FIRST;
const K2 = ZONE_KERNEL_ID_FIRST + 1;

/** Listens to the backend's IR service beside the zone manager (which keeps hearing it). */
function listen(service: ZoneIrService) {
  const prepared = new Map<number, number>();
  const failed = new Map<number, string>();
  const onPrepared = service.onPrepared;
  const onFailed = service.onFailed;
  service.onPrepared = (e) => {
    prepared.set(e.kernelId, (prepared.get(e.kernelId) ?? 0) + 1);
    onPrepared?.(e);
  };
  service.onFailed = (e) => {
    failed.set(e.kernelId, e.message);
    onFailed?.(e);
  };
  return { prepared, failed };
}

describe("zone impulse responses on the worker's port (ADR 0162 C9)", () => {
  it("a preset asked for before any stream: the worker is connected to the worklet and the kernel lands in the core", async (ctx) => {
    const r = await rig({ "music/a.wav": makeWav(RATE, 2, RATE, signal) }, { zones: ZONES });
    if (!r) return ctx.skip();
    const { prepared, failed } = listen(r.backend.zoneIr);
    r.backend.zoneIr.prepare({ kernelId: K1, preset: "hall", contextRate: RATE, maxFrames: RATE });
    await vi.waitFor(
      async () => {
        await r.step(1);
        expect(failed.get(K1)).toBeUndefined();
        expect(prepared.get(K1)).toBe(1);
      },
      { timeout: 5_000, interval: 5 },
    );
    await r.step(4);
    expect(failed.size).toBe(0);
    // The whole kernel was copied into the core's arena from the worker's port.
    expect(r.loop.driver.workerClips).toBe(1);
    expect(r.loop.driver.stats.clipBytes).toBeGreaterThan(0);
    expect(r.loop.driver.stats.clipBytes).toBeLessThanOrEqual(zoneKernelBlobBytes(RATE));
    expect(r.backend.worklet.connections).toBe(1);
    // A stream opened now rides the same channel.
    r.backend.play({ path: "music/a.wav", url: "", loop: true, stream: true, bus: "Music" });
    await r.step(2);
    await r.waitOpen(1);
    expect(r.backend.worklet.connections).toBe(1);
    // The streams didn't make one of their own.
    expect(r.backend.streams.stats.connections).toBe(0);
    r.backend.dispose();
  }, 20_000);

  it("a decoder worker that died: the next request connects the new one and every held kernel is prepared again", async (ctx) => {
    const r = await rig({}, { zones: ZONES });
    if (!r) return ctx.skip();
    const { prepared, failed } = listen(r.backend.zoneIr);
    r.backend.zoneIr.prepare({ kernelId: K1, preset: "hall", contextRate: RATE, maxFrames: RATE });
    await vi.waitFor(
      async () => {
        await r.step(1);
        expect(prepared.get(K1)).toBe(1);
      },
      { timeout: 5_000, interval: 5 },
    );
    await r.step(4);
    const bytes = r.loop.driver.stats.clipBytes;
    expect(r.spawned()).toBe(1);
    r.worker().onerror?.({ message: "boom" });
    r.backend.zoneIr.prepare({ kernelId: K2, preset: "room", contextRate: RATE, maxFrames: RATE });
    await vi.waitFor(
      async () => {
        await r.step(1);
        expect(prepared.get(K2)).toBe(1);
        expect(prepared.get(K1)).toBe(2);
      },
      { timeout: 5_000, interval: 5 },
    );
    await r.step(4);
    expect(failed.size).toBe(0);
    expect(r.spawned()).toBe(2);
    expect(r.backend.worklet.connections).toBe(2);
    // The dead worker's kernel was freed and sent again by the new worker, beside the new one: two in the core.
    expect(r.loop.driver.workerClips).toBe(2);
    expect(r.loop.driver.stats.clipBytes).toBeGreaterThan(2 * bytes);
    r.backend.dispose();
  }, 20_000);
});
