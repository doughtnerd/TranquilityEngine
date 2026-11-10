// ADR 0158 E3.5a: containers on the fake backend (random, sequence, switch, blend, layer, sustain, continuous).
import { afterEach, describe, expect, it } from "vitest";
import { eventKit, clip, ev } from "./eventTestKit";
import { events, type EventInstance } from "./eventRuntime";

const kit = eventKit();
const fake = kit.fake;

/** Restore the real clock after the sequence tests replace `now` (`_reset` does not). */
afterEach(() => {
  events().now = () => performance.now() / 1000;
});

/** The clip paths of `n` plays of `path` (each a new instance; `parameters` for a labelled or numeric local). */
function picks(path: string, n: number, world = 0, parameters?: Record<string, number | string>): string[] {
  const from = fake.plays.length;
  for (let i = 0; i < n; i++) events().play(path, parameters ? { parameters } : {}, world);
  return fake.plays.slice(from).map((p) => p.path);
}

/** The voices a play added, in order (the same objects the fake keeps, so their getters are live). */
function playOne(path: string, parameters?: Record<string, number | string>): { h: EventInstance; voices: typeof fake.voices } {
  const from = fake.voices.length;
  const h = events().play(path, parameters ? { parameters } : {})!;
  return { h, voices: fake.voices.slice(from) };
}

const SURFACE = [{ name: "Surface", labels: ["Grass", "Stone", "Mud"], default: "Grass" }];
const SPEED = [{ name: "Speed", min: 0, max: 10, default: 0, seekSpeed: 0 }];

/** A blend of a (range 0..4) and b (range 6..10) on Speed, with the given fade width. */
const BLEND = (fade: number) => ev(
  { type: "blend", parameter: "Speed", children: [clip("a.wav", { range: [0, 4], fade }), clip("b.wav", { range: [6, 10], fade })] },
  { parameters: SPEED },
);

/** A sustain: start a.wav, loop b.wav, end c.wav. */
const SUSTAIN = (release: "now" | "loopEnd") => ev(
  { type: "sustain", release, fade: 0.5, start: clip("a.wav"), loop: clip("b.wav"), end: clip("c.wav") },
);

/** Advance the heard clock to `end - 0.2` and poll, so the continuous runner's timer (due `end - 0.25`) fires. */
function pollBefore(end: number): void {
  kit.setTime(end - 0.2);
  events().update(1 / 60);
}

describe("random", () => {
  it("weights bias the picks (seed 7)", async () => {
    const root = () => ev({ type: "random", children: [clip("a.wav", { weight: 1 }), clip("b.wav", { weight: 9 }), clip("c.wav", { weight: 0 })] });
    await kit.boot({ "w.audioevent.json": root() });
    const first = picks("w.audioevent.json", 200);
    expect(first.filter((p) => p === "b.wav").length).toBeGreaterThanOrEqual(150);
    expect(first.filter((p) => p === "a.wav").length).toBeGreaterThan(0);
    expect(first).not.toContain("c.wav"); // weight 0 is never picked
    // The same seed on a fresh boot gives the same picks.
    events()._reset();
    await kit.boot({ "w.audioevent.json": root() });
    expect(picks("w.audioevent.json", 200)).toEqual(first);
  });

  it("avoidRepeat n skips the last n picks", async () => {
    await kit.boot({ "v.audioevent.json": ev({ type: "random", avoidRepeat: 2, children: [clip("a.wav"), clip("b.wav"), clip("c.wav"), clip("d.wav")] }) });
    const p = picks("v.audioevent.json", 60);
    for (let i = 2; i < p.length; i++) expect([p[i - 1], p[i - 2]]).not.toContain(p[i]);
    expect(new Set(p).size).toBe(4);
  });
});

describe("sequence (step)", () => {
  const SEQ = () => ev({ type: "sequence", children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] });

  it("advances one child per play and wraps", async () => {
    await kit.boot({ "q.audioevent.json": SEQ() });
    expect(picks("q.audioevent.json", 7)).toEqual(["a.wav", "b.wav", "c.wav", "a.wav", "b.wav", "c.wav", "a.wav"]);
  });

  it("reset seconds idle returns to the first child", async () => {
    await kit.boot({ "q.audioevent.json": ev({ type: "sequence", reset: 5, children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] }) });
    const at = (s: number): string[] => {
      events().now = () => s;
      return picks("q.audioevent.json", 1);
    };
    // Plays 4 s apart are under the 5 s reset: the sequence carries on.
    expect([at(0), at(4), at(8)].flat()).toEqual(["a.wav", "b.wav", "c.wav"]);
    // 6 s idle since the last play: back to the first child.
    expect(at(14)).toEqual(["a.wav"]);
  });
});

