// ADR 0166 T3 (L-T3b, fake backend half): how a change behaves when the music rings refuse it, and when a second change
// arrives during the first. The M4b exit: a never-fits refusal is immediate (dropped, no retry, A plays on) and a
// free-ring refusal (`poolFull`) retries at each allowed point and lands once the rings free. The loopback half (the
// real core, the landing frame) is in `transition.loopback.test.ts`.
//
// Clock: 120 bpm 4/4, A (two streamed stems) stamped at 1.1, so its beats are heard at 1.1, 1.6, 2.1, ... and its bars
// at 1.1, 3.1, 5.1, ...; L (the lookahead) is 1/30 s at 60 Hz.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, MusicSwitchNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart } from "./planner";
import { requestTransition, tickTransition, type Transition } from "./transition";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;

const long = (): MusicClipFacts => ({ frames: 120 * RATE, rate: RATE, channels: 2, gapless: true });

type Raw = Record<string, unknown>;
const seg = (id: string): Raw => ({ type: "segment", id, value: id, tracks: [{ name: "t0", clip: `music/${id}0.ogg` }, { name: "t1", clip: `music/${id}1.ogg` }] });

function root(transitions: Raw[]): MusicSwitchNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root: { type: "musicSwitch", id: "sw", parameter: "zone", children: [seg("A"), seg("B"), seg("C")], transitions } });
  return value.musicRoot as MusicSwitchNode;
}
const child = (r: MusicSwitchNode, id: string): MusicNode => r.children.find((c) => c.id === id)!;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };

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
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => long() });
  at(1);
}

const instance = (): EventInstance =>
  ({ group: 7, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 }, getParameter: () => undefined }) as unknown as EventInstance;

function playing(r: MusicSwitchNode): MusicPlayer {
  const player = createMusicPlayer(instance(), r);
  requestStart(player, { to: child(r, "A"), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, at(1));
  planTick(player, at(1.2));
  expect(player.state).toBe("playing");
  return player;
}

function tick(player: MusicPlayer, now: number): void {
  tickTransition(player, at(now));
  planTick(player, at(now));
}

/** Frames from `from` to `to` inclusive; the incoming group is primed as soon as it is priming. */
function run(player: MusicPlayer, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += DT) {
    const g = player.planned?.status === "priming" ? player.planned.run.group : undefined;
    if (g !== undefined) b.music!.setPrimed(g);
    tick(player, t);
  }
}

/** The playing run's voices untouched: no stop or fade recorded. */
const untouched = (player: MusicPlayer): boolean =>
  player.run!.stems.every((s) => {
    const v = s.voice as unknown as { stopped: boolean; events: { kind: string }[] } | null;
    return v !== null && !v.stopped && !v.events.some((e) => e.kind === "stop" || e.kind === "fade");
  });

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

const rules = [{ from: "*", to: "*", exit: "beat", fadeOut: { beats: 1 }, fadeIn: { beats: 1 } }];

