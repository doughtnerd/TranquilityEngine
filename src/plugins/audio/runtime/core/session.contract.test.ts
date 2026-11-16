// ADR 0178: the core session's contract. The session runs each phase's participants in `PHASE_ORDER`'s order, whatever
// order they joined in, and refuses a participant whose phase isn't declared; on the real core backend every declared
// participant joins with every phase it is listed for, nothing queued survives a reconfigure, a failed recovery or
// dispose, the header REPLAY of a real rebuild comes out in §7's order, and every part holding per-context state follows
// a new context. A real `CoreLink` on a recording port, a fake clip registry, no wasm.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { Kind, Op, readBatchHeader, readEnvelope, readRecordHead } from "../wire.generated";
import type { AudioHost, HostLifecycleListener } from "./context";
import { CoreLink, type LinkPort } from "./context";
import type { ClipInfo, ClipRegistry } from "./clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import type { HrirLoader, MaglsLoader } from "./hrir";
import type { ReplayBuilder } from "./replay";
import { ListenerFrame } from "./spatial";
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { CoreSession, PHASE_ORDER, type ParticipantName, type SessionParticipant, type SessionPhase } from "./session";

const PHASES = Object.keys(PHASE_ORDER) as SessionPhase[];
const ALL_NAMES = [...new Set(PHASES.flatMap((p) => PHASE_ORDER[p] as readonly ParticipantName[]))];

/** A participant named `name` implementing every phase its orders list, each appending `phase:name` to `log`. */
function recorder(name: ParticipantName, log: string[]): SessionParticipant {
  const p: Record<string, () => void> = {};
  for (const phase of PHASES) if ((PHASE_ORDER[phase] as readonly string[]).includes(name)) p[phase] = () => void log.push(`${phase}:${name}`);
  return p as SessionParticipant;
}

function runPhase(s: CoreSession, phase: SessionPhase): void {
  const b = {} as ReplayBuilder;
  const v = { id: 1, i: 1, mixed: true, frame: 0, rate: 48_000 };
  if (phase === "reconfigure") s.reconfigure(new Mixer(defaultAudioSettings()));
  else if (phase === "contextReplaced") s.contextReplaced(44_100);
  else if (phase === "replayHeader") s.replayHeader(b);
  else if (phase === "replayVoice") s.replayVoice(b, v);
  else if (phase === "reopenStreams") s.reopenStreams([]);
  else s[phase]();
}

