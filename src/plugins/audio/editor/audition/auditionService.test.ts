// ADR 0268 (from F-33): the audition's lifetime, against a real audition on a fake host and fake editor inputs.
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySegment } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid } from "../../../../engine/audio/musicGrid";
import { createAudition } from "./audition";
import { fakeHost, type FakeHandle } from "./auditionFixtures";
import { startAuditionService } from "./auditionService";

const grid = compileSegmentGrid({ ...emptySegment("a"), tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }] }, { endSeconds: 60 });
const MUSIC = "m.audioevent.json";
const EVENT = "e.audioevent.json";

function setup() {
  const host = fakeHost();
  const handles: FakeHandle[] = [];
  const play = host.play;
  host.play = (path, parameters) => {
    const h = play(path, parameters) as FakeHandle;
    handles.push(h);
    return h;
  };
  const audition = createAudition(host);
  const open = signal<{ event: string; segmentId: string } | null>({ event: MUSIC, segmentId: "a" });
  const playMode = signal<unknown>(null);
  const files = signal<readonly string[] | null>([MUSIC, EVENT]);
  const audible = signal<{ segmentId: string; audible: readonly string[] | null } | undefined>({ segmentId: "a", audible: null });
  const stop = startAuditionService(audition, { open, playMode, files: () => files.value, audible: () => audible.value, tickMs: 10 });
  const playMusic = () => audition.play({ event: MUSIC, music: { segmentId: "a", grid } });
  const playEvent = () => audition.play({ event: EVENT });
  return { host, audition, handles, open, playMode, files, audible, stop, playMusic, playEvent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("audition service lifetime", () => {
  it("survives the segment view unmounting: nothing the view does stops it, and a solo reaches the playing handle", async () => {
    const s = setup();
    await s.playMusic();
    expect(s.audition.state.value.phase).toBe("playing");
    s.audible.value = { segmentId: "a", audible: ["town"] };
    expect(s.host.stemCalls.at(-1)).toEqual(["town"]);
    expect(s.handles[0]!.alive).toBe(true);
    s.stop();
  });

  it("ticks while playing without any panel, and notices the instance ending", async () => {
    const s = setup();
    await s.playEvent();
    s.handles[0]!.alive = false;
    vi.advanceTimersByTime(30);
    expect(s.audition.state.value.phase).toBe("ended");
    s.stop();
  });

  it("stops when its event leaves the project, whoever started it", async () => {
    const s = setup();
    await s.playMusic();
    s.files.value = [EVENT];
    expect(s.handles[0]!.alive).toBe(false);
    expect(s.audition.state.value.phase).toBe("ended");
    await s.playEvent();
    s.files.value = null; // the project closes
    expect(s.handles[1]!.alive).toBe(false);
    s.stop();
  });

  it("never plays an event whose document closed while its Play was flushing", async () => {
    const s = setup();
    s.host.hold();
    const started = s.playEvent();
    s.files.value = [MUSIC];
    s.host.holdFlush!();
    await started;
    expect(s.host.played).toEqual([]);
    s.stop();
  });

  it("stops when the editor's play mode starts, the Event editor's audition as well as the transport's", async () => {
    const s = setup();
    await s.playMusic();
    s.playMode.value = {};
    expect(s.handles[0]!.alive).toBe(false);
    s.playMode.value = null;
    await s.playEvent();
    s.playMode.value = {};
    expect(s.handles[1]!.alive).toBe(false);
    s.stop();
  });

  it("stops when the view moves to another segment, but not when it moves off a segment it isn't auditioning", async () => {
    const s = setup();
    await s.playMusic();
    s.open.value = { event: "other.audioevent.json", segmentId: "x" };
    expect(s.handles[0]!.alive).toBe(false);
    await s.playMusic();
    s.open.value = { event: "third.audioevent.json", segmentId: "y" }; // left "other"/"x", not what plays
    expect(s.handles[1]!.alive).toBe(true);
    await s.playEvent();
    s.open.value = { event: MUSIC, segmentId: "a" };
    s.open.value = null; // left the music segment; the Event editor's audition of another event goes on
    expect(s.handles[2]!.alive).toBe(true);
    s.stop();
  });

  it("keeps one audition at a time: a new play stops the previous handle", async () => {
    const s = setup();
    await s.playMusic();
    await s.playEvent();
    expect(s.handles.map((h) => h.alive)).toEqual([false, true]);
    s.stop();
  });
});
