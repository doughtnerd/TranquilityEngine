// ADR 0166 T3 (L-T3a): rule precedence as a *change* sees it, through `requestTransition` on the fake backend. R1's
// `transitionRules.test.ts` pins `findRule` and the maths one function at a time; these cases pin what a player does with
// the winning rule: which rule the transition holds (`match`), where its exit point T lands (the rule's `exit`, heard
// seconds), what it stamps on the incoming (the rule's fades), and which library a bridge comes from.
//
// Clock: 120 bpm 4/4 (a beat 0.5 s, a bar 2 s). A is stamped at 1.1 (now 1 + the 100 ms first lead), so its beats are
// heard at 1.1, 1.6, 2.1, ... and its bars at 1.1, 3.1, 5.1, ...; a change asked at now 1.5 leaves on 1.6 (beat) or 3.1
// (bar). Every rule below differs in its `exit`, so the point T says which rule won. The `exit` of each is:
//   beat  -> 1.6        bar -> 3.1        exitCue (A's cue "out" at 2:1:0) -> 3.1 as well, so it is not used to tell rules apart.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import { isMusicContainer, type MusicNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";
import { planTick, requestStart } from "./planner";
import { requestTransition, tickTransition } from "./transition";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;
const BEAT_EXIT = 1.6;
const BAR_EXIT = 3.1;

const long = (): MusicClipFacts => ({ frames: 120 * RATE, rate: RATE, channels: 2, gapless: true });

type Raw = Record<string, unknown>;
const seg = (id: string, extra: Raw = {}): Raw => ({ type: "segment", id, value: id, tracks: [{ name: "t0", clip: `music/${id}0.ogg` }, { name: "t1", clip: `music/${id}1.ogg` }], ...extra });
/** A segment with an exit cue "out" at bar 2 (heard 3.1 when it starts at 1.1). */
const segCue = (id: string, extra: Raw = {}): Raw => seg(id, { cues: [{ name: "out", at: "2:1:0" }], exit: "out", ...extra });

/** The music root of an event whose root is `root`. */
function music(root: Raw): MusicNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot;
}
/** A flat musicSwitch over A, B, C with `transitions`. */
const flat = (transitions: Raw[] = [], children: Raw[] = [seg("A"), seg("B"), seg("C")], extra: Raw = {}): MusicNode =>
  music({ type: "musicSwitch", id: "sw", parameter: "zone", children, transitions, ...extra });

/** The node `id` anywhere under `root`. */
function find(root: MusicNode, id: string): MusicNode {
  if (root.id === id) return root;
  if (isMusicContainer(root)) for (const c of root.children) {
    try {
      return find(c, id);
    } catch { /* not under this child */ }
  }
  throw new Error(`no node ${id}`);
}

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

/** A player over `r` whose first segment `first` plays from 1.1. */
function playing(r: MusicNode, first = "A"): MusicPlayer {
  const player = createMusicPlayer(instance(), r);
  requestStart(player, { to: find(r, first), reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0 }, at(1));
  b.music!.setPrimed(player.planned!.run.group);
  planTick(player, at(1));
  expect(player.run?.node.id).toBe(first);
  planTick(player, at(1.2));
  expect(player.state).toBe("playing");
  return player;
}

function tick(player: MusicPlayer, now: number): void {
  tickTransition(player, at(now));
  planTick(player, at(now));
}

/** Ask for `to` at now 1.5 and return the transition (never null here). */
function change(player: MusicPlayer, r: MusicNode, to: string, now = 1.5): NonNullable<ReturnType<typeof requestTransition>> {
  const t = requestTransition(player, find(r, to), at(now));
  expect(t).not.toBeNull();
  return t!;
}

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
});

// A rule list in the worst order for precedence: the least specific first, the exact pair last.
const mixed = (): Raw[] => [
  { from: "*", to: "*", exit: "bar" },
  { from: "*", to: "B", exit: "beat" },
  { from: "A", to: "*", exit: { n: 2, every: "beat" } },
  { from: "A", to: "B", exit: { n: 2, every: "bar" } },
];

