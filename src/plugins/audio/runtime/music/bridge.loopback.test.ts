// ADR 0166 R3b acceptance: bridges, pool-full and natural advances on the real core, through `Audio.play`,
// `setParameter` and the engine's audio systems on T1's deterministic-clock fixture (`musicLoopback`). 120 bpm 4/4: a
// beat is 24,000 frames, a bar 96,000. Levels are DC clips (int16 on the wire, so a level is what the first sample shows).
//
// - A bridge's two seams: A to the bridge a cut on A's bar (sample-exact), the bridge to B a linear crossfade on the
//   bridge's exit cue, nulled against a same-frame linear reference within the 2e-5 of R3a's pickup seam (one f32 ramp
//   on this core; T2's goldens bound it after the flip).
// - Pool full keeps A: the core's admission refuses B (a temporary `poolFull`); at the bridge's cancel point the change
//   is dropped, and A plays on, sample for sample, through where the bridge would have started.
// - A playlist's natural advance applies the rule's fade-in.
// - The sound-lab sample's calm → combat rule with its riser bridge, as shipped.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { musicLoopback, resetMusicLoopback, RATE, type MusicLoopback } from "./testing/loopbackClock";

afterEach(() => resetMusicLoopback());

const BAR = 2 * RATE;
const LEVEL = { a: 0.25, b: 0.5, r: 0.125 };
const TEMPO = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const seg = (id: string, clip: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, value: id, tempo: TEMPO, tracks: [{ name: "t", clip }], ...extra });
/** The bridge: 1.5 s of audio, its exit cue at beat 3 (1 s), so half a second rings past it into the crossfade. */
const riser = () => ({ type: "segment", id: "R", tempo: TEMPO, cues: [{ name: "out", at: "1:3:0" }], exit: "out", tracks: [{ name: "t", clip: "r.wav" }] });

const switchEvent = (rule: Record<string, unknown>) => ({
  format: "myco.audioevent@1",
  bus: "Music",
  parameters: [{ name: "zone", labels: ["A", "B"] }],
  root: {
    type: "musicSwitch", id: "sw", parameter: "zone", children: [seg("A", "a.wav"), seg("B", "b.wav")], library: [riser()],
    transitions: [{ from: "A", to: "B", ...rule }],
  },
});
const clips = { "a.wav": { level: LEVEL.a, seconds: 20 }, "b.wav": { level: LEVEL.b, seconds: 20 }, "r.wav": { level: LEVEL.r, seconds: 1.5 } };

/** A plays; after `waitFrames` the change to B is asked. A's start frame and the handle. */
async function asked(r: MusicLoopback, path: string, waitFrames: number, param: [string, string] = ["zone", "B"]) {
  const h = r.play(path);
  await r.stepUntil(() => r.player()?.run?.state === "playing");
  const start = r.frameOfTime(r.player()!.run!.startAt);
  await r.stepToFrame(start + waitFrames);
  h.setParameter(param[0], param[1]);
  await r.stepUntil(() => !!r.player()?.transition);
  return { start, h, t: r.player()!.transition! };
}

