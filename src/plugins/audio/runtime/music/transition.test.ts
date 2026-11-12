// ADR 0166 R3a: transition execution on the fake backend (`testing.ts` `FakeMusicBackend`): planning and timing. The
// clock is deterministic (each frame sets `now` and the horizon now + L, L = 33.3 ms at 60 Hz) and the test says when a
// group is primed. The fake's voices get a recording `fadeShaped` (the core's member), so the outgoing fade shows.
//
// Clock: 120 bpm 4/4 (a beat 0.5 s, a bar 2 s). The first segment A (two streamed stems, no pickup) is stamped at 1.1
// (now 1 + the 100 ms first lead), so its bars are heard at 1.1, 3.1, 5.1, ...
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend, type AudioVoice, type ShapedFade } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, MusicSwitchNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart } from "./planner";
import { tickPlaylist } from "./playlist";
import { cancelTransition, planImmediate, requestTransition, tickTransition, type Transition } from "./transition";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;

const long = (): MusicClipFacts => ({ frames: 120 * RATE, rate: RATE, channels: 2, gapless: true });

type Raw = Record<string, unknown>;
const seg = (id: string, extra: Raw = {}): Raw => ({ type: "segment", id, value: id, tracks: [{ name: "t0", clip: `music/${id}0.ogg` }, { name: "t1", clip: `music/${id}1.ogg` }], ...extra });

/** A musicSwitch root over A, B, C (or `children`) with `transitions`. */
function root(transitions: Raw[] = [], children: Raw[] = [seg("A"), seg("B"), seg("C")]): MusicSwitchNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root: { type: "musicSwitch", id: "sw", parameter: "zone", children, transitions } });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot as MusicSwitchNode;
}
const child = (r: MusicSwitchNode, id: string): MusicNode => r.children.find((c) => c.id === id)!;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };
/** Every `fadeShaped` a voice got, with the voice. */
let fades: { voice: AudioVoice; fade: ShapedFade }[] = [];

function at(now: number): MusicFrame {
  f.now = now;
  (b as { time: number }).time = now;
  b.horizonTime = now + L;
  return f as unknown as MusicFrame;
}

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  f.backend = b;
  f.music = b.music ?? null;
  fades = [];
  const play = b.play.bind(b);
  b.play = (req) => {
    const v = play(req);
    if (v) v.fadeShaped = (fade) => void fades.push({ voice: v, fade });
    return v;
  };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => long() });
  at(1);
}

const instance = (): EventInstance =>
  ({ group: 7, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 }, getParameter: () => undefined }) as unknown as EventInstance;