describe("T3: precedence decides the executed change", () => {
  it("an exact pair beats every wildcard rule listed before it: the transition holds it and leaves at its point", () => {
    rig();
    const r = flat(mixed());
    const t = change(playing(r), r, "B");
    expect(t.match).toMatchObject({ ruleKey: "A>B", tier: 1, rule: 3, parent: "sw", exit: "2 bars" });
    // Two bars on (5.1): not the 1.6 beat, the 3.1 bar or the 2.1 two-beat point of the rules it beat.
    expect(t.exitAt).toBeCloseTo(5.1, 9);
  });

  it("an exact pair beats a wildcard written after it", () => {
    rig();
    const r = flat([{ from: "A", to: "B", exit: "bar" }, { from: "A", to: "*", exit: "beat" }, { from: "*", to: "B", exit: "beat" }, { from: "*", to: "*", exit: "beat" }]);
    const t = change(playing(r), r, "B");
    expect(t.match).toMatchObject({ ruleKey: "A>B", tier: 1, rule: 0 });
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("tier 2 (from named) beats tier 3 (to named) whatever the order, and tier 3 beats tier 4", () => {
    rig();
    // A to B: `A>*` (bar) over `*>B` (beat) listed first. A to C: no `A>C`, `A>*` still wins over `*>*`.
    const r = flat([{ from: "*", to: "B", exit: "beat" }, { from: "*", to: "*", exit: "beat" }, { from: "A", to: "*", exit: "bar" }]);
    const player = playing(r);
    const ab = change(player, r, "B");
    expect(ab.match).toMatchObject({ ruleKey: "A>*", tier: 2, rule: 2 });
    expect(ab.exitAt).toBeCloseTo(BAR_EXIT, 9);

    // Tier 3 over tier 4: with only `*>B` (beat) and `*>*` (bar), A to B takes the beat and A to C the bar.
    rig();
    const r2 = flat([{ from: "*", to: "*", exit: "bar" }, { from: "*", to: "B", exit: "beat" }]);
    const p2 = playing(r2);
    const toB = change(p2, r2, "B");
    expect(toB.match).toMatchObject({ ruleKey: "*>B", tier: 3, rule: 1 });
    expect(toB.exitAt).toBeCloseTo(BEAT_EXIT, 9);
    rig();
    const p3 = playing(r2);
    const toC = change(p3, r2, "C");
    expect(toC.match).toMatchObject({ ruleKey: "*>*", tier: 4, rule: 0 });
    expect(toC.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("the first listed rule wins inside a tier", () => {
    rig();
    const r = flat([{ from: "*", to: "B", exit: "bar" }, { from: "*", to: "B", exit: "beat" }]);
    const t = change(playing(r), r, "B");
    expect(t.match.rule).toBe(0);
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("a written `*>*` rule beats the default rule: its exit and fades apply (rule index 0, not -1)", () => {
    rig();
    const r = flat([{ from: "*", to: "*", exit: "beat", fadeIn: { seconds: 0.25, curve: "linear" }, fadeOut: { seconds: 0.25, curve: "linear" } }]);
    const player = playing(r);
    const t = change(player, r, "B");
    expect(t.match).toMatchObject({ rule: 0, tier: 4, ruleKey: "*>*" });
    expect(t.exitAt).toBeCloseTo(BEAT_EXIT, 9);
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.52);
    const stamp = b.music!.stamps.at(-1)!;
    expect(stamp.at).toBeCloseTo(BEAT_EXIT, 9);
    expect(stamp.fades![1]!.fade).toEqual({ to: 1, seconds: expect.closeTo(0.25, 9), law: "linear", at: expect.closeTo(BEAT_EXIT, 9) });
  });

  it("the default rule (no rules written): index -1, tier 4, a bar exit, a one-beat equal-power fade each way", () => {
    rig();
    const r = flat([]);
    const player = playing(r);
    const t = change(player, r, "B");
    expect(t.match).toMatchObject({ rule: -1, tier: 4, ruleKey: "*>*", exit: "bar", enter: "entryCue", bridge: null });
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.6);
    const stamp = b.music!.stamps.at(-1)!;
    expect(stamp.at).toBeCloseTo(BAR_EXIT, 9);
    expect(stamp.fades).toEqual([
      { member: 0, fade: { to: 0, seconds: 0, law: "linear", at: stamp.at } },
      { member: 0, fade: { to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(BAR_EXIT, 9) } },
      { member: 1, fade: { to: 0, seconds: 0, law: "linear", at: stamp.at } },
      { member: 1, fade: { to: 1, seconds: expect.closeTo(0.5, 9), law: "equalPowerIn", at: expect.closeTo(BAR_EXIT, 9) } },
    ]);
  });

  it("rules for other pairs do not match: B to A and A to C fall to the default while A to B has its rule", () => {
    rig();
    const r = flat([{ from: "A", to: "B", exit: "beat" }]);
    const player = playing(r);
    const ac = change(player, r, "C");
    expect(ac.match).toMatchObject({ rule: -1, tier: 4 });
    expect(ac.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("a queued change is matched from the segment it will leave (the incoming one), not from the one playing now", () => {
    rig();
    // Asked while A -> B is past its cancel point: C is matched as B -> C (`B>C`, beat), never as A -> C (`A>*`, bar).
    const r = flat([{ from: "A", to: "*", exit: "bar" }, { from: "B", to: "C", exit: "beat" }]);
    const player = playing(r);
    const t = change(player, r, "B");
    b.music!.setPrimed(t.incoming!.run.group);
    for (let n = 1.6; n <= BAR_EXIT - L - DT + 1e-6; n += DT) tick(player, n);
    expect(t.state).toBe("running");
    const q = requestTransition(player, find(r, "C"), at(BAR_EXIT - 0.02))!;
    expect(q.match).toMatchObject({ ruleKey: "B>C", tier: 1 });
    tick(player, BAR_EXIT);
    expect(player.run?.node.id).toBe("B");
    expect(player.transition).toBe(q);
    expect(q.match.ruleKey).toBe("B>C");
    // B starts at 3.1, so its next beat after the lead is 3.6.
    expect(q.exitAt).toBeCloseTo(3.6, 9);
  });
});

describe("T3: nested containers", () => {
  /**
   * Root `sw` over the inner switch `in` (segments A, B), the segment C and the inner switch `deep` (segments D, E),
   * with each container's own table; `lib` is a bridge segment R in the root's library.
   */
  function nested(rootRules: Raw[], inRules?: Raw[], extra: Raw = {}): MusicNode {
    return music({
      type: "musicSwitch", id: "sw", parameter: "zone", transitions: rootRules, ...extra,
      children: [
        { type: "musicSwitch", id: "in", value: "in", parameter: "sub", children: [seg("A"), seg("B")], ...(inRules ? { transitions: inRules } : {}) },
        seg("C"),
        { type: "musicSwitch", id: "deep", value: "deep", parameter: "sub2", children: [seg("D"), seg("E")] },
      ],
    });
  }

  it("siblings inside one container match in that container's table, not the root's (parent is the inner id)", () => {
    rig();
    const r = nested([{ from: "*", to: "*", exit: "bar" }], [{ from: "A", to: "B", exit: "beat" }]);
    const t = change(playing(r), r, "B");
    expect(t.match).toMatchObject({ ruleKey: "A>B", parent: "in", tier: 1 });
    expect(t.exitAt).toBeCloseTo(BEAT_EXIT, 9);
  });

  it("the inner table's default wins over a root rule that names the outer child (no fall-through upward)", () => {
    rig();
    const r = nested([{ from: "in", to: "*", exit: "beat" }, { from: "*", to: "*", exit: "beat" }]);
    const t = change(playing(r), r, "B");
    expect(t.match).toMatchObject({ rule: -1, tier: 4, parent: "in" });
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("a change across containers matches in the nearest common parent's table by the children's ids (`in` to `C`)", () => {
    rig();
    // The inner rule `A>*` (beat) must not apply: A and C meet at the root.
    const r = nested([{ from: "in", to: "C", exit: "bar" }, { from: "*", to: "*", exit: "beat" }], [{ from: "A", to: "*", exit: "beat" }]);
    const t = change(playing(r), r, "C");
    expect(t.match).toMatchObject({ ruleKey: "in>C", parent: "sw", tier: 1, rule: 0 });
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("two different inner containers (`in` to `deep`) meet at the root; `*>deep` is tier 3 and beats the root's `*>*`", () => {
    rig();
    const r = nested([{ from: "*", to: "*", exit: "bar" }, { from: "*", to: "deep", exit: "beat" }]);
    const t = change(playing(r), r, "D");
    expect(t.match).toMatchObject({ ruleKey: "*>deep", parent: "sw", tier: 3, rule: 1 });
    expect(t.exitAt).toBeCloseTo(BEAT_EXIT, 9);
  });

  it("a target that is a container matches by that container's id and starts the child its parameter picks", () => {
    rig();
    const r = nested([{ from: "C", to: "deep", exit: "bar" }, { from: "C", to: "*", exit: "beat" }]);
    const player = playing(r, "C");
    const t = requestTransition(player, find(r, "deep"), at(1.5))!;
    expect(t.match).toMatchObject({ ruleKey: "C>deep", tier: 1 });
    expect(t.incoming!.run.node.id).toBe("D"); // no parameter, no default: the first child
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
  });

  it("a bridge comes from the library of the container whose table matched, not from the playing segment's container", () => {
    rig();
    const bridge = seg("R", { cues: [{ name: "out", at: "2:1:0" }], exit: "out" });
    const r = nested(
      [{ from: "in", to: "C", exit: "bar", bridge: { segment: "R" } }],
      [{ from: "A", to: "B", exit: "beat" }],
      { library: [bridge] },
    );
    const player = playing(r);
    const t = change(player, r, "C");
    expect(t.match).toMatchObject({ ruleKey: "in>C", parent: "sw", bridge: "R" });
    expect(t.bridge?.run.node.id).toBe("R");
    expect(t.state).toBe("pending");
    // The sibling change inside `in` matched in `in`'s table, which has no bridge: planned as a direct change.
    rig();
    const p2 = playing(r);
    const direct = change(p2, r, "B");
    expect(direct.match.bridge).toBeNull();
    expect(direct.bridge).toBeNull();
  });
});

describe("T3: D14, a natural advance and the rule", () => {
  /** A (exit cue "out" at 3.1) and B under `rules`; the advance is asked as P4 does, with `natural`. */
  function advance(rules: Raw[]): { player: MusicPlayer; t: NonNullable<ReturnType<typeof requestTransition>> } {
    rig();
    const r = flat(rules, [segCue("A"), seg("B"), seg("C")]);
    const player = playing(r);
    const t = requestTransition(player, find(r, "B"), at(1.5), { natural: true })!;
    expect(t).not.toBeNull();
    b.music!.setPrimed(t.incoming!.run.group);
    tick(player, 1.6);
    return { player, t };
  }

  it("leaves at the exit cue whatever the rule's exit, and takes the rule's fade-in from silence", () => {
    const { t } = advance([{ from: "A", to: "B", exit: "beat", fadeIn: { beats: 1, curve: "linear" } }]);
    expect(t.match).toMatchObject({ ruleKey: "A>B", rule: 0 });
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9); // not the rule's beat (1.6)
    const stamp = b.music!.stamps.at(-1)!;
    expect(stamp.at).toBeCloseTo(BAR_EXIT, 9);
    expect(stamp.fades![0]!.fade).toEqual({ to: 0, seconds: 0, law: "linear", at: stamp.at });
    expect(stamp.fades![1]!.fade).toEqual({ to: 1, seconds: expect.closeTo(0.5, 9), law: "linear", at: expect.closeTo(BAR_EXIT, 9) });
  });

  it("under the default rule it is a gapless cut: no fades on the incoming, and (at the exit cue) none on the outgoing", () => {
    const { player, t } = advance([]);
    expect(t.match.rule).toBe(-1);
    expect(t.exitAt).toBeCloseTo(BAR_EXIT, 9);
    expect(b.music!.stamps.at(-1)!.fades).toBeUndefined();
    for (let n = 1.6 + DT; n <= BAR_EXIT + 1e-9; n += DT) tick(player, n);
    expect(t.state).toBe("done");
    expect(player.run?.node.id).toBe("B");
    for (const v of b.voices) expect((v as unknown as { events: { kind: string }[] }).events.some((e) => e.kind === "fade")).toBe(false);
  });

  it("a written `*>*` rule is a rule: a natural advance takes its fades (D14: only the *default* rule is gapless)", () => {
    const { t } = advance([{ from: "*", to: "*", fadeIn: { beats: 1, curve: "linear" } }]);
    expect(t.match).toMatchObject({ rule: 0, tier: 4 });
    const stamp = b.music!.stamps.at(-1)!;
    expect(stamp.fades![1]!.fade).toMatchObject({ to: 1, law: "linear", at: expect.closeTo(BAR_EXIT, 9) });
  });

  it("the same A to B change that is not natural leaves on the rule's own exit (the contrast)", () => {
    rig();
    const r = flat([{ from: "A", to: "B", exit: "beat", fadeIn: { beats: 1, curve: "linear" } }], [segCue("A"), seg("B"), seg("C")]);
    const t = change(playing(r), r, "B");
    expect(t.exitAt).toBeCloseTo(BEAT_EXIT, 9);
  });

  it("a natural advance whose rule names a bridge plays it, leaving A at its exit cue", () => {
    rig();
    const bridge = seg("R", { cues: [{ name: "out", at: "2:1:0" }], exit: "out" });
    const r = flat([{ from: "A", to: "B", exit: "beat", bridge: { segment: "R" } }], [segCue("A"), seg("B"), seg("C")], { library: [bridge] });
    const player = playing(r);
    const t = requestTransition(player, find(r, "B"), at(1.5), { natural: true })!;
    expect(t.match.bridge).toBe("R");
    expect(t.bridge?.run.node.id).toBe("R");
    expect(t.bridge!.point).toBeCloseTo(BAR_EXIT, 9);
  });
});