describe("switch", () => {
  const SWITCH = (onChange: "keep" | "restart" | "crossfade", extra: Record<string, unknown> = {}) => ev(
    {
      type: "switch", parameter: "Surface", onChange, ...extra,
      children: [clip("a.wav", { value: "Grass" }), clip("b.wav", { value: "Stone" })],
    },
    { parameters: SURFACE },
  );

  it("onChange keep leaves the playing child and uses the new value next play", async () => {
    await kit.boot({ "s.audioevent.json": SWITCH("keep") });
    const h = events().play("s.audioevent.json")!;
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav"]);
    h.setParameter("Surface", "Stone");
    expect(fake.plays).toHaveLength(1);
    expect(fake.voices[0].stopped).toBe(false);
    expect(picks("s.audioevent.json", 1, 0, { Surface: "Stone" })).toEqual(["b.wav"]);
  });

  it("onChange restart stops the child and starts the new one", async () => {
    await kit.boot({ "s.audioevent.json": SWITCH("restart") });
    const h = events().play("s.audioevent.json")!;
    h.setParameter("Surface", "Stone");
    expect(fake.voices[0].stopped).toBe(true);
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(fake.voices[1].playing).toBe(true);
  });

  it("onChange crossfade fades the old child out and the new one in", async () => {
    await kit.boot({ "s.audioevent.json": SWITCH("crossfade", { crossfade: 0.8 }) });
    const h = events().play("s.audioevent.json")!;
    h.setParameter("Surface", "Stone");
    expect(fake.voices[0].events).toContainEqual({ kind: "stop", fadeSeconds: 0.8 });
    expect(fake.voices[1].events).toContainEqual({ kind: "fade", to: 1, seconds: 0.8 });
    expect(fake.voices[1].playing).toBe(true);
  });

  it("falls back to default for an unmatched value", async () => {
    await kit.boot({
      "s.audioevent.json": ev(
        { type: "switch", parameter: "Surface", default: "Stone", onChange: "keep", children: [clip("a.wav", { value: "Grass" }), clip("b.wav", { value: "Stone" })] },
        { parameters: SURFACE },
      ),
    });
    expect(picks("s.audioevent.json", 1, 0, { Surface: "Mud" })).toEqual(["b.wav"]); // no child for Mud: the default
    expect(picks("s.audioevent.json", 1, 0, { Surface: "Grass" })).toEqual(["a.wav"]);
  });
});

describe("blend", () => {
  it("plays every child, each with an equal-power weight from its range and edges", async () => {
    await kit.boot({ "b.audioevent.json": BLEND(2) });
    const { h, voices } = playOne("b.audioevent.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    const [a, b] = voices;
    expect(a.volume).toBeCloseTo(1); // inside its range
    expect(b.volume).toBeCloseTo(0); // outside: virtual
    const at = (speed: number): void => {
      h.setParameter("Speed", speed);
      events().update(1 / 60);
    };
    at(4); // a's top edge: full; b's bottom fade ends here: silent
    expect(a.volume).toBeCloseTo(1);
    expect(b.volume).toBeCloseTo(0);
    at(6); // the other way round
    expect(a.volume).toBeCloseTo(0);
    expect(b.volume).toBeCloseTo(1);
    // Mid-crossfade both are partway in. The easing is quadratic, so the powers sum to ~1.1 at the middle; asserted
    // loosely, as the curve's comment says "close to equal power".
    at(5);
    expect(a.volume).toBeGreaterThan(0.05);
    expect(a.volume).toBeLessThan(0.95);
    expect(a.volume ** 2 + b.volume ** 2).toBeGreaterThan(0.9);
    expect(a.volume ** 2 + b.volume ** 2).toBeLessThan(1.25);
  });

  it("fade width sets the edge ramp in parameter units; out-of-range children stay virtual (playing, silent)", async () => {
    await kit.boot({ "f2.audioevent.json": BLEND(2), "f0.audioevent.json": BLEND(0) });
    const soft = playOne("f2.audioevent.json");
    const hard = playOne("f0.audioevent.json");
    // Speed 0: b is below its range, so it plays on silently (virtual), not stopped.
    expect(soft.voices[1].playing).toBe(true);
    expect(soft.voices[1].stopped).toBe(false);
    expect(soft.voices[1].volume).toBeCloseTo(0);
    const at = (speed: number): void => {
      for (const i of [soft.h, hard.h]) i.setParameter("Speed", speed);
      events().update(1 / 60);
    };
    // A width of 2 ramps a from 4 to 6: half a unit into the ramp it is partway, and it falls as the speed rises.
    at(4.5);
    const s45 = soft.voices[0].volume;
    at(5);
    const s5 = soft.voices[0].volume;
    at(5.5);
    const s55 = soft.voices[0].volume;
    expect(s45).toBeGreaterThan(s5);
    expect(s5).toBeGreaterThan(s55);
    expect(s5).toBeGreaterThan(0);
    expect(s5).toBeLessThan(1);
    // A width of 0 is a near-jump: at 4.5 (past the top edge) a is already silent.
    expect(hard.voices[0].volume).toBeCloseTo(0);
    at(6);
    expect(soft.voices[0].volume).toBeCloseTo(0);
    expect(soft.voices[1].volume).toBeCloseTo(1);
    expect(soft.voices[1].stopped).toBe(false);
  });
});

describe("layer", () => {
  it("plays every child together", async () => {
    await kit.boot({ "l.audioevent.json": ev({ type: "layer", children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] }) });
    const h = events().play("l.audioevent.json")!;
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "c.wav"]);
    expect(new Set(fake.plays.map((p) => p.group)).size).toBe(1); // one instance
    expect(fake.voices.every((v) => v.playing)).toBe(true);
    expect(h.voiceCount).toBe(3);
  });
});

