// The Sequence transport over the Studio's audio host (J6.3, D24/D25): a "while held" loop holds the play until
// Release — the playhead wraps in a Sync clip's held loop instead of running through, an Async clip's held voice isn't
// cut at the sequence end — and Release lets it go on. Driven through the transport's own actions (`bindSequence`,
// `playSequence`, `releaseSequence`) with a host whose handle records what the transport does to it, on a fake clock.
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, SequenceSettings, Track } from "../../../../engine/audio/playlist/types";
import type { StudioAudioRuntime } from "../../../runtime/studioAudioHost";
import { createRouter, type HashLocation } from "../../../shell/route";
import { provideStudio } from "../../../shell/studioServices";
import type { SourceFacts } from "./sequenceModel";
import { bindSequence, pauseSequence, playback, playSequence, releaseSequence, resumeSequence, seqPlayhead, seqSelection, seqTransport, sequenceSpace, stopSequence } from "./sequenceState";
import { sequencePlayerSlots } from "./SequenceTransport";
import type { VNode } from "preact";
import { DEFAULT_TRANSPORT, heldRegions } from "./transportModel";

/** a.wav: 4 s, loop 1..2 "while held". */
const A: SourceFacts = { length: 4, loops: [{ id: "l1", start: 1, end: 2, active: "held", exit: "finish", exitFadeMs: 0, reentry: "ignore" }], markers: [] };

const clip = (patch: Partial<Clip>): Clip => ({ id: "c1", sample: "a.wav", at: 0, length: 6, offset: 0, gain: 0, pitch: 0, pan: 0, reverse: false, sync: true, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [], ...patch });
const track = (clips: Clip[]): Track => ({ id: "t1", name: "Music", kind: "audio", color: 1, volume: 0, pan: 0, output: null, mute: false, solo: false, enabled: true, effects: [], automation: [], clips });
const sequence = (c: Clip): SequenceSettings => ({ length: 6, tempo: null, tracks: [track([c])], loops: [], markers: [] });

let handle: { playing: boolean; stop: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  handle = { playing: true, stop: vi.fn(() => void (handle.playing = false)), release: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const hash: HashLocation = { get: () => "#/playlists", set: () => {}, listen: () => () => {} };
  const runtime = { playable: signal(true), state: signal({ kind: "running" }), audition: () => handle } as unknown as StudioAudioRuntime;
  provideStudio({ router: createRouter(hash), runtime });
  seqTransport.value = { ...DEFAULT_TRANSPORT, mode: "start" };
});

afterEach(() => {
  stopSequence();
  vi.useRealTimers();
});

function play(c: Clip): void {
  bindSequence(`test:${Math.random()}`, { file: "audio/music.playlist.json", title: "music", seq: sequence(c), plays: "oneShot", sourceOf: () => A });
  playSequence();
}

describe("a while-held loop in a sequence", () => {
  it("holds a Sync clip's playhead in the loop until Release, then plays on to the end", () => {
    play(clip({ sync: true }));
    // The 6 s clip: pickup and first pass to 2, a pass 2..3, the last pass 3..4 wraps while held, the tail 4..6.
    vi.advanceTimersByTime(9_000);
    expect(playback.value).not.toBeNull();
    expect(handle.stop).not.toHaveBeenCalled();
    expect(seqPlayhead.value).toBeGreaterThanOrEqual(3);
    expect(seqPlayhead.value).toBeLessThan(4);
    releaseSequence();
    expect(handle.release).toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(seqPlayhead.value).toBeGreaterThan(4); // left the loop for the tail
    handle.playing = false; // the runtime ends it at the clip's end
    vi.advanceTimersByTime(4_000);
    expect(playback.value).toBeNull();
  });

  it("keeps an Async clip's held voice playing past the sequence end until Release", () => {
    play(clip({ sync: false, length: 2 }));
    vi.advanceTimersByTime(9_000);
    expect(seqPlayhead.value).toBe(6); // the playhead isn't held by an Async loop
    expect(playback.value).not.toBeNull(); // but the play isn't cut: the voice loops on
    expect(handle.stop).not.toHaveBeenCalled();
    releaseSequence();
    expect(handle.release).toHaveBeenCalled();
  });

  it("ends a play with no held loop at the sequence end, as before", () => {
    play(clip({ sync: true, loops: { l1: { active: "parameter" } } })); // unbound: never active, so nothing waits
    vi.advanceTimersByTime(9_000);
    expect(playback.value).toBeNull();
    expect(handle.stop).toHaveBeenCalled();
  });
});

/** The transport's buttons in the player bar, by label. */
function transportButtons(): Map<string, { onClick: () => void; title?: string }> {
  const t = sequencePlayerSlots("music", "Sequence").transport as VNode<{ children: (VNode<{ label: string; onClick: () => void; title?: string }> | false | null)[] }>;
  const out = new Map<string, { onClick: () => void; title?: string }>();
  for (const b of t.props.children) if (b && typeof b === "object" && "props" in b && b.props.label) out.set(b.props.label, b.props);
  return out;
}

