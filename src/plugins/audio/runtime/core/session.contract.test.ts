// ADR 0178: the core session's contract. The session runs each phase's participants in `PHASE_ORDER`'s order, whatever
// order they joined in, and refuses a participant whose phase isn't declared; on the real core backend every declared
// participant joins with every phase it is listed for, nothing queued survives a reconfigure, a failed recovery or
// dispose, the header REPLAY of a real rebuild comes out in §7's order, and every part holding per-context state follows
// a new context. A real `CoreLink` on a recording port, a fake clip registry, no wasm.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
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

function rig() {
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
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips: fakeClips(), clock, mixer, hrir, magls });
  backends.push(backend);
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
  return { backend, mixer, frame, lifecycle, replays, hrir, magls };
}

/** Queued state of every kind the backend holds between frames. */
function queued(backend: CoreBackend, addName: string) {
  return {
    deferredAdd: backend.deferredAdds.waits(addName),
    lockedPlays: backend.lockedQueue.size,
    replayWaiting: backend.replayer.pending,
    staged: backend.writer.pending,
  };
}
const NOTHING = { deferredAdd: false, lockedPlays: 0, replayWaiting: 0, staged: 0 };

/** A rebuild under way with a voice waiting for its clip in the replayer, a play queued behind it, and a live add deferred. */
function withEverythingQueued(r: ReturnType<typeof rig>) {
  const { backend, lifecycle } = r;
  r.frame();
  backend.play({ path: "a.wav", url: "a.wav", loop: true, stream: false, bus: "SFX" });
  r.frame();
  lifecycle.rebuildStart();
  lifecycle.rebuilt(); // the header goes; the voice waits for its clip
  lifecycle.rebuildStart(); // a second trap: new plays queue
  backend.play({ path: "b.wav", url: "b.wav", loop: true, stream: false, bus: "SFX" });
  backend.deferredAdds.defer({ op: "addBus", name: "Later", parent: "Master" });
  backend.writer.fade(backend.debug().voices[0]!.id, 0.5, 0.1);
  const q = queued(backend, "Later");
  expect(q.deferredAdd).toBe(true);
  expect(q.lockedPlays).toBe(1);
  expect(q.replayWaiting).toBeGreaterThan(0);
  expect(q.staged).toBeGreaterThan(0);
}

describe("the core backend's session participants (ADR 0178)", () => {
  it("every participant an order lists joins, with every phase it is listed for (the backend's construction requires it)", () => {
    expect(() => rig()).not.toThrow();
  });

  it("nothing queued survives dispose", () => {
    const r = rig();
    withEverythingQueued(r);
    r.backend.dispose();
    expect(queued(r.backend, "Later")).toEqual(NOTHING);
  });

  it("nothing queued survives a failed recovery", () => {
    const r = rig();
    withEverythingQueued(r);
    r.lifecycle.failed();
    expect(queued(r.backend, "Later")).toEqual(NOTHING);
    expect(r.backend.table.liveCount).toBe(0);
  });

  it("no queued live add survives a reconfigure, and the lanes are all sent again", () => {
    const r = rig();
    r.frame();
    r.backend.deferredAdds.defer({ op: "addBus", name: "Later", parent: "Master" });
    const forget = vi.spyOn(r.backend.lanes, "forget");
    r.backend.configureBuses(r.mixer);
    expect(r.backend.deferredAdds.waits("Later")).toBe(false);
    expect(forget).toHaveBeenCalled();
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

  it("every participant holding per-context state follows a new context", () => {
    const r = rig();
    const { backend } = r;
    r.frame();
    const zones = vi.spyOn(backend.zones, "contextReplaced");
    const cpu = vi.spyOn(backend.mirror.cpu, "setSampleRate");
    const disconnect = vi.spyOn(backend.worklet, "disconnect");
    r.lifecycle.rebuildStart();
    disconnect.mockClear();
    r.lifecycle.contextReplaced(44_100);
    expect(backend.replayer.waitingForClock).toBe(true); // replayer: anchors carried in seconds
    expect([backend.clockMap.sampleRate, backend.writer.sampleRate]).toEqual([44_100, 44_100]); // clock
    expect(r.hrir.retarget).toHaveBeenCalledWith(44_100); // hrir
    expect(r.magls.retarget).toHaveBeenCalledWith(44_100);
    expect(disconnect).toHaveBeenCalledTimes(1); // worklet
    expect(zones).toHaveBeenCalledWith(44_100); // zones
    expect(cpu).toHaveBeenCalledWith(44_100); // mirror
    // The end doesn't drop the new node's channel again.
    r.lifecycle.rebuilt();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