describe("CoreSession (ADR 0178)", () => {
  it("runs each phase in PHASE_ORDER's order, whatever order the participants joined in", () => {
    const log: string[] = [];
    const s = new CoreSession();
    for (const name of [...ALL_NAMES].reverse()) s.join(name, recorder(name, log));
    expect(() => s.requireComplete()).not.toThrow();
    for (const phase of PHASES) {
      if (phase === "dispose") continue;
      log.length = 0;
      runPhase(s, phase);
      expect(log, phase).toEqual((PHASE_ORDER[phase] as readonly string[]).map((n) => `${phase}:${n}`));
    }
    log.length = 0;
    s.dispose();
    expect(log).toEqual(PHASE_ORDER.dispose.map((n) => `dispose:${n}`));
  });

  it("refuses a participant that implements a phase whose order doesn't list it, and a name joined twice", () => {
    const s = new CoreSession();
    expect(() => s.join("beds", { dispose: () => {} })).toThrow(/beds" implements dispose, but PHASE_ORDER.dispose doesn't list it/);
    s.join("beds", { replayHeader: () => {} });
    expect(() => s.join("beds", { replayHeader: () => {} })).toThrow(/joined twice/);
    // The other direction is refused once the owner says everything joined: a listed name missing, or joined without a phase.
    s.join("zones", { dispose: () => {} });
    expect(() => s.requireComplete()).toThrow(/contextReplaced: zones/);
    expect(() => s.requireComplete()).toThrow(/replayHeader: zones/);
    expect(() => s.requireComplete()).toThrow(/dispose: writer/);
  });

  it("owns recovering and disposed: set before the phase's participants run; recovery phases stop and dispose runs once after dispose", () => {
    const s = new CoreSession();
    const seen: string[] = [];
    s.join("dip", { beginRecovery: () => void seen.push(`begin ${s.recovering}`) });
    s.join("mirror", { contextReplaced: () => void seen.push("context"), endRecovery: () => void seen.push(`end ${s.recovering}`) });
    s.join("writer", { recoveryFailed: () => void seen.push(`failed ${s.recovering}`), dispose: () => void seen.push(`dispose ${s.disposed}`) });
    s.beginRecovery();
    s.endRecovery();
    s.beginRecovery();
    s.recoveryFailed();
    s.dispose();
    s.dispose();
    s.beginRecovery();
    s.contextReplaced(44_100);
    s.endRecovery();
    s.recoveryFailed();
    expect(seen).toEqual(["begin true", "end false", "begin true", "failed false", "dispose true"]);
    expect([s.recovering, s.disposed]).toEqual([false, true]);
  });

  it("the replay header's order is ADR 0157 §7 as S10 and §4.2 extended it; the per-voice order follows each PLAY", () => {
    // RESET 0, BUS_CONFIG, BED_CONFIG, BUS_DUCK + BUS_PRESENCE, LOUD_CONFIG, BUS_RAMP lanes, MASTER, LISTENER, ZONE_CONFIG, automation.
    expect(PHASE_ORDER.replayHeader).toEqual(["reset", "buses", "beds", "presence", "loudness", "lanes", "master", "listener", "zones", "automation"]);
    // AUTOMATE + SET_LOOP, SET_VOICE_FX, then FADE, stamped ramps and SET_PAUSED.
    expect(PHASE_ORDER.replayVoice).toEqual(["automation", "voiceFx", "voiceState"]);
  });
});

// --- The core backend's participants ------------------------------------------------------------------------------

function fakeClips(): ClipRegistry {
  return {
    acquire: () => 1,
    release: () => {},
    state: () => "ready",
    info: (id: number): ClipInfo => ({ id, path: "", state: "ready", refs: 0, frames: 48_000, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null }),
    // A rebuild's clips never come back here: their voices wait in the replayer.
    onResident: () => () => {},
    releaseWorld: () => {},
    applyClipEvent: () => {},
    residentIds: () => [],
    acquireReserved: () => {},
  } as unknown as ClipRegistry;
}

function fakeClock() {
  let raf = 1000;
  let ctx = 0;
  let date = 1_000_000;
  return {
    rafTime: () => raf,
    outputTimestamp: () => ({ contextTime: ctx, performanceTime: raf }),
    currentTime: () => ctx,
    dateNow: () => date,
    fake: true as const,
    advance(ms: number) {
      raf += ms;
      date += ms;
      ctx += ms / 1000;
    },
  };
}

const backends: CoreBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});