describe("R3b bridges on the core (ADR 0166 §10 R3b)", () => {
  it("A → bridge → B: a sample-exact cut on A's bar, the bridge alone, a linear crossfade into B on its exit cue", async (ctx) => {
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const r = await musicLoopback({
      clips,
      events: { "sw.audioevent.json": switchEvent({ exit: "bar", fadeOut: { beats: 0 }, fadeIn: { beats: 0 }, bridge: { segment: "R", fadeOut: { seconds, curve: "linear" }, fadeIn: { seconds, curve: "linear" } } }) },
    });
    if (!r) return ctx.skip();
    const { start, t } = await asked(r, "sw.audioevent.json", BAR + 5000);
    expect(t.bridge).not.toBeNull();
    const t1 = r.frameOfTime(t.bridge!.point);
    expect((t1 - start) % BAR).toBe(0);
    await r.stepUntil(() => t.incoming !== null && t.state !== "pending");
    const t2 = r.frameOfTime(t.incoming!.point);
    expect(t2 - t1).toBe(RATE); // the bridge's exit cue, one second in
    await r.stepToFrame(t2 + n + 20_000);
    expect(t.state).toBe("done");
    expect(r.player()!.run!.node.id).toBe("B");

    const a = r.out[start]!, rr = r.out[t1]!, b = r.out[t2 + n + 100]!;
    expect(a).toBeCloseTo(LEVEL.a, 3);
    expect(rr).toBeCloseTo(LEVEL.r, 3);
    expect(b).toBeCloseTo(LEVEL.b, 3);
    // Seam 1, a cut: A alone through frame(T1) - 1, the bridge alone from frame(T1) to frame(T2) - 1.
    expect(r.maxError(start, t1, a)).toBe(0);
    expect(r.maxError(t1, t2, rr)).toBe(0);
    // Seam 2, a linear crossfade from frame(T2): r (1 - u) + b u, u = (j + 1) / n; then B alone.
    const ref = (i: number): number => {
      const u = Math.min(1, Math.max(0, (i - t2 + 1) / n));
      return rr * (1 - u) + b * u;
    };
    const err = r.maxError(t2, t2 + n + 2000, ref);
    console.info(`R3b bridge crossfade seam: max error ${err.toExponential(2)}`);
    expect(err).toBeLessThanOrEqual(2e-5);
    expect(r.maxError(t2 + n + 1, t2 + n + 20_000, b)).toBe(0);
    expect(r.late().groupsLate).toBe(0);
    r.dispose();
  });

  it("pool full keeps A: B refused at the bridge's cancel point drops the change, A plays on untouched", async (ctx) => {
    const r = await musicLoopback({
      clips,
      events: { "sw.audioevent.json": switchEvent({ exit: "bar", fadeOut: { beats: 1 }, fadeIn: { beats: 1 }, bridge: { segment: "R" } }) },
    });
    if (!r) return ctx.skip();
    const warn = vi.mocked(console.warn);
    // The core's admission refuses B's group (the pool is full of other rings); the bridge, decoded, is admitted.
    const music = (r.backend as unknown as { music: { admitGroup(req: { members: { play: { path: string } }[] }): unknown } }).music;
    const admit = music.admitGroup.bind(music);
    music.admitGroup = (req) => (req.members.some((m) => m.play.path === "b.wav") ? { ok: false, reason: "poolFull", permanent: false } : admit(req));
    const { start, t } = await asked(r, "sw.audioevent.json", BAR + 5000);
    const t1 = r.frameOfTime(t.bridge!.point);
    await r.stepToFrame(t1 + BAR);
    expect(t.state).toBe("cancelled");
    expect(t.cause).toBe("poolFull");
    expect(r.player()!.transition).toBeNull();
    expect(r.player()!.run!.node.id).toBe("A");
    expect(r.player()!.state).toBe("playing");
    const a = r.out[start]!;
    expect(r.maxError(start, t1 + BAR, a)).toBe(0); // no fade, no bridge, no gap
    expect(warn.mock.calls.some((c) => String(c[0]).includes("pool full"))).toBe(true);
    r.dispose();
  });
});

