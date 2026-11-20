// ADR 0268: the editor's audition through its interface, against a fake audio host. 120 bpm 4/4 is 0.5 s per beat, 2 s per bar.
import { describe, expect, it, vi } from "vitest";
import { emptySegment } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid } from "../../../../engine/audio/musicGrid";
import { createAudition, type AuditionRequest, type AuditionTarget } from "./audition";
import { fakeHandle, fakeHost } from "./auditionFixtures";

const segment = { ...emptySegment("a"), tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }], cues: [{ name: "entry", at: "1:1:0" }, { name: "late", at: "2:3:0" }, { name: "drop", at: "3:1:0" }] };
const grid = compileSegmentGrid(segment, { endSeconds: 60 });
const MUSIC = "m.audioevent.json";
const EVENT = "e.audioevent.json";

/** A music audition of segment "a" (the segment view's transport). */
const req = (music: Partial<NonNullable<AuditionRequest["music"]>> = {}, extra: Partial<AuditionRequest> = {}): AuditionRequest =>
  ({ event: MUSIC, ...extra, music: { segmentId: "a", grid, ...music } });
/** A whole-event audition (the Event editor's). */
const whole = (parameters: Record<string, number | string> = {}): AuditionRequest => ({ event: EVENT, parameters });

describe("play and stop", () => {
  it("flushes the event, then plays it with the request's parameters", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const a = createAudition(host);
    await a.play(whole({ Speed: 3 }));
    expect(host.flushed).toEqual([EVENT]);
    expect(host.played).toEqual([EVENT]);
    expect(host.params).toEqual([{ Speed: 3 }]);
    expect(a.state.value).toMatchObject({ phase: "playing", event: EVENT, segmentId: null, starting: false, played: true });
    expect(a.notice.value).toBeNull();
  });

  it("a Stop, a newer Play or the panel closing during the flush cancels the play (the epoch)", async () => {
    const host = fakeHost();
    host.hold();
    const a = createAudition(host);
    const started = a.play(whole());
    expect(a.state.value.starting).toBe(true);
    a.stop();
    host.holdFlush!();
    await started;
    expect(host.played).toEqual([]);
    expect(a.state.value.phase).toBe("idle");

    // The Event editor's panel closes while its Play is flushing: nothing plays after it.
    const again = a.play(whole());
    a.stop({ event: EVENT, segmentId: null });
    host.holdFlush!();
    await again;
    expect(host.played).toEqual([]);

    // Two Plays: only the second one plays.
    const one = a.play(whole());
    const release1 = host.holdFlush!;
    const two = a.play(req());
    release1();
    host.holdFlush!();
    await Promise.all([one, two]);
    expect(host.played).toEqual([MUSIC]);
  });

  it("stops what plays, and a new Play stops the one that was playing", async () => {
    const x = fakeHandle();
    const y = fakeHandle();
    const a = createAudition(fakeHost([x, y]));
    await a.play(whole());
    await a.play(req());
    expect(x.stops).toBe(1);
    expect(a.state.value.event).toBe(MUSIC);
    a.stop();
    expect(y.stops).toBe(1);
    expect(a.state.value.phase).toBe("ended");
  });

  it("stops with a match only the audition it names", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    await a.play(req());
    a.stop({ event: EVENT });
    a.stop({ event: MUSIC, segmentId: null }); // the Event editor's whole-event audition of the same event: not this one
    a.stop({ event: MUSIC, segmentId: "b" });
    expect(h.stops).toBe(0);
    a.stop({ event: MUSIC, segmentId: "a" });
    expect(h.stops).toBe(1);
  });

  it("releases only while playing", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    a.release();
    expect(h.releases).toBe(0);
    await a.play(whole());
    a.release();
    a.release();
    expect(h.releases).toBe(1);
    expect(a.state.value.phase).toBe("released");
  });

  it("dispose stops and forgets", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    await a.play(req());
    a.dispose();
    expect(h.stops).toBe(1);
    expect(a.state.value.phase).toBe("idle");
    expect(a.state.value.event).toBeNull();
  });
});

