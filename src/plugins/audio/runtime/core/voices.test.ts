// ADR 0176: the core voice (`voices.ts`) driven by voice id over a recording writer: what each change sends, the
// effective views, a stem's lookahead and stale re-sends (F-9b, F-12), launch / wait / fail and refusal reporting.
import { describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { SET_PARAMS_MASK_DIR, SET_PARAMS_MASK_GAIN, SET_PARAMS_MASK_PITCH } from "../wire.generated";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import type { ClipInfo, ClipResidentListener, ClipState } from "./clipRegistry";
import type { PlayArgs } from "./commandWriter";
import { Selection } from "./selection";
import { Presence } from "./presence";
import { VoiceReason, VoiceState, VoiceTable } from "./voiceTable";
import { CoreVoices, dryGainBeforeStem, effectiveDryGain, effectivePitch, reportedGain, type CoreVoicesHost } from "./voices";

type Rec = { op: string; id: number; mask?: number; gain?: number; pitch?: number; at?: number; mixed?: boolean; ramp?: number };

function rig() {
  const table = new VoiceTable(8);
  const records: Rec[] = [];
  const clock = { now: 10_000 };
  const states = new Map<number, ClipState>();
  const residents = new Map<number, ClipResidentListener>();
  const refused: [string, number, string][] = [];
  let profile: ProfileSink = NULL_PROFILE_SINK;
  const writer = {
    play: (a: PlayArgs, stamp?: number) => void records.push({ op: "play", id: a.voiceId, gain: a.gain, pitch: a.pitch, at: stamp, mixed: (a.flags & 1) !== 0 }),
    setParams: (id: number, mask: number, gain: number, pitch: number, _x: number, _y: number, _z: number, _lp: number, ramp: number, _bus = 0, _shape = 0, at?: number) =>
      void records.push({ op: "setParams", id, mask, gain, pitch, ramp, at }),
    setMixed: (id: number, mixed: boolean, gain: number) => void records.push({ op: "setMixed", id, mixed, gain }),
    setPaused: (id: number) => void records.push({ op: "setPaused", id }),
    setScore: (id: number) => void records.push({ op: "setScore", id }),
    seek: (id: number) => void records.push({ op: "seek", id }),
    stop: (id: number) => void records.push({ op: "stop", id }),
  };
  const clockMap = {
    get sampleRate() {
      return 48_000;
    },
    framesNow: () => clock.now,
    lookaheadFrames: () => 1_000,
    rampFrames: () => 64,
    frameOfTime: () => 0,
    stampFor: (f: number) => (f > clock.now ? f : undefined),
  };
  const noop = () => {};
  const mixer = new Mixer(defaultAudioSettings());
  const host = {
    table,
    writer,
    clockMap,
    clips: {
      acquire: () => 1,
      release: noop,
      state: (id: number) => states.get(id) ?? "ready",
      info: (id: number): ClipInfo => ({ id, path: "a.wav", state: states.get(id) ?? "ready", refs: 1, frames: 48_000, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null }),
      onResident: (id: number, l: ClipResidentListener) => (residents.set(id, l), noop),
    },
    mixer,
    selection: new Selection(table),
    playheads: { start: noop, retime: noop, anchorFrame: new Float64Array(8) },
    voiceFx: { setLowpass: noop, setHighpass: noop, setAux: noop, setYaw: noop, onPlay: noop, onPromote: noop, onDemote: noop, forget: noop },
    listener: { noteAmbisonicPlay: noop },
    sendCurves: { intern: () => 0 },
    panners: { forget: noop, kindOf: () => 0 },
    doppler: { forget: noop, setVelocity: noop, velX: new Float32Array(8), velY: new Float32Array(8), velZ: new Float32Array(8) },
    occlusion: { forget: noop },
    zones: { forget: noop },
    streams: { allocate: () => 0, register: noop, assetOf: () => "", open: noop, close: noop },
    musicOps: { ownsVoice: () => false, adoptMember: noop, decoratePlay: noop, memberFreed: noop },
    automation: { onPlaySent: noop, forget: noop, loopOf: () => null },
    dip: { dipVoice: () => -1 },
    presence: new Presence(null),
    warnOnce: noop,
    busNames: () => ["Master", "SFX"],
    busIndexByName: () => new Map([["Master", 0], ["SFX", 1]]),
    busRef: (b: number) => 0x100 | b,
    profile: () => profile,
    aac: () => false,
    mixedCap: () => 8,
    maxWide: () => 0,
    session: { maySend: true },
    holdStemResends: () => false,
  } as unknown as CoreVoicesHost;
  const voices = new CoreVoices(host);
  table.onFree = (id, bus) => voices.onFree(id, bus);
  const start = (extra: object = {}) => voices.start({ path: "a.wav", url: "a.wav", loop: true, stream: false, bus: "SFX", ...extra });
  const take = () => records.splice(0);
  return {
    table,
    voices,
    clock,
    states,
    residents,
    refused,
    start,
    take,
    setProfile(p: ProfileSink) {
      profile = p;
    },
  };
}

describe("CoreVoices (ADR 0176)", () => {
  it("a start launches at once on a ready clip: PLAY carries the effective dry gain and pitch, mixed under the cap", () => {
    const r = rig();
    const id = r.start({ volume: 0.5, pitch: 2 });
    expect(id).not.toBe(0);
    expect(r.take()).toEqual([{ op: "play", id, gain: 0.5, pitch: 2, at: undefined, mixed: true }]);
    // The views the replay and Audio.debug() read agree with what was sent.
    expect(effectiveDryGain(r.table, id & 0xffff)).toBe(0.5);
    expect(effectivePitch(r.table, id & 0xffff)).toBe(2);
  });

  it("a clip still loading waits (waitingForData) and launches when resident; a failed clip frees it and reports the refusal", () => {
    const r = rig();
    const voiceRefused = vi.fn();
    r.setProfile({ ...NULL_PROFILE_SINK, voiceRefused });
    r.states.set(1, "fetching");
    const id = r.start();
    expect(r.table.state[id & 0xffff]).toBe(VoiceState.WAITING_FOR_DATA);
    expect(r.take()).toEqual([]);
    r.states.set(1, "ready");
    r.residents.get(1)!(({ state: "ready" }) as ClipInfo);
    expect(r.take().map((x) => x.op)).toEqual(["play"]);
    r.states.set(1, "failed");
    const bad = r.start();
    expect(r.table.isLive(bad)).toBe(false);
    expect(r.table.endedReason(bad)).toBe(VoiceReason.FAILED);
    expect(voiceRefused).toHaveBeenCalledWith("a.wav", 0x101, "loadFailed");
  });

  it("volume, occlusion and a stem's level all reach the one dry gain sent; a virtual voice sends none, a stale id nothing", () => {
    const r = rig();
    const id = r.start({ volume: 0.8 });
    const i = id & 0xffff;
    r.take();
    r.voices.setOcclusion(id, 0.5, 20_000);
    r.voices.setStemLevel(i, 0.25, undefined, r.clock.now, 0, 0);
    r.voices.setVolume(id, 0.4);
    const sent = r.take();
    expect(sent.map((x) => [x.op, x.mask, x.gain])).toEqual([
      ["setParams", SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, Math.fround(0.8) * 0.5],
      ["setParams", SET_PARAMS_MASK_GAIN | SET_PARAMS_MASK_DIR, Math.fround(0.4) * 0.5 * 0.25],
    ]);
    expect(effectiveDryGain(r.table, i)).toBe(sent[1]!.gain);
    expect(dryGainBeforeStem(r.table, i)).toBe(Math.fround(0.4) * 0.5);
    // Debug's view: the audible stem level, no occlusion (its own column).
    expect(reportedGain(r.table, i, 1)).toBe(Math.fround(0.4) * 0.25);
    r.table.state[i] = VoiceState.VIRTUAL;
    r.voices.setVolume(id, 0.3);
    expect(r.take()).toEqual([]);
    r.table.free(id, VoiceReason.NONE);
    r.take();
    r.voices.setVolume(id, 1);
    r.voices.setPitch(id, 1);
    expect(r.take()).toEqual([]);
  });

  it("Doppler folds into the pitch sent, clamped; exactly the pitch at factor 1", () => {
    const r = rig();
    const id = r.start({ pitch: 1.5 });
    const i = id & 0xffff;
    r.take();
    r.voices.setDopplerRate(id, 2);
    r.voices.setDopplerRate(id, 2); // unchanged: nothing
    r.voices.setPitch(id, 10);
    expect(r.take().map((x) => [x.mask, x.pitch])).toEqual([
      [SET_PARAMS_MASK_PITCH, 3],
      [SET_PARAMS_MASK_PITCH, 16],
    ]);
    r.voices.setDopplerRate(id, 1);
    expect(effectivePitch(r.table, i)).toBe(10);
  });

  it("F-9b, F-12: a dry write re-sends the stem changes due within a lookahead; one further out goes once it comes within one, with the dry gain then", () => {
    const r = rig();
    const id = r.start({ volume: 1 });
    const i = id & 0xffff;
    r.take();
    const near = r.clock.now + 500;
    const far = r.clock.now + 5_000;
    r.voices.setStemLevel(i, 0.5, near, r.clock.now, 64, 0);
    r.voices.setStemLevel(i, 0.25, far, r.clock.now, 64, 0);
    r.voices.setVolume(id, 0.8);
    expect(r.take().map((x) => [x.gain, x.at])).toEqual([
      [Math.fround(0.8), undefined],
      [0.5 * Math.fround(0.8), near],
    ]);
    r.voices.setOcclusion(id, 0.5, 20_000); // a later dry write: the far change now carries 0.4
    r.take();
    r.voices.resendStaleStems();
    expect(r.take()).toEqual([]); // not yet within a lookahead
    r.clock.now = far - 900;
    r.voices.resendStaleStems();
    expect(r.take().map((x) => [x.gain, x.at])).toEqual([[0.25 * Math.fround(0.8) * 0.5, far]]);
    r.clock.now = far + 1;
    r.voices.resendStaleStems();
    expect(r.take()).toEqual([]); // sent once: nothing stale is left
  });

  it("a rebuild forgets the stale stem changes (beginRecovery): none is re-sent once within a lookahead; recoveryFailed ends every voice as failed", () => {
    const r = rig();
    const id = r.start();
    const i = id & 0xffff;
    const far = r.clock.now + 5_000;
    r.voices.setStemLevel(i, 0.5, far, r.clock.now, 0, 0);
    r.voices.setVolume(id, 0.5);
    r.voices.beginRecovery();
    r.take();
    r.clock.now = far - 900; // within a lookahead: the stale change would go now (the case above)
    r.voices.resendStaleStems();
    expect(r.take()).toEqual([]);
    r.voices.recoveryFailed();
    expect(r.table.isLive(id)).toBe(false);
    expect(r.table.endedReason(id)).toBe(VoiceReason.FAILED);
  });

  it("a promote's SET_MIXED carries the effective dry gain and re-sends the near stem changes behind it", () => {
    const r = rig();
    const id = r.start({ volume: 0.5 });
    const i = id & 0xffff;
    r.take();
    r.voices.setStemLevel(i, 0.5, undefined, r.clock.now, 0, 0);
    r.voices.setStemLevel(i, 2, r.clock.now + 10, r.clock.now, 0, 0);
    r.voices.selectionSink.setMixed(i, true);
    expect(r.take().map((x) => [x.op, x.gain, x.at])).toEqual([
      ["setMixed", 0.25, undefined],
      ["setParams", 1, r.clock.now + 10],
    ]);
  });
});