describe("sustain container", () => {
  it("start then loop play back to back (loop scheduled with `at`)", async () => {
    fake.durations.set("a.wav", 2);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": SUSTAIN("now") });
    const h = events().play("u.audioevent.json")!;
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(fake.plays[1].at).toBe(2); // the loop starts exactly where the start clip ends
    expect(fake.plays[1].loop).toBe(true);
    expect(h.playing).toBe(true);
  });

  it("release now: end plays with a crossfade of `fade` seconds", async () => {
    fake.durations.set("a.wav", 2);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": SUSTAIN("now") });
    const h = events().play("u.audioevent.json")!;
    h.release();
    expect(fake.voices[1].events).toContainEqual({ kind: "stop", fadeSeconds: 0.5 }); // the loop fades out
    expect(fake.plays.at(-1)!.path).toBe("c.wav");
    expect(fake.voices.at(-1)!.events).toContainEqual({ kind: "fade", to: 1, seconds: 0.5 }); // end fades in
    expect(fake.voices[1].stopped).toBe(true);
  });

  it("release loopEnd: end starts at the end of the current loop pass", async () => {
    fake.durations.set("a.wav", 2);
    fake.durations.set("b.wav", 1);
    fake.horizonTime = 0;
    await kit.boot({ "u.audioevent.json": SUSTAIN("loopEnd") });
    const h = events().play("u.audioevent.json")!;
    expect(fake.plays[1].at).toBe(2);
    fake.horizonTime = 2.5; // mid-way through the first loop pass (2 s to 3 s)
    h.release();
    const end = fake.plays.at(-1)!;
    expect(end.path).toBe("c.wav");
    expect(end.at).toBe(3); // the end of the pass that is playing, sample-accurate
    expect(fake.voices[1].stopped).toBe(false); // the loop plays out its pass
    expect(fake.voices[1].events).toContainEqual({ kind: "loop", start: 0, end: 0, looping: false });
  });
});

describe("continuous", () => {
  it("random continuous with known lengths schedules the next clip with `at`, counting no late start", async () => {
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1.5);
    fake.horizonTime = 0;
    await kit.boot({ "k.audioevent.json": ev({ type: "random", mode: "continuous", children: [clip("a.wav"), clip("b.wav")] }) });
    events().play("k.audioevent.json");
    for (let i = 1; i < 6; i++) {
      const prev = fake.plays[i - 1];
      const end = prev.at! + fake.durations.get(prev.path)!;
      pollBefore(end);
      expect(fake.plays).toHaveLength(i + 1);
      expect(fake.plays[i].at).toBeCloseTo(end);
    }
    expect(events().lateStartTotal).toBe(0);
    expect(events().debugRows().map((r) => r.lateStarts)).toEqual([0]);
  });

  it("sequence continuous with known lengths plays the children back to back and loops", async () => {
    fake.durations.set("a.wav", 1);
    fake.durations.set("b.wav", 1.5);
    fake.durations.set("c.wav", 0.5);
    fake.horizonTime = 0;
    await kit.boot({ "k.audioevent.json": ev({ type: "sequence", mode: "continuous", loop: true, children: [clip("a.wav"), clip("b.wav"), clip("c.wav")] }) });
    events().play("k.audioevent.json");
    for (let i = 1; i < 6; i++) {
      const prev = fake.plays[i - 1];
      const end = prev.at! + fake.durations.get(prev.path)!;
      pollBefore(end);
      expect(fake.plays).toHaveLength(i + 1);
      expect(fake.plays[i].at).toBeCloseTo(end);
    }
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "c.wav", "a.wav", "b.wav", "c.wav"]);
    expect(events().lateStartTotal).toBe(0);
  });

  it("unknown lengths: the next clip starts on the previous one's end (polled) and counts a late start", async () => {
    await kit.boot({ "k.audioevent.json": ev({ type: "sequence", mode: "continuous", loop: true, children: [clip("a.wav"), clip("b.wav")] }) });
    events().play("k.audioevent.json");
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav"]);
    // The length is unknown, so the runner polls for the end: a still playing at 0.06 s, nothing new yet.
    kit.setTime(0.06);
    events().update(1 / 60);
    expect(fake.plays).toHaveLength(1);
    // a ends; the next poll starts b one frame late, and the debug panel counts it.
    fake.voices[0].end();
    kit.setTime(0.12);
    events().update(1 / 60);
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav"]);
    expect(events().lateStartTotal).toBe(1);
    expect(events().debugRows()[0].lateStarts).toBe(1);
    // b ends; the sequence loops back to a, late again.
    fake.voices[1].end();
    kit.setTime(0.2);
    events().update(1 / 60);
    expect(fake.plays.map((p) => p.path)).toEqual(["a.wav", "b.wav", "a.wav"]);
    expect(events().lateStartTotal).toBe(2);
  });
});
