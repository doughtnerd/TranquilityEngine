// ADR 0166 api-and-models §1, the M4a rows (P7): `handle.music` getters and `nextGrid`, `Audio.horizon`, `Audio.timeAt`,
// `Audio.play(music, { at })`, and `Audio.time` in `update()`. One skipped case per row; leaf L-P7a fills the cases
// tagged `L-P7a` (the lead fills the one tagged `P7-lead`). Fixtures: build a player as `music/planner.test.ts` does
// (fake backend, `setSegmentClipSource`, a parsed segment, `planTick` until it plays) and read through `Audio` and
// `player.handle`.
import { describe, it } from "vitest";

describe("L-P7a: handle.music getters (§1.2)", () => {
  it.skip("L-P7a handle.music is undefined for an event that isn't music, and a MusicHandle for a segment, playlist or musicSwitch root", () => {});
  it.skip("L-P7a segment is null while the first segment primes, then the playing segment's id", () => {});
  it.skip("L-P7a bar, beat and beatFraction follow the heard time through the anchor (bar 2 beat 3 half a beat in), 0..1 through the beat", () => {});
  it.skip("L-P7a tempo, beatsPerBar and beatUnit read the span at the position, and change across a tempo marker", () => {});
  it.skip("L-P7a time is this display frame's Audio.time", () => {});
  it.skip("L-P7a transition is null until a change is planned, then { to, time } with the incoming segment's heard entry time, null again once it landed", () => {});
  it.skip("L-P7a the getters share one snapshot per frame: equal values within a frame, recomputed on the next, no allocation after the first read", () => {});
});

describe("L-P7a: nextGrid (§1.2)", () => {
  it.skip("L-P7a 'beat', 'bar' and { every, n } give the next grid point after Audio.time with its bar, beat and segment id", () => {});
  it.skip("L-P7a the point is clamped to the segment's exit cue (null past it when nothing follows)", () => {});
  it.skip("L-P7a with a pending change the points after transition.time are the incoming segment's (GridPoint.segment says which)", () => {});
  it.skip("L-P7a null when the music is not playing (priming, refused, stopped)", () => {});
});

describe("L-P7a: Audio clock members (§1.3)", () => {
  it.skip("L-P7a Audio.horizon is the backend's horizon (now + lookahead), and Audio.time on a backend without one", () => {});
  it.skip("L-P7a Audio.timeAt maps a performance.now() instant to heard time, never applies Audio.calibration, and is Audio.time on a backend without timeAt", () => {});
});

describe("L-P7a: Audio.play(music, { at }) (§1.3)", () => {
  it.skip("L-P7a at reaches the player (requestedAt) and the first segment starts no earlier than it", () => {});
  it.skip("L-P7a at closer than the prime lead starts at now + lead with one warning; a non-finite at plays as soon as possible", () => {});
});

describe("P7-lead: Audio.time in update() (§1.7, §6 step 0)", () => {
  it.skip("P7-lead engine.AudioMusic calls beginFrame before scripts read Audio.time; with no music it does not", () => {});
});