describe("notices", () => {
  it("says when a play made nothing, once, whoever played it", async () => {
    const a = createAudition(fakeHost([fakeHandle(false)]));
    await a.play(req());
    expect(a.state.value.phase).toBe("ended");
    expect(a.notice.value).toMatch(/Nothing played/);
    const b = createAudition(fakeHost([fakeHandle(false)]));
    await b.play(whole());
    expect(b.notice.value).toBe(a.notice.value);
  });

  it("names locked audio and a failed backend, and says nothing before the first play", async () => {
    const host = fakeHost([Object.assign(fakeHandle(false), { reason: "locked" as const })]);
    const a = createAudition(host);
    expect(a.notice.value).toBeNull();
    await a.play(whole());
    expect(a.notice.value).toMatch(/locked by the browser/);
    host.status = "failed";
    a.tick();
    expect(a.notice.value).toMatch(/failed to start/);
    expect(a.state.value.backend).toBe("fake");
  });
});

describe("the instance", () => {
  it("lists only its own voices, and ends when its row is gone and its handle stopped (tails included)", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    host.events = [{ id: 1, asset: EVENT }];
    host.play = (path, parameters) => {
      host.played.push(path);
      host.params.push(parameters);
      host.events = [{ id: 1, asset: EVENT }, { id: 2, asset: `asset:${EVENT}` }];
      return h;
    };
    const a = createAudition(host);
    await a.play(whole());
    host.voices = [{ id: 7, clip: "a.ogg", state: "playing", gain: 1, event: 2 }, { id: 8, clip: "b.ogg", state: "playing", gain: 1, event: 1 }];
    a.tick();
    expect(a.state.value.voices.map((v) => v.id)).toEqual([7]);
    h.alive = false; // the handle is done, but its release tail still sounds
    a.tick();
    expect(a.state.value.phase).toBe("playing");
    host.events = [{ id: 1, asset: EVENT }];
    a.tick();
    expect(a.state.value.phase).toBe("ended");
    expect(a.state.value.voices).toEqual([]);
  });

  it("ends by its handle when the host has no rows", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    await a.play(whole());
    h.alive = false;
    a.tick();
    expect(a.state.value.phase).toBe("ended");
  });

  it("is stale once the event is written after it started, and a new Play clears it", async () => {
    const host = fakeHost();
    host.assets.set(EVENT, {});
    const a = createAudition(host);
    await a.play(whole());
    a.tick();
    expect(a.state.value.stale).toBe(false);
    host.assets.set(EVENT, {});
    a.tick();
    expect(a.state.value.stale).toBe(true);
    await a.play(whole());
    expect(a.state.value.stale).toBe(false);
  });
});

describe("live parameters", () => {
  it("a slider move reaches whatever plays its event, the segment transport's music too", async () => {
    const music = fakeHandle();
    const a = createAudition(fakeHost([music]));
    a.setParameter(MUSIC, "Intensity", 0.5);
    expect(a.overrides.value).toEqual({ [MUSIC]: { Intensity: 0.5 } });
    await a.play(req());
    a.setParameter(MUSIC, "Intensity", 0.8);
    expect(music.sets).toEqual([["Intensity", 0.8]]);
    a.setParameter(EVENT, "Speed", 2); // another event's slider: remembered, not sent
    expect(music.sets).toHaveLength(1);
    expect(a.overrides.value).toEqual({ [MUSIC]: { Intensity: 0.8 }, [EVENT]: { Speed: 2 } });
  });

  it("holds a requested parameter until the seek has landed and the start segment sounds", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    expect(a.requestParameter("state", "2")).toBe(false);
    expect(a.notice.value).toMatch(/Press Play first/);
    h.seekResults.push({ ok: false, reason: "poolFull", permanent: false });
    await a.play(req({ from: { kind: "bar", bar: 2 } }));
    expect(a.requestParameter("state", "2")).toBe(true);
    h.position = { segment: null, bar: 1, beat: 1, beatFraction: 0 };
    a.tick(); // the seek lands now, but the music is still priming
    expect(h.sets).toEqual([]);
    h.position = { segment: "a", bar: 2, beat: 1, beatFraction: 0 };
    a.tick();
    expect(h.sets).toEqual([["state", "2"]]);
    a.tick();
    expect(h.sets).toHaveLength(1);
  });
});

