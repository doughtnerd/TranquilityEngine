// ADR 0158 E3.5b: event instances (limits, cooldown, groups, release, stop).
import { describe, expect, it, vi } from "vitest";
import { Audio } from "../index";
import { clip, ev, eventKit } from "./eventTestKit";
import { events } from "./eventRuntime";

const kit = eventKit();
const fake = kit.fake;

const warnCount = (text: string): number =>
  vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes(text)).length;

describe("limit", () => {
  const limited = (steal: "oldest" | "quietest" | "none") => ({
    "l.audioevent.json": ev(clip("a.wav"), { limit: { maxInstances: 2, steal } }),
  });

  it("steal oldest stops the oldest instance when the limit is reached", async () => {
    await kit.boot(limited("oldest"));
    const h1 = Audio.play("l.audioevent.json");
    const h2 = Audio.play("l.audioevent.json");
    const h3 = Audio.play("l.audioevent.json");
    expect(h1.playing).toBe(false);
    expect(h2.playing).toBe(true);
    expect(h3.playing).toBe(true);
    expect(fake.voices[0].events).toContainEqual({ kind: "stop", fadeSeconds: 0.01 });
    expect(fake.voices[1].stopped).toBe(false);
    expect(fake.plays).toHaveLength(3);
  });

  it("steal quietest stops the quietest instance", async () => {
    await kit.boot(limited("quietest"));
    const h1 = Audio.play("l.audioevent.json"); // loudness 1, the oldest
    const h2 = Audio.play("l.audioevent.json", { volume: 0.2 }); // loudness 0.2, the quietest
    const h3 = Audio.play("l.audioevent.json", { volume: 0.5 }); // the limit is reached: steals h2, not h1
    expect(h1.playing).toBe(true);
    expect(h2.playing).toBe(false);
    expect(h3.playing).toBe(true);
    expect(fake.voices[1].events).toContainEqual({ kind: "stop", fadeSeconds: 0.01 });
    expect(fake.voices[0].stopped).toBe(false);
  });

  it("steal none refuses the new instance (inert handle)", async () => {
    await kit.boot(limited("none"));
    const h1 = Audio.play("l.audioevent.json");
    const h2 = Audio.play("l.audioevent.json");
    const h3 = Audio.play("l.audioevent.json");
    expect(h3.playing).toBe(false);
    expect(h1.playing).toBe(true);
    expect(h2.playing).toBe(true);
    expect(fake.plays).toHaveLength(2);
  });
});

describe("cooldown", () => {
  it("a play sooner than cooldown seconds after the last is refused; later is allowed", async () => {
    await kit.boot({ "c.audioevent.json": ev(clip("a.wav"), { cooldown: 0.05 }) });
    const realNow = events().now;
    try {
      let t = 10;
      events().now = () => t;
      expect(Audio.play("c.audioevent.json").playing).toBe(true);
      expect(fake.plays).toHaveLength(1);

      t = 10.02; // 0.02 s after the last play: refused, and it does not restart the cooldown
      expect(Audio.play("c.audioevent.json").playing).toBe(false);
      expect(fake.plays).toHaveLength(1);

      t = 10.06; // 0.06 s after the last allowed play: allowed
      expect(Audio.play("c.audioevent.json").playing).toBe(true);
      expect(fake.plays).toHaveLength(2);
    } finally {
      events().now = realNow;
    }
  });
});

describe("groups", () => {
  it("1,024 live instances exhaust the group ids: extra ones play but warn once and get no local parameters", async () => {
    await kit.boot({ "one.audioevent.json": ev(clip("a.wav")) });
    const handles = [];
    for (let i = 0; i < 1025; i++) handles.push(Audio.play("one.audioevent.json"));
    expect(fake.plays).toHaveLength(1025);
    expect(fake.plays.slice(0, 1024).map((p) => p.group)).toEqual(Array.from({ length: 1024 }, (_, i) => i + 1));
    expect(fake.plays[1024].group).toBe(0);
    expect(handles[1024].playing).toBe(true);
    expect(warnCount("more than 1024 event instances at once")).toBe(1);

    Audio.play("one.audioevent.json"); // a further extra one: still no second warning
    expect(warnCount("more than 1024 event instances at once")).toBe(1);
  });

  it("a retired instance's group is reused", async () => {
    await kit.boot({ "one.audioevent.json": ev(clip("a.wav")) });
    Audio.play("one.audioevent.json");
    const group = fake.plays[0].group;
    expect(group).toBeGreaterThan(0);
    fake.voices[0].end();
    events().update(1 / 60);
    Audio.play("one.audioevent.json");
    expect(fake.plays[1].group).toBe(group);
  });
});

describe("release and stop", () => {
  it("release twice is a no-op the second time", async () => {
    await kit.boot({ "s.audioevent.json": ev(clip("a.wav", { sustain: true, loopRegion: [0.5, 1.5] })) });
    const h = Audio.play("s.audioevent.json");
    h.release();
    const afterOnce = [...fake.voices[0].events];
    expect(afterOnce.filter((e) => e.kind === "loop")).toHaveLength(2);
    expect(() => h.release()).not.toThrow();
    expect(fake.voices[0].events).toEqual(afterOnce);
    expect(h.playing).toBe(true);
  });

  it("release on an event with no sustain is a no-op", async () => {
    await kit.boot({ "n.audioevent.json": ev(clip("a.wav")) });
    const h = Audio.play("n.audioevent.json");
    const before = [...fake.voices[0].events];
    expect(() => h.release()).not.toThrow();
    expect(fake.voices[0].events).toEqual(before);
    expect(fake.voices[0].events.some((e) => e.kind === "loop")).toBe(false);
    expect(h.playing).toBe(true);
    expect(fake.voices[0].stopped).toBe(false);
  });

  it("stop(fade) fades every voice of the instance", async () => {
    await kit.boot({ "m.audioevent.json": ev({ type: "layer", children: [clip("a.wav"), clip("b.wav")] }) });
    const h = Audio.play("m.audioevent.json");
    expect(fake.voices).toHaveLength(2);
    h.stop(0.5);
    for (const v of fake.voices) expect(v.events).toContainEqual({ kind: "stop", fadeSeconds: 0.5 });
    expect(h.playing).toBe(false);
  });
});
