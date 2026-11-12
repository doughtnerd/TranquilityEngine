// ADR 0166 P2: the planner on the fake backend (`testing.ts` `FakeMusicBackend`) with a deterministic clock: each frame
// sets `now` and the fake's horizon (now + L, L = 33.3 ms: 60 Hz), and the test says when a group is primed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";
import {
  cancelPlanned, frameIntervalSeconds, lookaheadSeconds, planTick, primeLeadSeconds, REPLAN_STORM, requestStart, type PlanRequest,
} from "./planner";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;

const FACTS: Record<string, MusicClipFacts> = {
  "music/a1.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/a2.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/b1.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/b2.ogg": { frames: 120 * RATE, rate: RATE, channels: 2, gapless: true },
  "music/short.ogg": { frames: 10 * RATE, rate: RATE, channels: 2, gapless: true },
};

function segment(id: string, clips: string[], gridOffset = 0): SegmentNode {
  const tracks = clips.map((clip, k) => ({ name: `t${k}`, clip }));
  const node = parseSegmentNode({ type: "segment", id, gridOffset, tracks }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

let groupIds = 7;
const instance = (): EventInstance =>
  ({ group: groupIds++, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 } }) as unknown as EventInstance;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };

/** Set the clock to `now`: Audio.time and the horizon (now + L). */
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
  setSegmentClipSource({ url: (p) => `/assets/${p}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: (p) => FACTS[p] });
  at(1);
}

/** A player whose first segment A (two streamed stems) is stamped at `stampAt`-ish and playing. */
function playingPlayer(): MusicPlayer {
  const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg", "music/a2.ogg"]));
  planTick(player, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, at(1 + DT));
  expect(player.state).toBe("committed");
  planTick(player, at(1.2));
  expect(player.state).toBe("playing");
  return player;
}

/** Bars every 0.5 s on the heard clock. */
const bars = (nb: number): number => Math.ceil(nb / 0.5 - 1e-9) * 0.5;

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("planner: the lead (ADR 0167 §1.2)", () => {
  it("is 1.25 Ê + L + Δ̄ for an unprimed group and L for a decoded or primed one: 100 ms and 33.3 ms at 60 Hz", () => {
    expect(primeLeadSeconds(40, L, DT, true)).toBeCloseTo(0.1, 12);
    expect(primeLeadSeconds(40, L, DT, false)).toBeCloseTo(L, 12);
    expect(primeLeadSeconds(80, L, DT, true)).toBeCloseTo(0.15, 12);
  });

  it("reads L from the horizon and Δ̄ as L / 2 (or the backend's frameInterval)", () => {
    rig();
    expect(lookaheadSeconds(at(5))).toBeCloseTo(L, 12);
    expect(frameIntervalSeconds(at(5))).toBeCloseTo(DT, 12);
    b.frameIntervalSeconds = 1 / 144;
    expect(frameIntervalSeconds(at(5))).toBeCloseTo(1 / 144, 12);
    b.horizonTime = null;
    expect(lookaheadSeconds(f as unknown as MusicFrame)).toBeCloseTo(L, 12);
  });
});

describe("planner: the first segment", () => {
  it("starts at now + lead, anchors there, stamps when primed and becomes the player's run", () => {
    rig();
    const node = segment("A", ["music/a1.ogg", "music/short.ogg"], 0.5);
    const player = createMusicPlayer(instance(), node);
    planTick(player, at(1));
    const p = player.planned!;
    expect(p.status).toBe("priming");
    expect(p.leadSeconds).toBeCloseTo(0.1, 9);
    expect(p.at).toBeCloseTo(1.1, 9); // the 0.5 s pickup plays from now + lead; the entry is heard at 1.6
    expect(p.point).toBeCloseTo(1.6, 9);
    expect(player.counters.leadMs).toBeCloseTo(100, 6);
    expect(b.music!.primes).toHaveLength(1);

    planTick(player, at(1 + DT)); // not primed, deadline not reached
    expect(b.music!.stamps).toHaveLength(0);
    b.music!.setPrimed(p.run.group);
    planTick(player, at(1 + 2 * DT));
    expect(b.music!.stamps).toEqual([{ group: p.run.group, at: p.at }]);
    expect(player.planned).toBeNull();
    expect(player.run).toBe(p.run);
    expect(player.anchor?.time).toBeCloseTo(1.1, 9);
    expect(player.state).toBe("committed");
    planTick(player, at(1.11));
    expect(player.state).toBe("playing");
  });

  it("an all-decoded segment needs only L and stamps in the same frame", () => {
    rig();
    const player = createMusicPlayer(instance(), segment("A", ["music/short.ogg"]));
    planTick(player, at(2));
    expect(b.music!.primes).toHaveLength(0);
    expect(b.music!.stamps).toHaveLength(1);
    expect(b.music!.stamps[0]!.at).toBeCloseTo(2 + L, 9);
  });

  it("Audio.play's at inside the lead starts at now + lead with one warning; a later at is kept", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const near = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"]), { at: 1.05 });
    planTick(near, at(1));
    expect(near.planned!.at).toBeCloseTo(1.1, 9);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("closer than the prime lead");

    const far = createMusicPlayer(instance(), segment("B", ["music/b1.ogg"]), { at: 3 });
    planTick(far, at(1));
    expect(far.planned!.at).toBeCloseTo(3, 9);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a first start whose prime takes 400 ms stamps once, at prime-ready + L, with no re-plan and no warning", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"], 0.5));
    planTick(player, at(1));
    const p = player.planned!;
    expect(p.at).toBeCloseTo(1.1, 9);
    // A cold first prime: 400 ms of frames pass the planned start, with no deadline to miss.
    for (let t = 1 + DT; t < 1.4; t += DT) planTick(player, at(t));
    expect(b.music!.stamps).toHaveLength(0);
    expect(b.music!.cancelled).toHaveLength(0); // the rings keep priming
    b.music!.setPrimed(p.run.group);
    planTick(player, at(1.4));
    expect(b.music!.stamps).toHaveLength(1);
    expect(b.music!.stamps[0]!.at).toBeCloseTo(1.4 + L, 9);
    expect(p.point).toBeCloseTo(1.4 + L + 0.5, 9); // the entry, after the pickup
    expect(player.anchor?.time).toBeDefined();
    expect(p.replans).toBe(0);
    expect(player.counters.replans).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(player.state).toBe("committed");
    for (let t = 1.4 + DT; t < 1.6; t += DT) planTick(player, at(t));
    expect(b.music!.stamps).toHaveLength(1);
  });

  it("a first start primed in time keeps its planned start (a later Audio.play at included)", () => {
    rig();
    const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"]), { at: 3 });
    planTick(player, at(1));
    const p = player.planned!;
    b.music!.setPrimed(p.run.group);
    planTick(player, at(1.05));
    expect(b.music!.stamps[0]!.at).toBeCloseTo(3, 9);
  });
});

describe("planner: a change while music plays", () => {
  const toB = (extra: Partial<PlanRequest> = {}): PlanRequest => ({
    to: segment("B", ["music/b1.ogg", "music/b2.ogg"]), reason: "switch", grid: "bar", notBefore: Number.NaN, startFrame: 0, points: bars, ...extra,
  });

  it("lands on the first bar with T - preEntry at or after now + lead", () => {
    rig();
    const player = playingPlayer();
    const p = requestStart(player, toB(), at(1.35))!;
    expect(p.point).toBe(1.5); // earliest 1.45
    expect(p.at).toBe(1.5);
    expect(player.next).toBe(p.run);
    expect(requestStart(player, toB({ preEntry: 0.1 }), at(1.35))!.at).toBeCloseTo(1.9, 9); // 1.5 - 0.1 < 1.45
    expect(b.music!.cancelled).toHaveLength(1); // the replaced plan's group
  });

  it("the outgoing fade start must be at or after now + L", () => {
    rig();
    const player = playingPlayer();
    // T = 1.5 is out: its fade would start at 1.3 < now + L.
    expect(requestStart(player, toB({ fadeLead: 0.2 }), at(1.35))!.point).toBe(2);
  });

  it("a late prime re-plans to the next point of the rule's kind and stamps there; the playing segment carries on", () => {
    rig();
    const player = playingPlayer();
    const a = player.run!;
    const stamped: number[] = [];
    const p = requestStart(player, toB({ onStamped: (pl) => stamped.push(pl.at) }), at(1.35))!;
    expect(p.at).toBe(1.5);
    planTick(player, at(1.44));
    expect(p.replans).toBe(0);
    planTick(player, at(1.46)); // 1.5 < 1.46 + L + Δ̄
    expect(p.replans).toBe(1);
    expect(p.point).toBe(2); // a bar rule never degrades to a beat
    expect(player.counters.replans.deadline).toBe(1);
    expect(b.music!.stamps.filter((s) => s.group === p.run.group)).toHaveLength(0);

    b.music!.setPrimed(p.run.group);
    planTick(player, at(1.5));
    expect(stamped).toEqual([2]);
    expect(b.music!.stamps.at(-1)).toEqual({ group: p.run.group, at: 2 });
    expect(player.run).toBe(a); // R3a swaps the runs at T
    expect(player.next).toBe(p.run);
    expect(a.stems.every((s) => s.voice && !(s.voice as unknown as { stopped: boolean }).stopped)).toBe(true);
  });

  it("aims at the point after next when the prime so far took more than half the gap", () => {
    rig();
    const player = playingPlayer();
    const p = requestStart(player, toB(), at(1.0))!; // earliest 1.1: T = 1.5
    expect(p.point).toBe(1.5);
    planTick(player, at(1.46)); // spent 0.46 s > half of 0.5
    expect(p.point).toBe(2.5);
  });

  it("three re-plans in a row warn replanStorm once", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const player = playingPlayer();
    const p = requestStart(player, toB({ grid: "immediate", points: undefined }), at(2))!;
    for (let k = 0; k < REPLAN_STORM + 2; k++) planTick(player, at(p.at - 0.04));
    expect(p.replans).toBe(REPLAN_STORM + 2);
    expect(player.counters.replans.replanStorm).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("re-plans in a row"))).toHaveLength(1);
  });

  it("a start frame that moves with T re-targets the primed group", () => {
    rig();
    const player = playingPlayer();
    const p = requestStart(player, toB({ startFrameAt: (t) => Math.round((t - 1) * RATE) }), at(1.35))!;
    expect(p.run.startFrame).toBe(24_000);
    expect(b.music!.primes.at(-1)!.retarget).toBe(false);
    planTick(player, at(1.46));
    expect(p.point).toBe(2);
    expect(p.run.startFrame).toBe(48_000);
    const last = b.music!.primes.at(-1)!;
    expect(last.retarget).toBe(true);
    expect(last.request.members.map((m) => m.startFrame)).toEqual([48_000, 48_000]);
  });

  it("no point left (past the exit cue) drops the change and keeps the music", () => {
    rig();
    const player = playingPlayer();
    const dropped: string[] = [];
    expect(requestStart(player, toB({ points: () => Number.NaN, onDropped: (_p, c) => dropped.push(c) }), at(1.35))).toBeNull();
    expect(dropped).toEqual(["noPoint"]);
    expect(player.planned).toBeNull();
    expect(player.state).toBe("playing");
  });

  it("cancelPlanned cancels the group", () => {
    rig();
    const player = playingPlayer();
    const p = requestStart(player, toB(), at(1.35))!;
    cancelPlanned(player, f as unknown as MusicFrame);
    expect(b.music!.cancelled).toEqual([p.run.group]);
    expect(player.planned).toBeNull();
    expect(player.next).toBeNull();
  });
});

describe("planner: refusals (R14)", () => {
  const toB = (extra: Partial<PlanRequest> = {}): PlanRequest => ({
    to: segment("B", ["music/b1.ogg", "music/b2.ogg"]), reason: "switch", grid: "bar", notBefore: Number.NaN, startFrame: 0, points: bars, ...extra,
  });

  /** Every playing voice of the run untouched: no stop or fade. */
  const untouched = (player: MusicPlayer): boolean =>
    player.run!.stems.every((s) => {
      const v = s.voice as unknown as { stopped: boolean; events: { kind: string }[] } | null;
      return v !== null && !v.stopped && !v.events.some((e) => e.kind === "stop" || e.kind === "fade");
    });

  it("a temporary refusal keeps the music and retries once at each allowed point", () => {
    rig();
    const player = playingPlayer();
    const a = player.run!;
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const admitted = b.music!.admitted.length;
    expect(requestStart(player, toB(), at(1.35))).toBeNull();
    const p = player.planned!;
    expect(p.status).toBe("waiting");
    expect(p.refusal).toBe("poolFull");
    expect(p.point).toBe(1.5);
    expect(player.counters.refusals.poolFull).toBe(1);
    expect(player.run).toBe(a);
    expect(player.state).toBe("playing");
    expect(untouched(player)).toBe(true);
    expect(b.music!.admitted.length).toBe(admitted + 1);

    planTick(player, at(1.38)); // 1.5 still reachable: no retry
    expect(b.music!.admitted.length).toBe(admitted + 1);
    planTick(player, at(1.42)); // out of reach: the next point, one try
    expect(b.music!.admitted.length).toBe(admitted + 2);
    expect(p.point).toBe(2);
    expect(p.status).toBe("waiting");
    planTick(player, at(1.5));
    expect(b.music!.admitted.length).toBe(admitted + 2);

    b.music!.admitResult = { ok: true };
    planTick(player, at(1.92));
    expect(p.status).toBe("priming");
    expect(p.point).toBe(2.5);
    expect(player.next).toBe(p.run);
    expect(untouched(player)).toBe(true);
  });

  it("a permanent refusal drops the change with one warning and keeps the music", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const player = playingPlayer();
    b.music!.admitResult = { ok: false, reason: "neverFits", permanent: true };
    const dropped: string[] = [];
    expect(requestStart(player, toB({ onDropped: (_p, c) => dropped.push(c) }), at(1.35))).toBeNull();
    expect(dropped).toEqual(["refused"]);
    expect(player.planned).toBeNull();
    expect(player.next).toBeNull();
    expect(player.counters.refusals.neverFits).toBe(1);
    expect(player.state).toBe("playing");
    expect(untouched(player)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    planTick(player, at(1.5));
    expect(untouched(player)).toBe(true);
  });

  it("never fits beside the playing group (F3's ring need against the pool): refused before admission, naming N and M", () => {
    rig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const player = playingPlayer();
    b.music!.ringPool = 3;
    const admitted = b.music!.admitted.length;
    expect(requestStart(player, toB(), at(1.35))).toBeNull();
    expect(b.music!.admitted.length).toBe(admitted);
    expect(String(warn.mock.calls[0]![0])).toContain("needs 4 music rings beside the playing segment; this preset has 3");
    expect(untouched(player)).toBe(true);
  });

  it("a first segment that can never fit leaves the player refused", () => {
    rig();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    b.music!.ringPool = 1;
    const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg", "music/a2.ogg"]));
    planTick(player, at(1));
    expect(player.state).toBe("refused");
    planTick(player, at(1.1));
    expect(b.music!.admitted).toHaveLength(0);
  });

  it("a first segment refused for now waits and retries every frame", () => {
    rig();
    b.music!.admitResult = { ok: false, reason: "poolFull", permanent: false };
    const player = createMusicPlayer(instance(), segment("A", ["music/a1.ogg"]));
    planTick(player, at(1));
    expect(player.state).toBe("waiting");
    planTick(player, at(1 + DT));
    expect(b.music!.admitted).toHaveLength(2);
    b.music!.admitResult = { ok: true };
    planTick(player, at(1 + 2 * DT));
    expect(player.state).toBe("starting");
    expect(player.planned!.at).toBeCloseTo(1 + 2 * DT + 0.1, 9);
  });

  it("a temporary refusal evicts another player's later unstarted successor, which retries later", () => {
    rig();
    const music = b.music!;
    const other = playingPlayer();
    const q = requestStart(other, toB(), at(2.0))!; // T 2.5
    expect(q.status).toBe("priming");
    const qGroup = q.run.group;
    music.setPrimed(qGroup, 1); // partly primed
    const player = createMusicPlayer(instance(), segment("C", ["music/a1.ogg"]));
    // The pool is full until the other's successor closes its rings.
    const admit = music.admitGroup.bind(music);
    music.admitGroup = (req) => (music.cancelled.includes(qGroup) ? admit(req) : (music.admitted.push(req), { ok: false, reason: "poolFull", permanent: false }));
    planTick(player, at(2.0 + DT)); // C's first start at 2.117 < 2.5
    expect(music.cancelled).toContain(qGroup);
    expect(player.planned!.status).toBe("priming");
    expect(q.status).toBe("waiting");
    expect(q.refusal).toBe("evicted");
    expect(other.counters.refusals.evicted).toBe(1);
    expect(other.next).toBeNull();
    expect(untouched(other)).toBe(true);

    // The evicted plan retries at its next point with a fresh run.
    planTick(other, at(2.45));
    expect(q.status).toBe("priming");
    expect(q.run.group).not.toBe(qGroup);
    expect(q.point).toBe(3);
  });
});
