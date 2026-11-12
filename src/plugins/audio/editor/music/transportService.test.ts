// F-33: the audition's lifetime, against a real transport on a fake host and fake editor inputs.
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySegment } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid } from "../../../../engine/audio/musicGrid";
import { activeAudition } from "../event/auditionHost";
import { createTransport, type TransportHandle } from "./transport";
import { startTransportService } from "./transportService";

const grid = compileSegmentGrid({ ...emptySegment("a"), tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }] }, { endSeconds: 60 });
const EVENT = "m.audioevent.json";

function setup() {
  const handles: (TransportHandle & { alive: boolean })[] = [];
  const stems: (readonly string[] | null)[] = [];
  const host = {
    play: () => {
      const h = { alive: true, get playing() { return h.alive; }, stop: () => { h.alive = false; }, trigger: () => true, onMusic: () => () => undefined } as unknown as TransportHandle & { alive: boolean };
      handles.push(h);
      return h;
    },
    flush: async () => undefined,
    reload: () => undefined,
    startAt: () => true,
    startAtPosition: () => false,
    stems: (_h: TransportHandle, _id: string, a: readonly string[] | null) => void stems.push(a),
  };
  const transport = createTransport(host);
  const open = signal<{ event: string; segmentId: string } | null>({ event: EVENT, segmentId: "a" });
  const playMode = signal<unknown>(null);
  const files = signal<readonly string[] | null>([EVENT]);
  const audible = signal<{ segmentId: string; audible: readonly string[] | null } | undefined>({ segmentId: "a", audible: null });
  const stop = startTransportService(transport, { open, playMode, files: () => files.value, audible: () => audible.value, tickMs: 10 });
  const play = () => transport.play({ event: EVENT, segmentId: "a", grid });
  return { transport, handles, stems, open, playMode, files, audible, stop, play };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); activeAudition.value = null; });

describe("transport service lifetime", () => {
  it("survives the segment view unmounting: nothing the view does stops it, and a solo reaches the playing handle", async () => {
    const s = setup();
    await s.play();
    expect(s.transport.state.value.phase).toBe("playing");
    s.audible.value = { segmentId: "a", audible: ["town"] };
    expect(s.stems.at(-1)).toEqual(["town"]);
    expect(s.handles[0].alive).toBe(true);
    s.stop();
  });

  it("ticks while playing without any panel, and notices the instance ending", async () => {
    const s = setup();
    await s.play();
    s.handles[0].alive = false;
    vi.advanceTimersByTime(30);
    expect(s.transport.state.value.phase).toBe("ended");
    s.stop();
  });

  it("stops when its event leaves the project", async () => {
    const s = setup();
    await s.play();
    s.files.value = [];
    expect(s.handles[0].alive).toBe(false);
    expect(s.transport.state.value.phase).toBe("ended");
    s.stop();
  });

  it("stops when the editor's play mode starts", async () => {
    const s = setup();
    await s.play();
    s.playMode.value = {};
    expect(s.handles[0].alive).toBe(false);
    s.stop();
  });

  it("stops when the view moves to another segment, but not when it moves off an event it isn't auditioning", async () => {
    const s = setup();
    await s.play();
    s.open.value = { event: "other.audioevent.json", segmentId: "x" };
    expect(s.handles[0].alive).toBe(false);
    await s.play();
    s.open.value = { event: "third.audioevent.json", segmentId: "y" }; // left "other"/"x", not what plays
    expect(s.handles[1].alive).toBe(true);
    s.stop();
  });

  it("keeps one audition at a time: a new play stops the previous handle", async () => {
    const s = setup();
    await s.play();
    await s.play();
    expect(s.handles.map((h) => h.alive)).toEqual([false, true]);
    s.stop();
  });
});
