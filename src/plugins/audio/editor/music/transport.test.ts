// Ed5: the transport against a fake audio host. 120 bpm 4/4 is 0.5 s per beat, 2 s per bar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySegment } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid } from "../../../../engine/audio/musicGrid";
import type { MusicSeekResult } from "../../../../engine/audio/musicTypes";
import { activeAudition } from "../event/auditionHost";
import { createTransport, playheadSeconds, seekText, type TransportHandle, type TransportHost } from "./transport";

const segment = { ...emptySegment("a"), tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }], cues: [{ name: "drop", at: "3:1:0" }] };
const grid = compileSegmentGrid(segment, { endSeconds: 60 });

interface Fake extends TransportHandle {
  alive: boolean;
  seeks: string[];
  triggers: string[];
  stops: number;
  seekResults: MusicSeekResult[];
  position: { segment: string | null; bar: number; beat: number; beatFraction: number };
}

function fakeHandle(playing = true): Fake {
  const h: Fake = {
    alive: playing, seeks: [], triggers: [], stops: 0, seekResults: [], position: { segment: "a", bar: 1, beat: 1, beatFraction: 0 },
    get playing() { return h.alive; },
    music: {
      seek: (to: string) => { h.seeks.push(to); return h.seekResults.shift() ?? { ok: true, time: 1 }; },
    } as never,
    onMusic: () => () => undefined,
    trigger: (name: string) => { h.triggers.push(name); return name !== "unknown"; },
    stop: () => { h.stops++; h.alive = false; },
  };
  Object.defineProperty(h, "music", { get: () => ({ ...h.position, seek: (to: string) => { h.seeks.push(to); return h.seekResults.shift() ?? { ok: true, time: 1 }; } }) });
  return h;
}

function fakeHost(handles: Fake[]): TransportHost & { flushed: string[]; reloaded: string[]; played: string[] } {
  const host = {
    flushed: [] as string[], reloaded: [] as string[], played: [] as string[],
    play: (path: string) => { host.played.push(path); return handles.shift() ?? fakeHandle(); },
    flush: async (path: string) => void host.flushed.push(path),
    reload: (path: string) => void host.reloaded.push(path),
  };
  return host;
}

const req = (extra: object = {}) => ({ event: "m.audioevent.json", segmentId: "a", grid, ...extra });

afterEach(() => { activeAudition.value = null; });

describe("seekText and playheadSeconds", () => {
  it("turns targets into positions", () => {
    expect(seekText(grid, { kind: "start" })).toBeNull();
    expect(seekText(grid, { kind: "bar", bar: 5 })).toBe("5:1:0");
    expect(seekText(grid, { kind: "bar", bar: 0 })).toBeNull();
    expect(seekText(grid, { kind: "cue", name: "drop" })).toBe("3:1:0");
    expect(seekText(grid, { kind: "cue", name: "nope" })).toBeNull();
    expect(seekText(grid, { kind: "seconds", seconds: 4 })).toBe("3:1:0");
    expect(seekText(grid, { kind: "seconds", seconds: Number.NaN })).toBeNull();
  });
  it("maps bar, beat and fraction to file seconds, only in its own segment", () => {
    expect(playheadSeconds(grid, { segment: "a", bar: 2, beat: 3, beatFraction: 0.5 }, "a")).toBeCloseTo(3.25, 6);
    expect(playheadSeconds(grid, { segment: "b", bar: 2, beat: 3, beatFraction: 0 }, "a")).toBeUndefined();
    expect(playheadSeconds(grid, undefined, "a")).toBeUndefined();
  });
});