describe("R3b natural advances on the core", () => {
  it("a playlist's natural advance applies the rule's fade-in at the exit cue (the outgoing's end rings out, unfaded)", async (ctx) => {
    const seconds = 0.05;
    const n = Math.round(seconds * RATE);
    const r = await musicLoopback({
      clips: { "a.wav": { level: LEVEL.a, seconds: 2 }, "b.wav": { level: LEVEL.b, seconds: 2 } },
      events: {
        "p.audioevent.json": {
          format: "myco.audioevent@1", bus: "Music",
          root: { type: "playlist", id: "p", mode: "sequence", children: [seg("A", "a.wav"), seg("B", "b.wav")], transitions: [{ from: "A", to: "B", fadeIn: { seconds, curve: "linear" } }] },
        },
      },
    });
    if (!r) return ctx.skip();
    r.play("p.audioevent.json");
    await r.stepUntil(() => r.player()?.run?.state === "playing");
    const start = r.frameOfTime(r.player()!.run!.startAt);
    const seam = start + BAR; // A's exit cue: its end, 2 s
    await r.stepToFrame(seam + n + 20_000);
    expect(r.player()!.run!.node.id).toBe("B");
    const a = r.out[start]!, b = r.out[seam + n + 100]!;
    expect(r.maxError(start, seam, a)).toBe(0);
    const err = r.maxError(seam, seam + n + 2000, (i) => b * Math.min(1, (i - seam + 1) / n));
    console.info(`R3b natural fade-in seam: max error ${err.toExponential(2)}`);
    expect(err).toBeLessThanOrEqual(2e-5);
    r.dispose();
  });
});

describe("the sound-lab sample's calm → combat bridge (SM2)", () => {
  it("calm crossfades into the riser on the bar (the rule's 1-beat equal power), and combat lands at full level on the riser's end", async (ctx) => {
    const path = "audio/music/music-world.audioevent.json";
    const event = JSON.parse(readFileSync(new URL("../../../../../samples/sound-lab/audio/music/music-world.audioevent.json", import.meta.url), "utf8")) as {
      parameters: { name: string; default: string }[];
      root: { default: string; transitions: { from: string; to: string; bridge?: unknown }[] };
    };
    const rule = event.root.transitions.find((x) => x.from === "calm" && x.to === "combat")!;
    expect(rule.bridge).toEqual({ segment: "riser", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } });
    // Start in calm (the sample starts in explore); the rule itself is the shipped one.
    event.root.default = "calm";
    event.parameters[0]!.default = "calm";
    const level = (v: number, seconds = 8) => ({ level: v, seconds });
    const r = await musicLoopback({
      clips: {
        "audio/music/calm-pad.wav": level(0.1), "audio/music/calm-bells.wav": level(0.05),
        "audio/music/combat-drums.wav": level(0.2), "audio/music/combat-bass.wav": level(0.1),
        "audio/music/explore-pad.wav": level(0.01), "audio/music/explore-arp.wav": level(0.01),
        "audio/music/bridge-riser.wav": level(0.15, 2), "audio/music/stinger-hit.wav": level(0.3, 0.5),
      },
      events: { [path]: event },
    });
    if (!r) return ctx.skip();
    const { start, t } = await asked(r, path, BAR + 5000, ["State", "combat"]);
    expect(t.match.ruleKey).toBe("calm>combat");
    const t1 = r.frameOfTime(t.bridge!.point);
    expect((t1 - start) % BAR).toBe(0);
    await r.stepUntil(() => t.incoming !== null && t.state !== "pending");
    const t2 = r.frameOfTime(t.incoming!.point);
    expect(t2 - t1).toBe(BAR); // the riser is one bar; its exit cue is its end
    await r.stepToFrame(t2 + 20_000);
    expect(t.state).toBe("done");
    expect(r.player()!.run!.node.id).toBe("combat");
    const calm = r.out[start]!, rise = r.out[t2 - 1]!, combat = r.out[t2]!;
    // Calm alone to the bar, the crossfade over one beat from frame(T1), the riser alone after it.
    expect(r.maxError(start, t1, calm)).toBe(0);
    expect(r.out[t1 + 1]).not.toBe(calm);
    expect(r.maxError(t1 + RATE / 2 + 1, t2, rise)).toBe(0);
    // Combat at full level from frame(T2), on one sample: the bridge leg's fades are 0 beats.
    expect(combat).not.toBe(rise);
    expect(r.maxError(t2, t2 + 20_000, combat)).toBe(0);
    expect(r.late().groupsLate).toBe(0);
    r.dispose();
  });
});