describe("T3: a never-fits refusal is immediate", () => {
  it("B beside the playing A can never fit the pool: refused at the request, nothing admitted, A plays on", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.ringPool = 3; // A holds 2 rings, B needs 2: 4 beside A
    const admitted = b.music!.admitted.length;
    const dropped: string[] = [];
    expect(requestTransition(player, child(r, "B"), at(1.5), { onDropped: (c) => dropped.push(c) })).toBeNull();
    expect(b.music!.admitted.length).toBe(admitted); // refused before the backend is asked
    expect(dropped).toEqual(["refused"]);
    expect(player.counters.refusals.neverFits).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("needs 4 music rings beside the playing segment; this preset has 3");
    expect(player.transition).toBeNull();
    expect(player.planned).toBeNull();
    expect(player.next).toBeNull();
    expect(player.state).toBe("playing");
    expect(untouched(player)).toBe(true);
  });

  it("no retry: later frames never ask again, across several beats, and the counter stays at one", () => {
    rig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.ringPool = 3;
    requestTransition(player, child(r, "B"), at(1.5));
    const admitted = b.music!.admitted.length;
    const primes = b.music!.primes.length;
    run(player, 1.5 + DT, 4);
    expect(b.music!.admitted.length).toBe(admitted);
    expect(b.music!.primes.length).toBe(primes);
    expect(player.counters.refusals.neverFits).toBe(1);
    expect(player.run?.node.id).toBe("A");
    expect(untouched(player)).toBe(true);
  });

  it("a segment that needs more rings than the whole pool is refused the same way (alone, not beside)", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.ringPool = 1; // B alone needs 2
    expect(requestTransition(player, child(r, "B"), at(1.5))).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toContain("needs 2 music rings; this preset has 1");
    expect(player.counters.refusals.neverFits).toBe(1);
    expect(player.state).toBe("playing");
  });

  it("a backend's permanent poolFull answer is dropped at once too (no retry), one warning", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: true };
    expect(requestTransition(player, child(r, "B"), at(1.5))).toBeNull();
    const admitted = b.music!.admitted.length;
    run(player, 1.5 + DT, 3);
    expect(b.music!.admitted.length).toBe(admitted);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(player.run?.node.id).toBe("A");
    expect(untouched(player)).toBe(true);
  });

  it("the music still takes a change that fits afterwards (the dropped one left nothing behind)", () => {
    rig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.ringPool = 3;
    expect(requestTransition(player, child(r, "B"), at(1.5))).toBeNull();
    b.music!.ringPool = 4;
    const t = requestTransition(player, child(r, "C"), at(1.52))!;
    expect(t).not.toBeNull();
    run(player, 1.52 + DT, t.exitAt + 0.01);
    expect(t.state).toBe("done");
    expect(player.run?.node.id).toBe("C");
  });
});

describe("T3: a free-ring (poolFull) refusal retries and lands once rings free", () => {
  it("the request returns the transition, waiting on poolFull, with A untouched and one admit try", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const admitted = b.music!.admitted.length;
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t).not.toBeNull();
    expect(t.state).toBe("pending");
    expect(player.planned?.status).toBe("waiting");
    expect(player.planned?.refusal).toBe("poolFull");
    expect(player.counters.refusals.poolFull).toBe(1);
    expect(b.music!.admitted.length).toBe(admitted + 1);
    expect(player.run?.node.id).toBe("A");
    expect(untouched(player)).toBe(true);
  });

  it("retries at the allowed points while refused, and lands on the beat that finally admits", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    const music = b.music!;
    // Refuse three times (the request and two retries), then the rings are free.
    const admit = music.admitGroup.bind(music);
    let calls = 0;
    music.admitGroup = (req) => (++calls <= 3 ? (music.admitted.push(req), { ok: false, reason: "poolFull", permanent: false }) : admit(req));
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    const first = t.exitAt;
    expect(first).toBeCloseTo(1.6, 9);
    expect(calls).toBe(1);
    run(player, 1.5 + DT, 4);
    expect(calls).toBe(4);
    expect(t.state).toBe("done");
    expect(player.run?.node.id).toBe("B");
    expect(player.counters.refusals.poolFull).toBe(3);
    // It landed on a later beat of A's grid (1.1 + 0.5 k), not the first point it was refused for.
    expect(t.exitAt).toBeGreaterThan(first + 0.4);
    expect(((t.exitAt - 1.1) / 0.5) % 1).toBeCloseTo(0, 6);
    expect(b.music!.stamps.at(-1)!.at).toBeCloseTo(t.exitAt, 9);
    expect(player.anchor?.time).toBeCloseTo(t.exitAt, 9);
  });

  it("A is untouched while refused: no stop, no fade, and nothing but A's own start was stamped", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    requestTransition(player, child(r, "B"), at(1.5));
    run(player, 1.5 + DT, 3);
    expect(player.planned?.status).toBe("waiting");
    expect(untouched(player)).toBe(true);
    expect(player.run?.node.id).toBe("A");
    expect(b.music!.stamps).toHaveLength(1);
  });

  it("rings that free late: the change is asked for again and lands, nothing was dropped", () => {
    rig();
    const r = root(rules);
    const player = playing(r);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    run(player, 1.5 + DT, 5);
    expect(t.state).toBe("pending");
    expect(t.cause).toBeNull();
    b.music!.admitResult = { ok: true };
    run(player, 5 + DT, 8);
    expect(t.state).toBe("done");
    expect(player.run?.node.id).toBe("B");
    expect(player.transition).toBeNull();
  });

  it("a poolFull refusal that turns never-fits (the pool is smaller than thought) is dropped when the retry sees it", () => {
    rig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = root(rules);
    const player = playing(r);
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    b.music!.ringPool = 3;
    b.music!.admitResult = { ok: true };
    run(player, 1.5 + DT, 3);
    expect(t.state).not.toBe("done");
    expect(player.run?.node.id).toBe("A");
    expect(player.planned).toBeNull();
    expect(player.counters.refusals.neverFits).toBe(1);
    expect(untouched(player)).toBe(true);
  });
});

