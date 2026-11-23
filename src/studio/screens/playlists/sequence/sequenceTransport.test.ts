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
import { bindSequence, playback, playSequence, releaseSequence, seqPlayhead, seqTransport, stopSequence } from "./sequenceState";
import { DEFAULT_TRANSPORT } from "./transportModel";

/** a.wav: 4 s, loop 1..2 "while held". */
const A: SourceFacts = { length: 4, loops: [{ id: "l1", start: 1, end: 2, active: "held", exit: "finish", exitFadeMs: 0, reentry: "ignore" }], markers: [] };

const clip = (patch: Partial<Clip>): Clip => ({ id: "c1", sample: "a.wav", at: 0, length: 6, offset: 0, gain: 0, pitch: 0, pan: 0, reverse: false, sync: true, enabled: true, loops: {}, hiddenMarkers: [], effects: [], automation: [], ...patch });
const track = (clips: Clip[]): Track => ({ id: "t1", name: "Music", kind: "audio", color: 1, volume: 0, pan: 0, output: null, mute: false, solo: false, enabled: true, effects: [], automation: [], clips });
const sequence = (c: Clip): SequenceSettings => ({ length: 6, tempo: null, tracks: [track([c])], loops: [], markers: [] });

let handle: { playing: boolean; stop: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  handle = { playing: true, stop: vi.fn(() => void (handle.playing = false)), release: vi.fn() };
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