function rig(settings: AudioSettings = defaultAudioSettings()) {
  const sent: ArrayBuffer[] = [];
  const port: LinkPort = { onmessage: null, postMessage: (m) => sent.push(m as ArrayBuffer) };
  const link = new CoreLink(port);
  const listeners: HostLifecycleListener[] = [];
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => {
      listeners.push(l);
      return () => void listeners.splice(listeners.indexOf(l), 1);
    }) as AudioHost["addLifecycleListener"],
  };
  const clock = fakeClock();
  const hrir = { ensure() {}, ready: false, failed: false, retarget: vi.fn() } as unknown as HrirLoader;
  const magls = { ensure() {}, ready: false, failed: false, retarget: vi.fn() } as unknown as MaglsLoader;
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, { clips: fakeClips(), clock, mixer, hrir, magls });
  backends.push(backend);
  // `mixer.apply` sends to the backend's live path, as `setAudioBackend` wires it (the backend's `mix.mixOpTarget`).
  mixer._setOpTarget(backend.mix!.mixOpTarget);
  const frame = () => {
    clock.advance(16);
    backend.update(0.016);
  };
  const lifecycle = {
    rebuildStart: () => listeners.forEach((l) => l.onRebuildStart?.("trap")),
    contextReplaced: (rate: number) => listeners.forEach((l) => l.onContextReplaced?.(rate)),
    rebuilt: () => listeners.forEach((l) => l.onRebuilt?.()),
    failed: () => listeners.forEach((l) => l.onRecoveryFailed?.()),
  };
  /** The opcodes of each REPLAY message posted since the last call. */
  const replays = () => {
    const out: number[][] = [];
    for (const m of sent.splice(0)) {
      const view = new DataView(m);
      if (readEnvelope(view, 0).kind !== Kind.REPLAY) continue;
      const ops: number[] = [];
      let off = 32;
      for (let k = 0; k < readBatchHeader(view, 0).count; k++) {
        const head = readRecordHead(view, off);
        ops.push(head.opcode);
        off += head.words * 4;
      }
      out.push(ops);
    }
    return out;
  };
  return { backend, mixer, frame, lifecycle, replays, hrir, magls, sent };
}

/** The opcodes of every BATCH and REPLAY record posted since the last `mark()`. */
function posted(r: ReturnType<typeof rig>): number[] {
  const out: number[] = [];
  for (const m of r.sent.splice(0)) {
    const view = new DataView(m);
    const kind = readEnvelope(view, 0).kind;
    if (kind !== Kind.BATCH && kind !== Kind.REPLAY) continue;
    let off = 32;
    for (let k = 0; k < readBatchHeader(view, 0).count; k++) {
      const head = readRecordHead(view, off);
      out.push(head.opcode);
      off += head.words * 4;
    }
  }
  return out;
}

/** Master and 31 buses under it: every slot of 32 in use, so a live add must wait for a recycle. */
function fullBuses(): AudioSettings {
  const s = defaultAudioSettings();
  return { ...s, buses: [{ name: "Master", volume: 1, mute: false, effects: [] }, ...Array.from({ length: 31 }, (_, i) => ({ name: `B${i + 1}`, parent: "Master", volume: 1, mute: false, effects: [] }))] };
}

/** What the backend reports queued between frames (`Audio.debug()`): plays waiting for the core, live adds waiting for a slot, voices listed. */
const queued = (backend: CoreBackend) => {
  const d = backend.debug();
  return { queuedPlays: d.counters.queuedPlays, deferredAdds: d.mix!.liveDeferredPending, voices: d.voices.filter((v) => v.state !== "stolen").length };
};

/**
 * A rebuild under way with a voice waiting for its clip in the replay, a play queued behind it, a live add waiting for a slot (a
 * removal and an add in one task through `mixer.apply`, every slot in use), and a volume change staged but not yet sent.
 */
function withEverythingQueued(r: ReturnType<typeof rig>) {
  const { backend, lifecycle, mixer } = r;
  r.frame();
  const first = backend.play({ path: "a.wav", url: "a.wav", loop: true, stream: false, bus: "B1" })!;
  r.frame();
  lifecycle.rebuildStart();
  lifecycle.rebuilt(); // the header goes; the voice waits for its clip
  lifecycle.rebuildStart(); // a second trap: new plays queue
  backend.play({ path: "b.wav", url: "b.wav", loop: true, stream: false, bus: "B1" });
  expect(mixer.apply({ op: "removeBus", bus: "B31" }).ok).toBe(true);
  expect(mixer.apply({ op: "addBus", name: "Later", parent: "Master" })).toMatchObject({ ok: true, reason: "waitsForSlot" });
  first.setVolume(0.5);
  expect(queued(backend)).toMatchObject({ queuedPlays: 1, deferredAdds: 1 });
  r.sent.length = 0;
}

