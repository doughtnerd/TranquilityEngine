// ADR 0166 P4: playlists on the fake backend (`testing.ts`) with a deterministic clock. Each frame sets `now` and the
// fake's horizon (now + L); the test primes a group a few frames after its prime request, as a worker would.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { _resetMusicPlayers, createMusicPlayer, type MusicFrame, type MusicNodeRef, type MusicPlayer } from "./musicSystem";
import { planTick } from "./planner";
import { tickTransition } from "./transition";
import { createPlaylistState, enterPlaylist, peekNext, tickPlaylist } from "./playlist";
import { _resetSegmentRuns, setSegmentClipSource } from "./segmentRun";

const RATE = 48_000;
const L = 1 / 30;
const DT = 1 / 60;
/** Frames between a prime request and the group being primed: 50 ms, inside the 100 ms lead. */
const PRIME_FRAMES = 3;
/** Every segment is 4 s long (120 bpm: 2 bars), so its exit (the end) is 4 s after its start. */
const SEG_SECONDS = 4;

const facts = (): MusicClipFacts => ({ frames: 120 * RATE, rate: RATE, channels: 2, gapless: true });

function segment(id: string, plays = 1, stems = 2): SegmentNode {
  const tracks = Array.from({ length: stems }, (_, k) => ({ name: `t${k}`, clip: `music/${id}-${k}.ogg` }));
  const node = parseSegmentNode({ type: "segment", id, tracks, plays, cues: [{ name: "exit", at: "3:1:0" }], exit: "exit" }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

function playlist(id: string, children: unknown[], over: Record<string, unknown> = {}): MusicNodeRef {
  return {
    type: "playlist", id, mode: "sequence", rounds: 1, avoidRepeat: 0, weight: 1, plays: 1, transitions: [], stingers: [], library: [],
    children, ...over,
  } as unknown as MusicNodeRef;
}

let groupIds = 70;
const instance = (): EventInstance =>
  ({ group: groupIds++, world: 1, path: "music.audioevent", asset: { bus: "Music", volume: 1 } }) as unknown as EventInstance;

let b: FakeBackend;
const f = { backend: null as unknown as FakeBackend, music: null as FakeBackend["music"] | null, now: 0, dt: DT, hidden: false };

interface Stamp { at: number; id: string; primedAtStamp: boolean; unprimed: number }
let stamps: Stamp[] = [];

function rig(): void {
  b = makeFakeBackend();
  setAudioBackend(b);
  f.backend = b;
  f.music = b.music ?? null;
  setSegmentClipSource({ url: (p) => `/assets/${p}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts });
  stamps = [];
  const music = b.music!;
  const inner = music.stampGroup.bind(music);
  music.stampGroup = (stamp) => {
    const st = music.primedState(stamp.group);
    stamps.push({ at: stamp.at, id: "", primedAtStamp: !!st?.ready, unprimed: st ? st.of - st.primed : -1 });
    const ids = music.admitted.find((r) => r.group === stamp.group);
    stamps[stamps.length - 1]!.id = ids?.members[0]?.play.path ?? "";
    return inner(stamp);
  };
}

/** Run frames from `from` until `until` seconds, priming groups PRIME_FRAMES after their request. Returns the last time. */
function run(player: MusicPlayer, from: number, until: number, each?: (now: number) => void): number {
  const seen = new Map<number, number>();
  let frame = 0;
  let t = from;
  for (; t < until; t += DT, frame++) {
    f.now = t;
    (b as { time: number }).time = t;
    b.horizonTime = t + L;
    for (const p of b.music!.primes) {
      const g = p.request.group;
      if (!seen.has(g)) seen.set(g, frame);
    }
    for (const [g, first] of seen) if (frame - first >= PRIME_FRAMES) b.music!.setPrimed(g);
    tickPlaylist(player, f as unknown as MusicFrame);
    tickTransition(player, f as unknown as MusicFrame); // R3b: the natural advance lands through the transition
    planTick(player, f as unknown as MusicFrame);
    each?.(t);
  }
  return t;
}

/** The segment ids stamped, in order (clip `music/<id>-0.ogg`). */
const order = (): string[] => stamps.map((s) => s.id.replace(/^music\//, "").replace(/-0\.ogg$/, ""));

afterEach(() => {
  _resetMusicPlayers();
  _resetSegmentRuns();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("playlist: state and peek", () => {
  it("createPlaylistState is null for a segment and a state for a playlist", () => {
    expect(createPlaylistState(segment("a"), 1)).toBeNull();
    expect(createPlaylistState(playlist("p", [segment("a")]), 1)).not.toBeNull();
  });

  it("peekNext does not advance, descends into a nested playlist and ends at the last round", () => {
    const root = playlist("p", [segment("a"), playlist("n", [segment("b"), segment("c")]), segment("d")]);
    const st = createPlaylistState(root, 3)!;
    expect(peekNext(st)?.id).toBe("a");
    expect(peekNext(st)?.id).toBe("a");
  });
});

describe("playlist: the state across an advance (D18)", () => {
  it("a gapless advance reads playing throughout; the next item shows as the pending change, never as transitioning", () => {
    rig();
    const root = playlist("p", ["a", "b", "c"].map((id) => segment(id)));
    const player = createMusicPlayer(instance(), root);
    player.playlist = createPlaylistState(root, 11);
    let playing = 0, scheduled = 0, other = 0;
    run(player, 1, 1 + 3 * SEG_SECONDS, () => {
      if (player.state === "playing" || player.state === "pending") playing++;
      else if (player.state !== "starting" && player.state !== "committed") other++;
      if (player.state === "transitioning") other += 1000;
      if (player.transition) scheduled++;
    });
    expect(other).toBe(0);
    expect(scheduled).toBeGreaterThan(playing / 2); // the next item is scheduled for most of each item
  });
});

describe("playlist: the long run (acceptance)", () => {
  it("a sequence of 8 over 5 rounds: every start was primed before its stamp, on the previous exit cue, in order", () => {
    rig();
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const root = playlist("p", ids.map((id) => segment(id)), { rounds: 5 });
    const player = createMusicPlayer(instance(), root);
    player.playlist = createPlaylistState(root, 11);
    run(player, 1, 1 + 40 * SEG_SECONDS + 5);
    expect(stamps.length).toBe(40);
    expect(order()).toEqual(Array.from({ length: 40 }, (_, k) => ids[k % 8]));
    for (const s of stamps) {
      expect(s.primedAtStamp).toBe(true);
      expect(s.unprimed).toBe(0);
    }
    // Each successor starts at its predecessor's exit cue: exactly one segment length apart (the first stamp may be late).
    for (let k = 1; k < stamps.length; k++) expect(stamps[k]!.at - stamps[k - 1]!.at).toBeCloseTo(SEG_SECONDS, 6);
  });

  it("shuffle with plays, a nested playlist and avoidRepeat: 60 items, never unprimed, list ends after its rounds", () => {
    rig();
    const root = playlist(
      "p",
      [segment("a", 2), segment("b"), playlist("n", [segment("c"), segment("d")], { mode: "shuffle", plays: 2 }), segment("e")],
      { mode: "shuffle", rounds: 4, avoidRepeat: 1 },
    );
    const player = createMusicPlayer(instance(), root);
    player.playlist = createPlaylistState(root, 99);
    run(player, 1, 1 + 80 * SEG_SECONDS);
    // Per round: a x2, b, (c d in some order) x2, e = 2 + 1 + 4 + 1 = 8 items; 4 rounds.
    expect(stamps.length).toBe(32);
    for (const s of stamps) expect(s.primedAtStamp).toBe(true);
    for (let k = 1; k < stamps.length; k++) expect(stamps[k]!.at - stamps[k - 1]!.at).toBeCloseTo(SEG_SECONDS, 6);
    const perRound = order().slice(0, 8).sort();
    expect(perRound).toEqual(["a", "a", "b", "c", "c", "d", "d", "e"]);
  });

  it("random mode with a heavy prime (4 frames inside a 6 frame lead) still starts every item primed", () => {
    rig();
    const root = playlist("p", ["a", "b", "c"].map((id) => segment(id)), { mode: "random", rounds: 0, avoidRepeat: 1 });
    const player = createMusicPlayer(instance(), root);
    player.playlist = createPlaylistState(root, 5);
    run(player, 1, 1 + 30 * SEG_SECONDS);
    expect(stamps.length).toBeGreaterThanOrEqual(29);
    for (const s of stamps) expect(s.primedAtStamp).toBe(true);
    const ids = order();
    for (let k = 1; k < ids.length; k++) expect(ids[k]).not.toBe(ids[k - 1]);
  });
});

describe("playlist: the descent", () => {
  it("enterPlaylist returns a segment as is and a playlist's first leaf; a playlist becomes the player's when it plays", () => {
    rig();
    const seg = segment("s");
    const inner = playlist("n", [segment("x"), segment("y")]);
    const player = createMusicPlayer(instance(), playlist("root", [seg]));
    const before = player.playlist; // P7 creates the root playlist's state with the player
    expect(enterPlaylist(player, seg)).toBe(seg);
    const leaf = enterPlaylist(player, inner);
    expect(leaf?.id).toBe("x");
    expect(player.playlist).toBe(before); // the descent doesn't replace the player's playlist
  });

  it("an empty playlist plays nothing and the playlist ends after its last round", () => {
    rig();
    const player = createMusicPlayer(instance(), playlist("p", []));
    player.playlist = createPlaylistState(player.root, 1);
    run(player, 1, 3);
    expect(stamps.length).toBe(0);
  });
});
