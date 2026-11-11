// ADR 0166 (Q2): the core backend's music seam and the hooks `coreBackend.ts` and `streams.ts` leave for P1, P9 and
// P10: `music` is `musicOps` with every capability, `beginFrame` is idempotent per frame, `timeAt` is the clock map's
// raw heard clock, `latency` adds the limiter, stream event 4 and music members' events route to musicOps,
// `reopenStreams` hands groups to `reopenGroups`, and the DebugSource exposes `musicOps`. On a fake host (no wasm).
import { describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost, HostLifecycleListener } from "./context";
import { CoreLink, type LinkPort } from "./context";
import type { ClipInfo, ClipRegistry, ClipState } from "./clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { CORE_MUSIC_CAPS } from "./musicOps";
import { STREAM_EVENT_MUSIC_FULL } from "./streams";
import type { DebugSource } from "./debug";
import { StreamEvent } from "../wire.generated";

/** Just what the backend's constructor and these tests touch of a registry. */
function fakeClips(): ClipRegistry {
  const info = (id: number): ClipInfo => ({ id, path: "", state: "ready" as ClipState, refs: 0, frames: 0, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null });
  return {
    acquire: () => 1,
    release() {},
    state: () => "ready",
    info,
    onResident: () => () => {},
    releaseWorld() {},
    applyClipEvent() {},
    residentIds: () => [],
    acquireReserved() {},
  } as unknown as ClipRegistry;
}

function rig(latency?: { base: number; output: number }) {
  const port: LinkPort = { onmessage: null, postMessage: () => {} };
  const link = new CoreLink(port);
  let raf = 1000;
  let ctx = 0;
  const clock = {
    rafTime: () => raf,
    outputTimestamp: () => ({ contextTime: ctx, performanceTime: raf }),
    currentTime: () => ctx,
    dateNow: () => 1_000_000 + raf,
    fake: true as const,
    advance(ms: number) {
      raf += ms;
      ctx += ms / 1000;
    },
  };
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, limiterLookaheadMs: 1.5 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => () => void l) as AudioHost["addLifecycleListener"],
    ...(latency ? { latency: () => latency } : {}),
  };
  const backend = new CoreBackend(host, { clips: fakeClips(), clock, mixer: new Mixer(defaultAudioSettings()) });
  return { backend, clock, raf: () => raf };
}

describe("the core's music seam (ADR 0166 §4.6, Q2)", () => {
  it("music is musicOps, with every capability the core will have, and stubs that refuse safely", () => {
    const { backend } = rig();
    expect(backend.music).toBe(backend.musicOps);
    expect(backend.music.caps).toEqual(CORE_MUSIC_CAPS);
    expect(CORE_MUSIC_CAPS).toEqual({ primes: true, stampedFades: true, heardClock: true, rhythm: true });
    expect(backend.music.primeEmaMs).toBe(40);
    expect(backend.music.primedState(1)).toBeNull();
    expect(backend.music.admitGroup({ instance: 1, group: 1, members: [] }).ok).toBe(false);
    const src: DebugSource = backend;
    expect(src.musicOps?.debugView().groups).toEqual([]);
    backend.dispose();
  });

  it("beginFrame is idempotent per frame and leaves Audio.time as frameAttenuate gives it", () => {
    const a = rig();
    const b = rig();
    for (let k = 0; k < 5; k++) {
      a.clock.advance(16);
      b.clock.advance(16);
      a.backend.beginFrame();
      a.backend.beginFrame();
      a.backend.update(0.016);
      b.backend.update(0.016);
      expect(a.backend.time).toBe(b.backend.time);
    }
    a.backend.dispose();
    b.backend.dispose();
  });

  it("timeAt maps a performance.now() instant to the raw heard clock", () => {
    const { backend, clock, raf } = rig();
    expect(backend.timeAt(raf())).toBe(backend.time); // no estimate yet: Audio.time
    for (let k = 0; k < 3; k++) {
      clock.advance(16);
      backend.update(0.016);
    }
    expect(backend.timeAt(raf())).toBeCloseTo(backend.time, 9);
    expect(backend.timeAt(raf() + 100) - backend.timeAt(raf())).toBeCloseTo(0.1, 9);
    backend.dispose();
  });

  it("latency adds the limiter to the host's read-back; reliable only for 0 < output < 0.5", () => {
    const none = rig();
    const l0 = none.backend.latency();
    expect(l0.base).toBe(0);
    expect(l0.output).toBe(0);
    expect(l0.limiter).toBeCloseTo(72 / 48_000, 9); // 1.5 ms look-ahead at 48 kHz
    expect(l0.reliable).toBe(false);
    const read = rig({ base: 0.005, output: 0.02 });
    const l1 = read.backend.latency();
    expect(l1.total).toBeCloseTo(0.005 + 0.02 + l1.limiter, 12);
    expect(l1.reliable).toBe(true);
    none.backend.dispose();
    read.backend.dispose();
  });

  it("stream event 4 and a music member's events go to musicOps; others stay with the stream manager", () => {
    const { backend } = rig();
    const routed = vi.spyOn(backend.musicOps, "onStreamEvent");
    backend.streams.streamEvent(0xffff0100, STREAM_EVENT_MUSIC_FULL);
    expect(routed).toHaveBeenCalledWith(0xffff0100, 4);
    backend.streams.streamEvent(0xffff0101, StreamEvent.Starved);
    expect(routed).toHaveBeenCalledTimes(1);
    expect(backend.streams.stats.starves).toBe(1);
    vi.spyOn(backend.musicOps, "ownsStream").mockImplementation((id) => id === 0xffff0102);
    backend.streams.streamEvent(0xffff0102, StreamEvent.Starved);
    expect(routed).toHaveBeenLastCalledWith(0xffff0102, StreamEvent.Starved);
    expect(backend.streams.stats.starves).toBe(1);
    backend.dispose();
  });

  it("reopenStreams skips music members and reopens their groups as groups", () => {
    const { backend } = rig();
    const reopen = vi.spyOn(backend.musicOps, "reopenGroups");
    const owns = vi.spyOn(backend.musicOps, "ownsVoice").mockReturnValue(true);
    backend.reopenStreams([0x10001]);
    expect(reopen).toHaveBeenCalledTimes(1);
    owns.mockRestore();
    backend.dispose();
  });
});