describe("the core backend's session participants (ADR 0178)", () => {
  it("every participant an order lists joins, with every phase it is listed for (the backend's construction requires it)", () => {
    expect(() => rig()).not.toThrow();
  });

  it("nothing queued survives dispose: nothing is reported queued, and nothing staged or waiting is ever sent", () => {
    const r = rig(fullBuses());
    withEverythingQueued(r);
    r.backend.dispose();
    expect(queued(r.backend)).toMatchObject({ queuedPlays: 0, deferredAdds: 0 });
    r.backend.flushNow();
    r.lifecycle.rebuilt();
    r.frame();
    expect(posted(r), "no record after dispose").toEqual([]);
  });

  it("nothing queued survives a failed recovery: every voice ends, nothing is reported queued, the staged volume is never sent", () => {
    const r = rig(fullBuses());
    withEverythingQueued(r);
    r.lifecycle.failed();
    expect(queued(r.backend)).toEqual({ queuedPlays: 0, deferredAdds: 0, voices: 0 });
    r.backend.flushNow();
    r.frame();
    expect(posted(r).filter((op) => op === Op.SET_PARAMS || op === Op.PLAY), "the staged volume and the queued play are gone").toEqual([]);
  });

  it("no queued live add survives a reconfigure, and the lanes are all sent again", () => {
    const r = rig(fullBuses());
    r.frame();
    expect(r.mixer.apply({ op: "removeBus", bus: "B31" }).ok).toBe(true);
    expect(r.mixer.apply({ op: "addBus", name: "Later", parent: "Master" }).reason).toBe("waitsForSlot");
    r.frame();
    r.sent.length = 0;
    expect(queued(r.backend).deferredAdds, "the add waits").toBe(1);
    r.backend.configureBuses(r.mixer);
    expect(queued(r.backend).deferredAdds).toBe(0);
    r.frame();
    const ops = posted(r);
    // Every lane of every bus again (the bus lane writer forgot what the old tree had): one BUS_RAMP per lane per live bus.
    expect(ops).toContain(Op.BUS_CONFIG);
    expect(ops.filter((op) => op === Op.BUS_RAMP).length).toBeGreaterThanOrEqual(r.mixer.busNames.length);
  });

  it("a real rebuild's header REPLAY comes out in §7's order", () => {
    const r = rig();
    // A listener rotation was sent, so the replay snaps LISTENER after MASTER.
    const listener = new ListenerFrame();
    listener.world = {} as World;
    listener.node = {} as GameObject;
    listener.fwdX = 1;
    listener.fwdZ = 0;
    r.backend.frameStageListener(listener);
    r.frame();
    r.replays();
    r.lifecycle.rebuildStart();
    r.lifecycle.rebuilt();
    const [header] = r.replays();
    // Runs of one opcode as one (the lanes are a BUS_RAMP per lane per bus). Beds, zones and automation are inert in
    // this rig and append nothing (their places: BED_CONFIG after BUS_CONFIG, ZONE_CONFIG after LISTENER, then automation).
    const runs = header!.filter((op, k) => op !== header![k - 1]);
    expect(runs).toEqual([Op.RESET, Op.BUS_CONFIG, Op.BUS_DUCK, Op.BUS_PRESENCE, Op.LOUD_CONFIG, Op.BUS_RAMP, Op.MASTER, Op.LISTENER]);
  });

  // A new context's other participants (the replayer's carry in seconds, the clock map and the writer's rate, the worklet
  // channel, the zones' kernels, the CPU meter's rate) are internal parts: that each runs, in `PHASE_ORDER.contextReplaced`'s
  // order, is the CoreSession cases above plus `requireComplete` at construction; what they do end to end at a new rate is
  // `contextRebuild.test.ts` (loopback host), and their own tests (`zones.test.ts`, `workletChannel.test.ts`).
  it("a new context retargets the HRIR and MagLS filters the backend was given to the new rate", () => {
    const r = rig();
    r.frame();
    r.lifecycle.rebuildStart();
    r.lifecycle.contextReplaced(44_100);
    expect(r.hrir.retarget).toHaveBeenCalledWith(44_100);
    expect(r.magls.retarget).toHaveBeenCalledWith(44_100);
  });
});