/** A player over `r` whose first segment A plays from 1.1 (stamped from now 1). */
function playing(r: MusicSwitchNode): MusicPlayer {
  const player = createMusicPlayer(instance(), r);
  requestStart(player, { to: child(r, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, at(1));
  expect(player.run?.node.id).toBe("A");
  planTick(player, at(1.2));
  expect(player.state).toBe("playing");
  return player;
}

/** One frame of the player's transition and planner (the order of `tickPlayer`). */
function tick(player: MusicPlayer, now: number): void {
  tickTransition(player, at(now));
  planTick(player, at(now));
}

/** Prime the transition's incoming group and run frames from `from` to `to` (inclusive, by DT). */
function runFrames(player: MusicPlayer, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += DT) tick(player, t);
}

const voicesOf = (player: MusicPlayer, id: string): AudioVoice[] => {
  const run = player.run?.node.id === id ? player.run : player.next?.node.id === id ? player.next : null;
  return (run?.stems ?? []).map((s) => s.voice!).filter(Boolean);
};

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("R3a: a quantised crossfade", () => {
  it("stamps the incoming on the bar with a silent start and an equal-power fade-in, fades the outgoing at the cancel point, lands at T", () => {
    rig();
    const r = root([{ from: "A", to: "B", exit: "bar", fadeOut: { beats: 1 }, fadeIn: { beats: 1 } }]);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t).not.toBeNull();
    expect(t.state).toBe("pending");
    expect(t.match.ruleKey).toBe("A>B");
    expect(t.exitAt).toBeCloseTo(3.1, 9);
    expect(player.transition).toBe(t);
    expect(player.state).toBe("pending");

    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.6);
    expect(t.state).toBe("stamped");
    expect(player.state).toBe("transitioning");
    const stamp = b.music!.stamps.at(-1)!;
    expect(stamp.at).toBeCloseTo(3.1, 9);
    // Per member: silent from the first sample, then the fade-in from T over one beat.
    expect(stamp.fades).toEqual([
      { member: 0, fade: { to: 0, seconds: 0, law: "linear", at: stamp.at } },
      { member: 0, fade: { to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(3.1, 9) } },
      { member: 1, fade: { to: 0, seconds: 0, law: "linear", at: stamp.at } },
      { member: 1, fade: { to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(3.1, 9) } },
    ]);
    // The cancel point is T - L; the outgoing is untouched until the last frame before it.
    expect(t.cancelBy).toBeCloseTo(3.1 - L, 9);
    const aVoices = voicesOf(player, "A");
    runFrames(player, 1.6 + DT, 3.1 - L - DT - 1e-3);
    expect(fades).toEqual([]);
    tick(player, 3.1 - L - DT + 1e-6);
    expect(t.state).toBe("running");
    expect(fades.map((x) => x.voice)).toEqual(aVoices);
    for (const x of fades) expect(x.fade).toEqual({ to: 0, seconds: expect.closeTo(0.5, 9), law: "equalPowerOut", at: expect.closeTo(3.1, 9), stopAtEnd: true });

    // Lands at T: B plays (anchored at its stamp), A rings out as the next run, no pending change.
    tick(player, 3.1 - 1e-3);
    expect(player.run?.node.id).toBe("A");
    tick(player, 3.1);
    expect(t.state).toBe("done");
    expect(player.transition).toBeNull();
    expect(player.state).toBe("playing");
    expect(player.run?.node.id).toBe("B");
    expect(player.anchor?.segment).toBe("B");
    expect(player.anchor?.time).toBeCloseTo(3.1, 9);
    expect(player.next?.node.id).toBe("A");
    // Once A's voices end it leaves.
    for (const v of aVoices) (v as unknown as { end(): void }).end();
    tick(player, 3.7);
    expect(player.next).toBeNull();
  });

  it("a cut (0-second fades) stamps no fades on the incoming and a 0-second stop on the outgoing at T", () => {
    rig();
    const r = root([{ from: "A", to: "B", exit: "beat", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } }]);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.exitAt).toBeCloseTo(1.6, 9);
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.5);
    expect(b.music!.stamps.at(-1)).toEqual({ group: t.incoming!.run.group, at: expect.closeTo(1.6, 9) });
    // Cancel point 1.6 - L ≈ 1.567: still open while now + Δ̄ is before it, committed in the frame that reaches it.
    expect(t.state).toBe("stamped");
    tick(player, 1.5 + 2 * DT);
    expect(fades).toEqual([]);
    tick(player, 1.5 + 3 * DT);
    expect(t.state).toBe("running");
    expect(fades).toHaveLength(2);
    for (const x of fades) expect(x.fade).toEqual({ to: 0, seconds: 0, law: "equalPowerOut", at: expect.closeTo(1.6, 9), stopAtEnd: true });
  });

  it("an incoming pickup starts at T - preEntry, silent until its fade-in at T; a negative fade-in offset opens it from its phase there", () => {
    rig();
    const r = root(
      [
        { from: "A", to: "B", exit: "bar", fadeIn: { beats: 1 } },
        { from: "A", to: "C", exit: "bar", fadeIn: { beats: 2, offset: -2 } },
      ],
      [seg("A"), seg("B", { gridOffset: 0.5 }), seg("C", { gridOffset: 0.5 })],
    );
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.incoming!.at).toBeCloseTo(2.6, 9);
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.6);
    const fb = b.music!.stamps.at(-1)!.fades!;
    expect(fb[0]!.fade).toEqual({ to: 0, seconds: 0, law: "linear", at: expect.closeTo(2.6, 9) });
    expect(fb[1]!.fade).toMatchObject({ to: 1, at: expect.closeTo(3.1, 9), law: "equalPowerIn" });

    // C: the fade-in starts a beat before the 0.5 s pickup does, so it opens at the group start half way through.
    const tc = requestTransition(player, child(r, "C"), at(1.7))!;
    expect(b.music!.cancelled).toContain(t.incoming!.run.group);
    b.music!.setPrimed(tc.incoming!.run.group);
    tick(player, 1.7);
    const fc = b.music!.stamps.at(-1)!.fades!;
    expect(fc[1]!.fade).toEqual({ to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(2.6, 9), startPhase: expect.closeTo(0.5, 9) });
  });

  it("an exit at the exit cue leaves the outgoing's post-exit tail ringing, unfaded", () => {
    rig();
    const r = root([{ from: "A", to: "B", exit: "exitCue" }], [seg("A", { cues: [{ name: "out", at: "2:1:0" }], exit: "out" }), seg("B")]);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.exitAt).toBeCloseTo(3.1, 9);
    b.music!.setPrimed(t.incoming!.run.group);
    runFrames(player, 1.6, 3.1);
    expect(t.state).toBe("done");
    expect(fades).toEqual([]);
    expect(player.run?.node.id).toBe("B");
    expect(player.next?.node.id).toBe("A"); // still sounding: the tail
  });

  it("a point past a counted loop's wrap is asked again in the next pass", () => {
    rig();
    // A loops bar 1 twice, exit cue at 3:1: heard at 1.1 + 2 (bar 1 again) + 4 = 7.1.
    const r = root([{ from: "A", to: "B", exit: "exitCue" }], [seg("A", { cues: [{ name: "out", at: "3:1:0" }], exit: "out", regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 2 }] }), seg("B")]);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.exitAt).toBeCloseTo(7.1, 9);
    // A forever loop never reaches its exit cue: refused, the music plays on.
    rig();
    const r2 = root([{ from: "A", to: "B", exit: "exitCue" }], [seg("A", { cues: [{ name: "out", at: "3:1:0" }], exit: "out", regions: [{ id: "r", from: "1:1:0", to: "2:1:0", count: 0 }] }), seg("B")]);
    const p2 = playing(r2);
    expect(requestTransition(p2, child(r2, "B"), at(1.5))).toBeNull();
    expect(p2.transition).toBeNull();
    expect(p2.state).toBe("playing");
  });
});

