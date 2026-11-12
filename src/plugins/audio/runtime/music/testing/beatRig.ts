// @internal test fixture (ADR 0166 M4c, K1): music players with stamped runs and no backend, and a frame driver that
// asks the beat clock for each kind every display frame, for the beat clock's unit and trace tests (K4 may reuse it).
//
//   const node = musicSegment({ tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }] });
//   const { player } = playingRun(node, 0, 1.0);               // heard from 1.0 s
//   const log = drive(player, frames(0.9, 3.0, 1 / 60));       // every call predictDue made
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../../engine/audio/musicFormat";
import type { MusicEvent, MusicKind } from "../../../../../engine/audio/musicTypes";
import type { MusicClipFacts } from "../../../../../engine/audio/musicValidate";
import type { EventInstance } from "../../events/eventRuntime";
import { anchorRun } from "../anchors";
import { predictDue } from "../beatClock";
import { createMusicPlayer, type MusicPlayer } from "../musicSystem";
import { createSegmentRun, setSegmentClipSource, type SegmentRun } from "../segmentRun";

/** The clips' facts: 10 minutes at 48 kHz, so the exit (the end) is far away unless a segment sets one. */
export function rigClips(seconds = 600, rate = 48_000): void {
  const facts: MusicClipFacts = { frames: seconds * rate, rate, channels: 2, gapless: true };
  setSegmentClipSource({ url: (p) => p, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master", facts: () => facts });
}

let ids = 0;

/** A parsed segment node (one track on `a.ogg`); `raw` adds or overrides fields (`tempo`, `cues`, `regions`, `id`). */
export function musicSegment(raw: Record<string, unknown> = {}): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id: `S${++ids}`, tracks: [{ name: "t0", clip: "a.ogg" }], ...raw }, "test", newMusicContext());
  if (!node) throw new Error("beatRig: the segment did not parse");
  return node;
}

let groups = 100;
function instance(): EventInstance {
  return { group: groups++, world: 1, path: "m.audioevent", asset: { bus: "Music", priority: 200, volume: 1 } } as unknown as EventInstance;
}

/** A stamped run of `node` from clip frame `startFrame` (48 kHz), heard from `at`. */
export function stampedRun(player: MusicPlayer, node: SegmentNode, startFrame: number, at: number, group = 5): SegmentRun {
  const run = createSegmentRun(player, node, startFrame)!;
  run.group = group;
  run.startAt = at;
  run.state = "stamped";
  return run;
}

/** A player playing `node` from clip frame `startFrame`, heard from `at`, anchored there. */
export function playingRun(node: SegmentNode, startFrame: number, at: number): { player: MusicPlayer; run: SegmentRun } {
  const player = createMusicPlayer(instance(), node);
  const run = stampedRun(player, node, startFrame, at);
  run.state = "playing";
  player.run = run;
  player.anchor = anchorRun(run, at);
  player.state = "playing";
  return { player, run };
}

/** What `predictDue` gave, with the display frame it came in. */
export interface Fired {
  kind: MusicKind;
  frame: number;
  now: number;
  e: MusicEvent;
}

/** One display frame: this frame's `Audio.time` and Δ̄ (seconds), and what to do before the dispatch. */
export interface DriveFrame {
  now: number;
  interval: number;
  before?: () => void;
}

/** Evenly spaced frames from `t0` to `t1` (seconds) every `dt`. */
export function frames(t0: number, t1: number, dt: number): DriveFrame[] {
  const out: DriveFrame[] = [];
  for (let k = 0; t0 + k * dt <= t1 + 1e-12; k++) out.push({ now: t0 + k * dt, interval: dt });
  return out;
}

/** Asks for every kind in every frame, as K2's dispatch does; returns every event fired, in order. */
export function drive(player: MusicPlayer, list: readonly DriveFrame[], kinds: readonly MusicKind[] = ["beat", "bar", "cue"]): Fired[] {
  const fired: Fired[] = [];
  list.forEach((f, frame) => {
    f.before?.();
    for (const kind of kinds) {
      const e = { handle: null } as unknown as MusicEvent;
      if (predictDue(player, kind, f.now, f.interval, e)) fired.push({ kind, frame, now: f.now, e });
    }
  });
  return fired;
}