describe("loop", () => {
  it("restarts a music audition at its end when loop is on, and ends when it is off", async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    const host = fakeHost([first, second]);
    const a = createAudition(host);
    a.setLoop(true);
    await a.play(req());
    first.alive = false;
    a.tick();
    await vi.waitFor(() => expect(host.played).toHaveLength(2));
    expect(a.state.value.phase).toBe("playing");
    a.setLoop(false);
    second.alive = false;
    a.tick();
    expect(a.state.value.phase).toBe("ended");
    expect(host.played).toHaveLength(2);
  });

  it("never restarts a looping music audition that another audition stopped", async () => {
    const music = fakeHandle();
    const event = fakeHandle();
    const host = fakeHost([music, event]);
    const a = createAudition(host);
    a.setLoop(true);
    await a.play(req());
    await a.play(whole()); // the Event editor's Play
    a.tick();
    a.tick();
    await Promise.resolve();
    expect(host.played).toEqual([MUSIC, EVENT]);
    expect(music.stops).toBe(1);
    expect(event.stops).toBe(0);
    expect(a.state.value).toMatchObject({ phase: "playing", event: EVENT });
  });

  it("doesn't loop a whole-event audition", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const a = createAudition(host);
    a.setLoop(true);
    await a.play(whole());
    h.alive = false;
    a.tick();
    await Promise.resolve();
    expect(host.played).toHaveLength(1);
    expect(a.state.value.phase).toBe("ended");
  });
});