describe("a reversed Sync clip's held loop (ADR 0362)", () => {
  it("holds the playhead in the mirrored pass the runtime wraps on: after the tail, before the first pass and pickup", () => {
    // b.wav: 5 s, loop 1..2 held. A 7 s clip: forward 0..2 (pickup, first pass), 1..2 twice, the tail 2..5 (3 s);
    // reversed the tail comes first (clip 0..3), then the passes (3..5), and it wraps on 4..5.
    const B: SourceFacts = { ...A, length: 5 };
    const c = clip({ sync: true, length: 7, reverse: true });
    expect(heldRegions(sequence(c), () => B)).toEqual([{ start: 4, end: 5 }]);
    expect(heldRegions(sequence(clip({ sync: true, length: 7 })), () => B)).toEqual([{ start: 3, end: 4 }]);
    // No pass to repeat besides the first (a 5 s clip): it follows.
    expect(heldRegions(sequence(clip({ sync: true, length: 5, reverse: true })), () => B)).toEqual([]);
  });
});

describe("Pause in the sequence transport (ADR 0362 §1)", () => {
  it("pauses the play and freezes the playhead; Resume continues both from there; Stop works while paused", () => {
    play(clip({ sync: true, loops: {} }));
    vi.advanceTimersByTime(1_000);
    const at = seqPlayhead.value;
    expect(transportButtons().has("Pause")).toBe(true);
    transportButtons().get("Pause")!.onClick();
    expect(handle.pause).toHaveBeenCalledTimes(1);
    expect(sequencePlayerSlots("music", "Sequence").status).toMatch(/^Paused music/);
    expect(sequencePlayerSlots("music", "Sequence").nowPlaying?.art).toBe("SEQ"); // the tree's badge (V13: it said "SQ")
    vi.advanceTimersByTime(3_000);
    expect(seqPlayhead.value).toBe(at);
    expect(playback.value).not.toBeNull();
    pauseSequence(); // twice: nothing more
    expect(handle.pause).toHaveBeenCalledTimes(1);
    transportButtons().get("Resume")!.onClick();
    expect(handle.resume).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30);
    expect(seqPlayhead.value).toBeCloseTo(at + 0.03, 1);
    vi.advanceTimersByTime(1_000);
    expect(seqPlayhead.value).toBeCloseTo(at + 1.03, 1);
    pauseSequence();
    stopSequence();
    expect(handle.stop).toHaveBeenCalled();
    expect(playback.value).toBeNull();
  });

  it("reads the playback's own clock when it reports one: the playhead holds where the audio holds, not when Pause was pressed", () => {
    // 120 bpm 4/4: a beat is 0.5 s. The handle's musical position is the sequence's playhead as heard.
    const music = { segment: "audio/music.playlist.json", bar: 1, beat: 1, beatFraction: 0 };
    (handle as unknown as { music: typeof music }).music = music;
    bindSequence(`test:${Math.random()}`, { file: "audio/music.playlist.json", title: "music", seq: { ...sequence(clip({ sync: true, loops: {} })), tempo: { bpm: 120, meter: "4/4" } }, plays: "oneShot", sourceOf: () => A });
    playSequence();
    Object.assign(music, { beat: 3, beatFraction: 0.5 }); // 1.25 s into the sequence, whatever the wall clock says
    vi.advanceTimersByTime(30);
    expect(seqPlayhead.value).toBeCloseTo(1.25, 6);
    pauseSequence();
    // The audio holds a little after the press (the earliest stampable time): the playhead follows it there and stays.
    Object.assign(music, { beat: 3, beatFraction: 0.6 });
    vi.advanceTimersByTime(2_000);
    expect(seqPlayhead.value).toBeCloseTo(1.3, 6);
    resumeSequence();
    Object.assign(music, { bar: 2, beat: 1, beatFraction: 0 });
    vi.advanceTimersByTime(30);
    expect(seqPlayhead.value).toBeCloseTo(2, 6);
  });

  it("Space resumes a paused play", () => {
    play(clip({ sync: true, loops: {} }));
    vi.advanceTimersByTime(500);
    pauseSequence();
    sequenceSpace();
    expect(handle.resume).toHaveBeenCalledTimes(1);
    expect(playback.value?.pausedAt).toBeNull();
    resumeSequence(); // not paused: nothing
    expect(handle.resume).toHaveBeenCalledTimes(1);
  });
});

describe("the selection across an edit (J6.2)", () => {
  it("keeps a clip selected by the edit that made it while the view redraws before its document has the edit", () => {
    const key = `test:${Math.random()}`;
    const before = sequence(clip({ id: "c1" }));
    const ctx = (seq: SequenceSettings) => ({ file: "audio/music.playlist.json", title: "music", seq, plays: "oneShot" as const, sourceOf: () => A });
    bindSequence(key, ctx(before));
    // The drop selects the new clip c2 at once; the view redraws (the selection changed) with the old sequence.
    seqSelection.value = { ...seqSelection.peek(), focus: "clips", clips: ["c2"] };
    bindSequence(key, ctx(before));
    expect(seqSelection.value.clips).toEqual(["c2"]);
    // Then the document has the edit: c2 is there and stays selected; an undo that takes it away prunes it.
    const after: SequenceSettings = { ...before, tracks: [track([clip({ id: "c1" }), clip({ id: "c2", at: 2 })])] };
    bindSequence(key, ctx(after));
    expect(seqSelection.value.clips).toEqual(["c2"]);
    bindSequence(key, ctx(before));
    expect(seqSelection.value.clips).toEqual([]);
  });
});