describe("R3a: replace, queue and cancel", () => {
  const rules = [{ exit: "bar", fadeOut: { beats: 1 }, fadeIn: { beats: 1 } }];

  it("the same target returns the open transition; a newer target replaces a stamped one before T - L (rings closed, outgoing untouched)", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(requestTransition(player, child(r, "B"), at(1.6))).toBe(t);
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.6);
    expect(t.state).toBe("stamped");
    const tc = requestTransition(player, child(r, "C"), at(2.5))!;
    expect(t.state).toBe("cancelled");
    expect(b.music!.cancelled).toContain(t.incoming!.run.group);
    expect(player.transition).toBe(tc);
    expect(tc.exitAt).toBeCloseTo(3.1, 9);
    expect(fades).toEqual([]);
  });

  it("after the cancel point a newer target is queued and planned from the incoming segment when the change lands", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    b.music!.setPrimed(t.incoming!.run.group);
    runFrames(player, 1.6, 3.1 - L - DT + 1e-6);
    expect(t.state).toBe("running");
    const q = requestTransition(player, child(r, "C"), at(3.08))!;
    expect(q).not.toBe(t);
    expect(t.after).toBe(q);
    expect(player.transition).toBe(t);
    // cancelTransition after the cancel point: the committed change stays, the queued one goes.
    cancelTransition(player, at(3.08));
    expect(t.state).toBe("running");
    expect(t.after).toBeNull();
    expect(q.state).toBe("cancelled");
    // Queue again; it is planned when B lands, matched from B, on B's next bar (5.1).
    const q2 = requestTransition(player, child(r, "C"), at(3.09))!;
    tick(player, 3.1);
    expect(player.run?.node.id).toBe("B");
    expect(player.transition).toBe(q2);
    expect(q2.match.ruleKey).toBe("*>*");
    expect(q2.state).toBe("pending");
    expect(q2.exitAt).toBeCloseTo(5.1, 9);
  });

  it("cancelTransition before the cancel point drops the change; the music plays on", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    cancelTransition(player, at(1.55));
    expect(t.state).toBe("cancelled");
    expect(player.transition).toBeNull();
    expect(player.planned).toBeNull();
    expect(player.state).toBe("playing");
    expect(b.music!.cancelled).toContain(t.incoming!.run.group);
  });

  it("a permanent refusal returns null and keeps the playing segment; a temporary one keeps the transition for the planner's retry", () => {
    rig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: true };
    expect(requestTransition(player, child(r, "B"), at(1.5))).toBeNull();
    expect(player.transition).toBeNull();
    expect(player.run?.node.id).toBe("A");
    expect(player.state).toBe("playing");
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const t = requestTransition(player, child(r, "C"), at(1.5))!;
    expect(t).not.toBeNull();
    expect(player.planned?.status).toBe("waiting");
    expect(player.counters.refusals.poolFull).toBeGreaterThan(0);
  });

  it("handle.stop drops an uncommitted change", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    const t: Transition = requestTransition(player, child(r, "B"), at(1.5))!;
    player.state = "stopping";
    tickTransition(player, at(1.6));
    expect(t.state).toBe("cancelled");
    expect(player.transition).toBeNull();
  });
});

