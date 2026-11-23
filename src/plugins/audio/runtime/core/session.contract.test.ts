// ADR 0178: the core session's contract. The session runs each phase's participants in `PHASE_ORDER`'s order, whatever
// order they joined in, and refuses a participant whose phase isn't declared; on the real core backend every declared
// participant joins with every phase it is listed for, nothing queued survives a reconfigure, a failed recovery or
// dispose, the header REPLAY of a real rebuild comes out in §7's order, and every part holding per-context state follows
// a new context. The recording host (`recordingAudio`, ADR 0234): the production assembly, a fake clip registry, no wasm.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeRecordingAudio, recordingAudio, type RecordingNewCore } from "../testing";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { Kind, Op } from "../wire.generated";
import type { CoreBackend } from "./coreBackend";
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
    const s = new CoreSession(() => "running");
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
    const s = new CoreSession(() => "running");
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
    const s = new CoreSession(() => "running");
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

  it("answers the send rule from its own state and the host's status (ADR 0291)", () => {
    let status: "locked" | "running" | "failed" = "running";
    const s = new CoreSession(() => status);
    const rule = () => [s.maySend, s.mayQueue];
    expect(rule(), "running").toEqual([true, true]);
    status = "locked";
    expect(rule(), "locked").toEqual([false, true]);
    status = "running";
    s.beginRecovery();
    expect(rule(), "recovering").toEqual([false, false]);
    s.endRecovery();
    expect(rule(), "recovered").toEqual([true, true]);
    status = "failed";
    expect(rule(), "failed").toEqual([false, false]);
    status = "running";
    s.dispose();
    expect(rule(), "disposed").toEqual([false, false]);
  });

  it("the replay header's order is ADR 0157 §7 as S10 and §4.2 extended it; the per-voice order follows each PLAY", () => {
    // RESET 0, BUS_CONFIG, BED_CONFIG, BUS_DUCK + BUS_PRESENCE, LOUD_CONFIG, BUS_RAMP lanes, MASTER, LISTENER, ZONE_CONFIG, automation, SUBMIX (ADR 0345).
    expect(PHASE_ORDER.replayHeader).toEqual(["reset", "buses", "beds", "presence", "loudness", "lanes", "master", "listener", "zones", "automation", "submixes"]);
    // AUTOMATE + SET_LOOP, SET_VOICE_FX, then FADE, stamped ramps and SET_PAUSED.
    expect(PHASE_ORDER.replayVoice).toEqual(["automation", "voiceFx", "voiceState"]);
  });
});

// --- The core backend's participants ------------------------------------------------------------------------------

afterEach(closeRecordingAudio);

/** The core backend on the recording host (ADR 0234), over its own mixer, with HRIR and MagLS loaders that record their retargets. */
function rig(settings: AudioSettings = defaultAudioSettings()) {
  const hrir = { ensure() {}, ready: false, failed: false, retarget: vi.fn() } as unknown as HrirLoader;
  const magls = { ensure() {}, ready: false, failed: false, retarget: vi.fn() } as unknown as MaglsLoader;
  // A rebuild's clips never come back here (no `settle`): their voices wait in the replayer.
  const r = recordingAudio({ mixer: "own", settings, preset: { maxLogical: 16 }, backend: { hrir, magls } });
  const { backend, mixer } = r;
  // `mixer.apply` sends to the backend's live path: the core backend wires it on its mixer (`mix.mixOpTarget`, its LiveMix).
  /** The opcodes of each REPLAY message posted since the last call. */
  const replays = () => r.posted.take().filter((b) => b.kind === Kind.REPLAY).map((b) => b.records.map((x) => x.opcode));
  return { r, backend, mixer, frame: () => r.frame(), replays, hrir, magls };
}

/** The opcodes of every BATCH and REPLAY record posted since the last call. */
function posted(t: ReturnType<typeof rig>): number[] {
  return t.r.posted.takeRecords().map((x) => x.opcode);
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
async function withEverythingQueued(r: ReturnType<typeof rig>, secondCore: RecordingNewCore) {
  const { backend, mixer } = r;
  r.frame();
  const first = backend.play({ path: "a.wav", url: "a.wav", loop: true, stream: false, bus: "B1" })!;
  r.frame();
  expect(await r.r.rebuild()).toBe("rebuilt"); // the header goes; the voice waits for its clip
  r.r.newCore = secondCore;
  void r.r.rebuild(); // a second trap: new plays queue (its core answers, or fails, a microtask later)
  backend.play({ path: "b.wav", url: "b.wav", loop: true, stream: false, bus: "B1" });
  expect(mixer.apply({ op: "removeBus", bus: "B31" }).ok).toBe(true);
  expect(mixer.apply({ op: "addBus", name: "Later", parent: "Master" })).toMatchObject({ ok: true, reason: "waitsForSlot" });
  first.setVolume(0.5);
  expect(queued(backend)).toMatchObject({ queuedPlays: 1, deferredAdds: 1 });
  r.r.posted.take();
}

describe("the core backend's session participants (ADR 0178)", () => {
  it("every participant an order lists joins, with every phase it is listed for (the backend's construction requires it)", () => {
    expect(() => rig()).not.toThrow();
  });

  it("nothing queued survives dispose: nothing is reported queued, and nothing staged or waiting is ever sent", async () => {
    const r = rig(fullBuses());
    await withEverythingQueued(r, "answers");
    r.backend.dispose();
    expect(queued(r.backend)).toMatchObject({ queuedPlays: 0, deferredAdds: 0 });
    r.backend.flushNow();
    await r.r.settle(); // the second rebuild's core answers
    r.frame();
    expect(posted(r), "no record after dispose").toEqual([]);
  });

  it("nothing queued survives a failed recovery: every voice ends, nothing is reported queued, the staged volume is never sent", async () => {
    const r = rig(fullBuses());
    await withEverythingQueued(r, "fails");
    await r.r.settle(); // the second rebuild's core fails to start: recovery gives up
    expect(r.r.host.recoveryHasFailed).toBe(true);
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
    r.r.posted.take();
    expect(queued(r.backend).deferredAdds, "the add waits").toBe(1);
    r.backend.configureBuses(r.mixer);
    expect(queued(r.backend).deferredAdds).toBe(0);
    r.frame();
    const ops = posted(r);
    // Every lane of every bus again (the bus lane writer forgot what the old tree had): one BUS_RAMP per lane per live bus.
    expect(ops).toContain(Op.BUS_CONFIG);
    expect(ops.filter((op) => op === Op.BUS_RAMP).length).toBeGreaterThanOrEqual(r.mixer.busNames.length);
  });

  it("a real rebuild's header REPLAY comes out in §7's order", async () => {
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
    expect(await r.r.rebuild()).toBe("rebuilt");
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
  it("a new context retargets the HRIR and MagLS filters the backend was given to the new rate", async () => {
    const r = rig();
    r.frame();
    expect(await r.r.changeRate(44_100)).toBe("rebuilt");
    expect(r.hrir.retarget).toHaveBeenCalledWith(44_100);
    expect(r.magls.retarget).toHaveBeenCalledWith(44_100);
  });
});