describe("music options", () => {
  it("turns targets into the position the music starts at", async () => {
    /** The position a play from `from` asks the host to start at (null: none, from the start or off the grid). */
    const startAt = async (from: AuditionTarget): Promise<string | null> => {
      const host = fakeHost([fakeHandle()]);
      await createAudition(host).play(req({ from }));
      return host.positions[0] ?? null;
    };
    expect(await startAt({ kind: "start" })).toBeNull();
    expect(await startAt({ kind: "bar", bar: 5 })).toBe("5:1:0");
    expect(await startAt({ kind: "bar", bar: 0 })).toBeNull();
    expect(await startAt({ kind: "cue", name: "drop" })).toBe("3:1:0");
    expect(await startAt({ kind: "cue", name: "nope" })).toBeNull();
    expect(await startAt({ kind: "seconds", seconds: 4 })).toBe("3:1:0");
    expect(await startAt({ kind: "seconds", seconds: Number.NaN })).toBeNull();
  });

  it("says a target off the grid is not on it", async () => {
    const a = createAudition(fakeHost());
    await a.play(req({ from: { kind: "cue", name: "nope" } }));
    expect(a.notice.value).toBe("That position is not on the grid.");
  });

  // F-41: every "start from" choice starts the music there once; a seek after the start restarted the playhead.
  it.each([
    ["bar 1", { kind: "bar", bar: 1 }, "1:1:0"],
    ["bar 2", { kind: "bar", bar: 2 }, "2:1:0"],
    ["the entry cue at 1:1:0", { kind: "cue", name: "entry" }, "1:1:0"],
    ["a later cue", { kind: "cue", name: "late" }, "2:3:0"],
    ["the drop cue", { kind: "cue", name: "drop" }, "3:1:0"],
    ["a time", { kind: "seconds", seconds: 4 }, "3:1:0"],
  ] as const)("starts from %s at the position, without a seek after the start", async (_n, from, text) => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    host.positionOk = true;
    const a = createAudition(host);
    await a.play(req({ from, startAtSegment: true }));
    expect(host.positions).toEqual([text]);
    a.tick();
    a.tick();
    expect(h.seeks).toEqual([]);
    expect(h.stops).toBe(0);
    expect(a.state.value.message).toBeNull();
  });

  it("starts from the start with no position and no seek, and falls back to a seek when the position is refused", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    host.positionOk = true;
    await createAudition(host).play(req({ from: { kind: "start" } }));
    expect(host.positions).toEqual([]);
    expect(h.seeks).toEqual([]);
    const g = fakeHandle();
    const refusing = fakeHost([g]);
    await createAudition(refusing).play(req({ from: { kind: "bar", bar: 2 } }));
    expect(refusing.positions).toEqual(["2:1:0"]);
    expect(g.seeks).toEqual(["2:1:0"]);
  });

  it("retries a temporary seek refusal and gives up on a permanent one", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    h.seekResults.push({ ok: false, reason: "poolFull", permanent: false }, { ok: false, reason: "poolFull", permanent: false });
    await a.play(req({ from: { kind: "bar", bar: 2 } }));
    a.tick();
    a.tick();
    expect(h.seeks).toHaveLength(3);
    expect(a.state.value.message).toBeNull();
    const g = fakeHandle();
    const b = createAudition(fakeHost([g]));
    g.seekResults.push({ ok: false, reason: "invalid", permanent: true });
    await b.play(req({ from: { kind: "bar", bar: 2 } }));
    expect(b.notice.value).toMatch(/not in the playing segment/);
    b.tick();
    expect(g.seeks).toHaveLength(1);
  });

  it("publishes the playhead while its segment plays, with an edited grid", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    await a.play(req());
    h.position = { segment: "a", bar: 2, beat: 3, beatFraction: 0.5 };
    a.tick();
    expect(a.playhead.value).toBeCloseTo(3.25, 6);
    const slow = compileSegmentGrid({ ...segment, tempo: [{ at: "1:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] }, { endSeconds: 60 });
    h.position = { segment: "a", bar: 2, beat: 1, beatFraction: 0 };
    a.tick(slow);
    expect(a.playhead.value).toBeCloseTo(4, 6);
    h.position = { segment: "b", bar: 1, beat: 1, beatFraction: 0 };
    a.tick();
    expect(a.playhead.value).toBeUndefined();
    a.stop();
    expect(a.playhead.value).toBeUndefined();
  });

  it("starts at a segment only when asked, and says so when the runtime can't (F-15)", async () => {
    const host = fakeHost([fakeHandle(), fakeHandle()]);
    const a = createAudition(host);
    await a.play(req());
    expect(host.started).toEqual([]);
    await a.play(req({ segmentId: "nope", startAtSegment: true }));
    expect(host.started).toEqual(["nope"]);
    expect(a.notice.value).toMatch(/can't be started on its own/);
  });

  it("applies the audible stems at play and when they change while playing (F-14)", async () => {
    const host = fakeHost([fakeHandle()]);
    const a = createAudition(host);
    a.setAudibleStems("a", ["drums"]);
    expect(host.stemCalls).toEqual([]); // nothing plays yet
    await a.play(req());
    expect(host.stemCalls).toEqual([["drums"]]);
    a.setAudibleStems("a", null);
    expect(host.stemCalls).toEqual([["drums"], null]);
  });

  it("seek moves playing music of the same event, and starts it there when stopped", async () => {
    const h = fakeHandle();
    const host = fakeHost([h]);
    const a = createAudition(host);
    await a.seek(req({ from: { kind: "seconds", seconds: 4 } }));
    expect(host.played).toHaveLength(1);
    expect(h.seeks).toEqual(["3:1:0"]);
    await a.seek(req({ from: { kind: "bar", bar: 4 } }));
    expect(host.played).toHaveLength(1);
    expect(h.seeks).toEqual(["3:1:0", "4:1:0"]);
    await a.seek(req({ from: { kind: "bar", bar: 2 } }, { event: "other.audioevent.json" }));
    expect(host.played).toHaveLength(2);
  });

  it("triggers a stinger on the playing handle, says when it is refused or nothing plays, and offers it only to its event", async () => {
    const h = fakeHandle();
    const a = createAudition(fakeHost([h]));
    expect(a.trigger("hit")).toBe(false);
    expect(a.state.value.message).toMatch(/Press Play/);
    expect(a.stingerTarget(MUSIC)).toBeNull();
    await a.play(req());
    const target = a.stingerTarget(MUSIC);
    expect(target).not.toBeNull();
    expect(a.stingerTarget(MUSIC)).toBe(target); // one object while it plays
    expect(a.stingerTarget(EVENT)).toBeNull();
    expect(target!.trigger("hit")).toBe(true);
    expect(h.triggers).toEqual(["hit"]);
    expect(a.notice.value).toBeNull();
    expect(a.trigger("unknown")).toBe(false);
    expect(a.notice.value).toMatch(/unknown/);
    a.stop();
    expect(a.stingerTarget(MUSIC)).toBeNull();
  });

  it("reload flushes then tells the runtime, only while something plays", async () => {
    const host = fakeHost([fakeHandle()]);
    const a = createAudition(host);
    await a.reload();
    expect(host.reloaded).toEqual([]);
    await a.play(req());
    await a.reload();
    expect(host.flushed).toHaveLength(2);
    expect(host.reloaded).toEqual([MUSIC]);
  });
});