describe("R3a: planImmediate (H5)", () => {
  it("starts at now + lead from the given frame with an equal-power crossfade on both sides at T", () => {
    rig();
    const r = root([{ exit: "bar" }]);
    const player = playing(r);
    const t = planImmediate(player, child(r, "A"), 96_000, 5, at(2))!;
    expect(t.state).toBe("pending");
    const p = t.incoming!;
    // Streamed: lead 1.25 x 40 ms + L + Δ̄ = 100 ms, and an asap start's frame of slack (Δ̄, F-25).
    const T = 2.1 + DT;
    expect(p.at).toBeCloseTo(T, 9);
    expect(p.run.startFrame).toBe(96_000);
    expect(b.music!.admitted.at(-1)!.members[0]!.startFrame).toBe(96_000);
    b.music!.setPrimed(p.run.group);
    tick(player, 2.02);
    const stamp = b.music!.stamps.at(-1)!;
    expect(stamp.at).toBeCloseTo(T, 9);
    expect(stamp.fades![1]!.fade).toEqual({ to: 1, seconds: 0.005, law: "equalPowerIn", at: expect.closeTo(T, 9) });
    runFrames(player, 2.02 + DT, T - DT);
    tick(player, T);
    for (const x of fades) expect(x.fade).toEqual({ to: 0, seconds: 0.005, law: "equalPowerOut", at: expect.closeTo(T, 9), stopAtEnd: true });
    expect(fades).toHaveLength(2);
    expect(player.run?.startFrame).toBe(96_000);
    expect(player.transition).toBeNull();
  });

  it("is null when nothing plays", () => {
    rig();
    const r = root();
    const player = createMusicPlayer(instance(), r);
    expect(planImmediate(player, child(r, "A"), 0, 5, at(1))).toBeNull();
    expect(requestTransition(player, child(r, "A"), at(1))).toBeNull();
  });
});

// --- R3b ----------------------------------------------------------------------------------------------------------------

