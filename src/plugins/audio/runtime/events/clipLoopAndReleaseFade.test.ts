// ADR 0158 §1, §4 (E5.3b): an event clip without `loopRegion` loops the clip's own loop points, else the whole clip; a
// sustain's `release: "now"` crossfade is `releaseFade`, else `fade`. On the fake backend (the TypeScript evaluator,
// which calls the voice's own `setLoop`).
import { beforeEach, describe, expect, it } from "vitest";
import { eventKit, clip, ev } from "./eventTestKit";
import { events } from "./eventRuntime";
import { resetFileLoopPoints, setFileLoopPoints } from "../loopPoints";

const kit = eventKit();
const fake = kit.fake;

beforeEach(() => resetFileLoopPoints());

const loopEvents = (voice: number) => fake.voices[voice].events.filter((e) => e.kind === "loop");

describe("a looping clip without loopRegion", () => {
  it("loops the clip's own loop points when they are known at the play", async () => {
    await kit.boot({ "l.audioevent.json": ev(clip("a.wav", { loop: true })) });
    setFileLoopPoints("a.wav", { start: 0.5, end: 1.5 });
    events().play("l.audioevent.json");
    expect(fake.plays[0].loop).toBe(true);
    expect(loopEvents(0)).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: true }]);
  });

  it("an explicit loopRegion wins over the clip's points", async () => {
    await kit.boot({ "l.audioevent.json": ev(clip("a.wav", { loop: true, loopRegion: [2, 3] })) });
    setFileLoopPoints("a.wav", { start: 0.5, end: 1.5 });
    events().play("l.audioevent.json");
    expect(loopEvents(0)).toEqual([{ kind: "loop", start: 2, end: 3, looping: true }]);
  });

  it("a clip with no points (decoded) loops the whole clip: no region is sent", async () => {
    await kit.boot({ "l.audioevent.json": ev(clip("a.wav", { loop: true })) });
    setFileLoopPoints("a.wav", null);
    events().play("l.audioevent.json");
    expect(fake.plays[0].loop).toBe(true);
    expect(loopEvents(0)).toEqual([]);
  });

  it("points that arrive after the play are applied to the playing voice", async () => {
    await kit.boot({ "l.audioevent.json": ev(clip("a.wav", { loop: true })) });
    events().play("l.audioevent.json");
    expect(loopEvents(0)).toEqual([]); // not decoded yet
    setFileLoopPoints("a.wav", { start: 0.25, end: 0.75 });
    expect(loopEvents(0)).toEqual([{ kind: "loop", start: 0.25, end: 0.75, looping: true }]);
  });

  it("points arriving after a stop are ignored", async () => {
    await kit.boot({ "l.audioevent.json": ev(clip("a.wav", { loop: true })) });
    const h = events().play("l.audioevent.json")!;
    h.stop(0);
    setFileLoopPoints("a.wav", { start: 0.25, end: 0.75 });
    expect(loopEvents(0)).toEqual([]);
  });

  it("a sustain clip: the whole clip until points arrive, then its points; a release keeps looping false", async () => {
    await kit.boot({ "s.audioevent.json": ev(clip("a.wav", { sustain: true })) });
    const h = events().play("s.audioevent.json")!;
    expect(loopEvents(0)).toEqual([{ kind: "loop", start: 0, end: 0, looping: true }]); // whole clip, held
    setFileLoopPoints("a.wav", { start: 1, end: 2 });
    expect(loopEvents(0).at(-1)).toEqual({ kind: "loop", start: 1, end: 2, looping: true });
    h.release();
    expect(loopEvents(0).at(-1)).toEqual({ kind: "loop", start: 1, end: 2, looping: false });
  });

  it("a sustain clip released before its points arrive stays released", async () => {
    await kit.boot({ "s.audioevent.json": ev(clip("a.wav", { sustain: true })) });
    const h = events().play("s.audioevent.json")!;
    h.release();
    const n = loopEvents(0).length;
    setFileLoopPoints("a.wav", { start: 1, end: 2 });
    expect(loopEvents(0)).toHaveLength(n);
  });

  it("a sustain container's loop clip uses the clip's points when known", async () => {
    fake.durations.set("a.wav", 2);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": ev({ type: "sustain", release: "now", fade: 0.5, start: clip("a.wav"), loop: clip("b.wav"), end: clip("c.wav") }) });
    setFileLoopPoints("b.wav", { start: 0.1, end: 0.9 });
    events().play("u.audioevent.json");
    expect(loopEvents(1)).toEqual([{ kind: "loop", start: 0.1, end: 0.9, looping: true }]);
  });
});

describe("sustain release crossfade", () => {
  const sustain = (extra: Record<string, unknown>) => ev({ type: "sustain", release: "now", fade: 0.5, start: clip("a.wav"), loop: clip("b.wav"), end: clip("c.wav"), ...extra });

  it("uses releaseFade when set", async () => {
    fake.durations.set("a.wav", 2);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": sustain({ releaseFade: 1.25 }) });
    const h = events().play("u.audioevent.json")!;
    h.release();
    expect(fake.voices[1].events).toContainEqual({ kind: "stop", fadeSeconds: 1.25 });
    expect(fake.voices.at(-1)!.events).toContainEqual({ kind: "fade", to: 1, seconds: 1.25 });
  });

  it("falls back to fade when releaseFade is absent", async () => {
    fake.durations.set("a.wav", 2);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": sustain({}) });
    const h = events().play("u.audioevent.json")!;
    h.release();
    expect(fake.voices[1].events).toContainEqual({ kind: "stop", fadeSeconds: 0.5 });
    expect(fake.voices.at(-1)!.events).toContainEqual({ kind: "fade", to: 1, seconds: 0.5 });
  });

  it("releaseFade 0 is a cut, not the fallback", async () => {
    fake.durations.set("a.wav", 2);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": sustain({ releaseFade: 0 }) });
    const h = events().play("u.audioevent.json")!;
    h.release();
    expect(fake.voices[1].events).toContainEqual({ kind: "stop" }); // no fade: a cut
  });
});