describe("transport", () => {
  it("flushes, plays, registers the active audition and seeks to the cue", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const t = createTransport(host);
    await t.play(req({ from: { kind: "cue", name: "drop" } }));
    expect(host.flushed).toEqual(["m.audioevent.json"]);
    expect(t.state.value.phase).toBe("playing");
    expect(h.seeks).toEqual(["3:1:0"]);
    expect(activeAudition.value?.handle).toBe(h);
  });

  it("reports a play that made no instance", async () => {
    const t = createTransport(fakeHost([fakeHandle(false)]));
    await t.play(req());
    expect(t.state.value.phase).toBe("ended");
    expect(t.state.value.message).toMatch(/Nothing played/);
    expect(activeAudition.value).toBeNull();
  });

  it("retries a temporary seek refusal and gives up on a permanent one", async () => {
    const h = fakeHandle();
    const t = createTransport(fakeHost([h]));
    h.seekResults.push({ ok: false, reason: "poolFull", permanent: false }, { ok: false, reason: "poolFull", permanent: false });
    await t.play(req({ from: { kind: "bar", bar: 2 } }));
    t.tick();
    t.tick();
    expect(h.seeks).toHaveLength(3);
    expect(t.state.value.message).toBeNull();
    const g = fakeHandle();
    const t2 = createTransport(fakeHost([g]));
    g.seekResults.push({ ok: false, reason: "invalid", permanent: true });
    await t2.play(req({ from: { kind: "bar", bar: 2 } }));
    expect(t2.state.value.message).toMatch(/not in the playing segment/);
    t2.tick();
    expect(g.seeks).toHaveLength(1);
  });

  it("publishes the playhead while its segment plays", async () => {
    const h = fakeHandle();
    const t = createTransport(fakeHost([h]));
    await t.play(req());
    h.position = { segment: "a", bar: 2, beat: 1, beatFraction: 0 };
    t.tick();
    expect(t.playhead.value).toBeCloseTo(2, 6);
    h.position = { segment: "b", bar: 1, beat: 1, beatFraction: 0 };
    t.tick();
    expect(t.playhead.value).toBeUndefined();
  });

  it("stops, and a stop during the flush cancels the play", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const t = createTransport(host);
    const started = t.play(req());
    t.stop();
    await started;
    expect(host.played).toEqual([]);
    expect(t.state.value.phase).toBe("idle");
    await t.play(req());
    t.stop();
    expect(h.stops).toBe(1);
    expect(t.state.value.phase).toBe("ended");
    expect(activeAudition.value).toBeNull();
  });

  it("restarts at the end when loop is on, and ends when it is off", async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    const host = fakeHost([first, second]);
    const t = createTransport(host);
    t.setLoop(true);
    await t.play(req());
    first.alive = false;
    t.tick();
    await vi.waitFor(() => expect(host.played).toHaveLength(2));
    expect(t.state.value.phase).toBe("playing");
    t.setLoop(false);
    second.alive = false;
    t.tick();
    expect(t.state.value.phase).toBe("ended");
    expect(host.played).toHaveLength(2);
  });

  it("triggers a stinger on the playing handle and says when it is refused or nothing plays", async () => {
    const h = fakeHandle();
    const t = createTransport(fakeHost([h]));
    expect(t.trigger("hit")).toBe(false);
    expect(t.state.value.message).toMatch(/Press Play/);
    await t.play(req());
    expect(t.trigger("hit")).toBe(true);
    expect(h.triggers).toEqual(["hit"]);
    expect(t.state.value.message).toBeNull();
    expect(t.trigger("unknown")).toBe(false);
    expect(t.state.value.message).toMatch(/unknown/);
  });

  it("seek moves playing music, and starts it there when stopped", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const t = createTransport(host);
    await t.seek(req({ from: { kind: "seconds", seconds: 4 } }));
    expect(host.played).toHaveLength(1);
    expect(h.seeks).toEqual(["3:1:0"]);
    await t.seek(req({ from: { kind: "bar", bar: 4 } }));
    expect(host.played).toHaveLength(1);
    expect(h.seeks).toEqual(["3:1:0", "4:1:0"]);
  });

  it("reload flushes then tells the runtime; dispose stops", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const t = createTransport(host);
    await t.reload();
    expect(host.reloaded).toEqual([]);
    await t.play(req());
    await t.reload();
    expect(host.flushed).toHaveLength(2);
    expect(host.reloaded).toEqual(["m.audioevent.json"]);
    t.dispose();
    expect(h.stops).toBe(1);
    expect(t.state.value.phase).toBe("idle");
  });

  it("a new play stops the one that was playing", async () => {
    const a = fakeHandle();
    const b = fakeHandle();
    const t = createTransport(fakeHost([a, b]));
    await t.play(req());
    await t.play(req());
    expect(a.stops).toBe(1);
    expect(activeAudition.value?.handle).toBe(b);
  });
});