describe("T3: a change requested during another change", () => {
  const bar = [{ from: "*", to: "*", exit: "bar", fadeOut: { beats: 1 }, fadeIn: { beats: 1 } }];
  type T = NonNullable<ReturnType<typeof requestTransition>>;
  /** A to B stamped (T = 3.1, cancel point T - L); frames run to `until`. */
  function stamped(until: number): { r: MusicSwitchNode; player: MusicPlayer; t: Transition & T } {
    rig();
    const r = root(bar);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    b.music!.setPrimed(t.incoming!.run.group);
    run(player, 1.6, until);
    return { r, player, t };
  }

  it("before T - L the newer target replaces it: B's group closed, A untouched, C takes the next point it can reach", () => {
    const { r, player, t } = stamped(3.1 - L - 3 * DT);
    expect(t.state).toBe("stamped");
    const bGroup = t.incoming!.run.group;
    const q = requestTransition(player, child(r, "C"), at(t.cancelBy - 1e-3))!;
    expect(t.state).toBe("cancelled");
    expect(b.music!.cancelled).toContain(bGroup);
    expect(t.after).toBeNull();
    expect(player.transition).toBe(q);
    // 3.1 is under the prime lead from now (about 3.05): C's point is the bar after it.
    expect(q.exitAt).toBeCloseTo(5.1, 9);
    expect(untouched(player)).toBe(true);
    run(player, t.cancelBy, 5.2);
    expect(q.state).toBe("done");
    expect(player.run?.node.id).toBe("C");
  });

  it("a change still unprimed (pending) is replaceable", () => {
    rig();
    const r = root(bar);
    const player = playing(r);
    const t = requestTransition(player, child(r, "B"), at(1.5))!;
    expect(t.state).toBe("pending");
    const q = requestTransition(player, child(r, "C"), at(3.0))!;
    expect(t.state).toBe("cancelled");
    expect(player.transition).toBe(q);
    expect(untouched(player)).toBe(true);
  });

  it("from T - L on (committed) the newer target is queued behind it, and the first still lands on its point", () => {
    const { r, player, t } = stamped(3.1 - L - DT + 1e-6);
    expect(t.state).toBe("running");
    const q = requestTransition(player, child(r, "C"), at(3.1 - L - DT + 0.002))!;
    expect(q).not.toBe(t);
    expect(t.state).toBe("running");
    expect(t.after).toBe(q);
    expect(player.transition).toBe(t);
    expect(q.state).toBe("pending");
    expect(Number.isNaN(q.exitAt)).toBe(true); // planned from B when A to B lands
    expect(b.music!.cancelled).not.toContain(t.incoming!.run.group);
    run(player, 3.1 - L - DT + 0.004, 3.1 + 0.005);
    expect(t.state).toBe("done");
    expect(player.run?.node.id).toBe("B");
    expect(player.transition).toBe(q);
    expect(q.exitAt).toBeCloseTo(5.1, 9); // B's next bar
    run(player, 3.12, 5.2);
    expect(q.state).toBe("done");
    expect(player.run?.node.id).toBe("C");
  });

  it("queued behind a committed change, the latest ask wins; asking for the committed target drops the queue", () => {
    const { r, player, t } = stamped(3.1 - L - DT + 1e-6);
    const q1 = requestTransition(player, child(r, "C"), at(3.07))!;
    const q2 = requestTransition(player, child(r, "A"), at(3.08))!;
    expect(q1.state).toBe("cancelled");
    expect(t.after).toBe(q2);
    expect(requestTransition(player, child(r, "B"), at(3.09))).toBe(t);
    expect(t.after).toBeNull();
    expect(q2.state).toBe("cancelled");
  });
});