/** Clips whose name `short` picks are 10 s (decoded, no ring); the rest 120 s (streamed). */
function clipFacts(short: (clip: string) => boolean): void {
  setSegmentClipSource({
    url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master",
    facts: (clip) => (short(clip) ? { frames: 10 * RATE, rate: RATE, channels: 2, gapless: true } : long()),
  });
}

/** The bridge R: its exit cue at bar 2 (2 s after its start). */
const bridgeSeg = (): Raw => ({ type: "segment", id: "R", tracks: [{ name: "t0", clip: "music/R0.ogg" }, { name: "t1", clip: "music/R1.ogg" }], cues: [{ name: "out", at: "2:1:0" }], exit: "out" });

/** A switch over A, B, C with a library holding R and the rule A to B through R. */
function bridged(rule: Raw = {}): MusicSwitchNode {
  const { value } = parseAudioEvent({
    format: "myco.audioevent@1", bus: "Music",
    root: {
      type: "musicSwitch", id: "sw", parameter: "zone", children: [seg("A"), seg("B"), seg("C")], library: [bridgeSeg()],
      transitions: [{ from: "A", to: "B", exit: "bar", fadeOut: { beats: 1 }, fadeIn: { beats: 1 }, bridge: { segment: "R", fadeOut: { beats: 2 } }, ...rule }],
    },
  });
  return value.musicRoot as MusicSwitchNode;
}

describe("R3b: bridges", () => {
  it("A → bridge → B: the bridge on A's bar with the rule's fades, B on the bridge's exit cue with the bridge leg's fades", () => {
    rig(); // every stem streamed (the fake only plays the voices of a group it was asked to prime)
    const r = bridged();
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.state).toBe("pending");
    expect(t.bridge?.run.node.id).toBe("R");
    expect(t.bridge?.point).toBeCloseTo(3.1, 9);
    expect(t.incoming).toBeNull();
    expect(t.exitAt).toBeCloseTo(3.1, 9);

    // The bridge primed: stamped with a silent start and the rule's 1-beat fade-in; B is asked.
    b.music!.setPrimed(t.bridge!.run.group);
    tick(player, 1.6);
    expect(t.state).toBe("stamped");
    const rs = b.music!.stamps.at(-1)!;
    expect(rs.group).toBe(t.bridge!.run.group);
    expect(rs.fades![1]!.fade).toEqual({ to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(3.1, 9) });
    expect(t.incoming?.run.node.id).toBe("B");
    expect(t.incoming?.point).toBeCloseTo(5.1, 9);
    expect(t.cancelBy).toBeCloseTo(3.1 - L, 9);

    // B primed: stamped at the bridge's exit cue, silent, then the rule's fade-in (the bridge sets none).
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.7);
    const bs = b.music!.stamps.at(-1)!;
    expect(bs.group).toBe(t.incoming!.run.group);
    expect(bs.at).toBeCloseTo(5.1, 9);
    expect(bs.fades![1]!.fade).toEqual({ to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(5.1, 9) });

    // Leg 1's cancel point: A fades out over the rule's beat at T1.
    const aVoices = voicesOf(player, "A");
    runFrames(player, 1.7 + DT, 3.1 - L - DT + 1e-6);
    expect(t.state).toBe("running");
    expect(fades.map((x) => x.voice)).toEqual(aVoices);
    for (const x of fades) expect(x.fade).toEqual({ to: 0, seconds: expect.closeTo(0.5, 9), law: "equalPowerOut", at: expect.closeTo(3.1, 9), stopAtEnd: true });

    // T1: the bridge plays; the transition is bridging toward T2.
    tick(player, 3.1);
    expect(t.state).toBe("bridging");
    expect(player.run?.node.id).toBe("R");
    expect(player.anchor?.segment).toBe("R");
    expect(player.state).toBe("transitioning");
    expect(t.exitAt).toBeCloseTo(5.1, 9);
    expect(player.transition).toBe(t);

    // Leg 2's cancel point: the bridge fades out over its own 2 beats (1 s) at T2.
    fades = [];
    const rVoices = player.run!.stems.map((s) => s.voice!);
    runFrames(player, 3.1 + DT, 5.1 - L - DT + 1e-6);
    expect(fades.map((x) => x.voice)).toEqual(rVoices);
    for (const x of fades) expect(x.fade).toEqual({ to: 0, seconds: expect.closeTo(1, 9), law: "equalPowerOut", at: expect.closeTo(5.1, 9), stopAtEnd: true });

    tick(player, 5.1);
    expect(t.state).toBe("done");
    expect(player.transition).toBeNull();
    expect(player.state).toBe("playing");
    expect(player.run?.node.id).toBe("B");
    expect(player.next?.node.id).toBe("R");
  });

  it("before the cancel point a newer target replaces it: the bridge's group and B's plan are cancelled, A untouched", () => {
    rig();
    clipFacts((c) => c.includes("/R"));
    const r = bridged();
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    tick(player, 1.6);
    const bridgeGroup = t.bridge!.run.group;
    const bGroup = t.incoming!.run.group;
    const tc = requestTransition(player, child(r, "C"), at(2))!;
    expect(t.state).toBe("cancelled");
    expect(b.music!.cancelled).toEqual(expect.arrayContaining([bridgeGroup, bGroup]));
    expect(player.transition).toBe(tc);
    expect(tc.bridge).toBeNull();
    expect(fades).toEqual([]);
  });

  it("pool full keeps A: B still refused at the bridge's cancel point drops the change with one warning", () => {
    rig();
    clipFacts((c) => c.includes("/R"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = bridged();
    const player = playing(r);
    const causes: string[] = [];
    const t = requestTransition(player, child(r, "B"), at(1.5), { onDropped: (c) => causes.push(c) })!;
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    tick(player, 1.6);
    expect(t.state).toBe("stamped");
    expect(player.planned?.status).toBe("waiting");
    runFrames(player, 1.6 + DT, 3.1 - L - DT + 1e-6);
    expect(t.state).toBe("cancelled");
    expect(t.cause).toBe("poolFull");
    expect(causes).toEqual(["poolFull"]);
    expect(b.music!.cancelled).toContain(t.bridge!.run.group);
    expect(player.planned).toBeNull();
    expect(player.transition).toBeNull();
    expect(player.run?.node.id).toBe("A");
    expect(player.state).toBe("playing");
    expect(fades).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("pool full"))).toHaveLength(1);
    runFrames(player, 3.1 - L, 3.3);
    expect(player.run?.node.id).toBe("A");
  });

  it("a permanent refusal of B drops the change as soon as the bridge is stamped; A plays on", () => {
    rig();
    clipFacts((c) => c.includes("/R"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = bridged();
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: true };
    tick(player, 1.6);
    expect(t.state).toBe("cancelled");
    expect(t.cause).toBe("refused");
    expect(b.music!.cancelled).toContain(t.bridge!.run.group);
    expect(player.run?.node.id).toBe("A");
    expect(player.state).toBe("playing");
  });

  it("a streamed bridge with room for B once A's rings return commits, and asks for B when A's voices end", () => {
    rig();
    clipFacts(() => false); // everything streamed: A 2 rings, R 2, B 2, in a pool of 4
    vi.spyOn(console, "warn").mockImplementation(() => {});
    b.music!.ringPool = 4;
    const r = bridged();
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.bridge?.point).toBeCloseTo(3.1, 9);
    b.music!.setPrimed(t.bridge!.run.group);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    tick(player, 1.6);
    expect(player.planned?.status).toBe("waiting");
    runFrames(player, 1.6 + DT, 3.1 - L - DT + 1e-6);
    expect(t.state).toBe("running"); // A's fade (over at 3.6) + a STATUS + B's 100 ms lead fit before B's 5.1
    expect(fades).toHaveLength(2);
    runFrames(player, 3.1 - L, 3.7);
    expect(t.state).toBe("bridging");
    b.music!.admitResult = { ok: true };
    for (const v of t.outgoing!.stems) (v.voice as unknown as { end(): void }).end();
    tick(player, 3.7 + DT);
    expect(player.planned?.status).toBe("priming");
    expect(t.incoming?.point).toBeCloseTo(5.1, 9);
    b.music!.setPrimed(t.incoming!.run.group);
    runFrames(player, 3.7 + 2 * DT, 5.1);
    expect(t.state).toBe("done");
    expect(player.run?.node.id).toBe("B");
  });

  it("a streamed bridge too short for B to prime after A's rings return is refused (the degrade): A plays on", () => {
    rig();
    clipFacts(() => false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    b.music!.ringPool = 4;
    // A 4-beat fade-out: A's rings come back at 5.1, B's start.
    const r = bridged({ fadeOut: { beats: 4 } });
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    b.music!.setPrimed(t.bridge!.run.group);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    tick(player, 1.6);
    runFrames(player, 1.6 + DT, 3.1 - L - DT + 1e-6);
    expect(t.state).toBe("cancelled");
    expect(t.cause).toBe("poolFull");
    expect(player.run?.node.id).toBe("A");
  });
});

describe("R3b: target resolution and natural advances", () => {
  it("a playlist target starts the item its order picks first (P4's enterPlaylist)", () => {
    rig();
    const r = root([], [seg("A"), { type: "playlist", id: "P", value: "P", children: [seg("C"), seg("D")] }]);
    const player = playing(r);
    const t = requestTransition(player, child(r, "P"), at(1.5))!;
    expect(t.incoming?.run.node.id).toBe("C");
    expect(t.match.ruleKey).toBe("*>*");
  });

  /** A playlist root over A and B (exit cues at bar 2) with `transitions`; frames prime every group. */
  function playlistRun(transitions: Raw[]) {
    const short = (id: string): Raw => ({ ...seg(id), cues: [{ name: "out", at: "2:1:0" }], exit: "out" });
    const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root: { type: "playlist", id: "p", mode: "sequence", children: [short("A"), short("B")], transitions } });
    const player = createMusicPlayer(instance(), value.musicRoot as MusicNode);
    for (let now = 1; now <= 4; now += DT) {
      for (const a of b.music!.admitted) b.music!.setPrimed(a.group);
      tickPlaylist(player, at(now));
      tickTransition(player, at(now));
      planTick(player, at(now));
    }
    const stampOf = (id: string) => {
      const g = b.music!.admitted.find((a) => a.members[0]!.play.path === `music/${id}0.ogg`)!.group;
      return b.music!.stamps.find((s) => s.group === g)!;
    };
    return { player, stampOf };
  }

  it("a natural advance goes through the transition and applies the rule's fade-in at the exit cue", () => {
    rig();
    const { player, stampOf } = playlistRun([{ from: "A", to: "B", exit: "beat", fadeIn: { beats: 1, curve: "linear" } }]);
    const a = stampOf("A"), s = stampOf("B");
    expect(s.at).toBeCloseTo(a.at + 2, 9); // A's exit cue (the rule's beat exit is ignored)
    expect(s.fades![0]!.fade).toEqual({ to: 0, seconds: 0, law: "linear", at: s.at });
    expect(s.fades![1]!.fade).toEqual({ to: 1, seconds: expect.closeTo(0.5, 9), law: "linear", at: expect.closeTo(s.at, 9) });
    expect(fades).toEqual([]); // at the exit cue A's tail rings on, unfaded
    expect(player.run?.node.id).toBe("B");
    expect(player.playlist?.current?.id).toBe("B");
  });

  it("with no rule written (the default rule) a natural advance stays gapless: no fades either side", () => {
    rig();
    const { player, stampOf } = playlistRun([]);
    expect(stampOf("B").fades).toBeUndefined();
    expect(fades).toEqual([]);
    expect(player.run?.node.id).toBe("B");
  });
});
