// ADR 0372 (T72): musical timing in a headless Engine with the audio plugin active, through the public API (`myco`'s
// `Animator`, `Audio.play`'s `AudioPlaylistHandle`). The audio side is the plugin's fake backend (`playlists/testKit.ts`):
// its heard clock moves only when the test sets it, so the music is a sequence at a known tempo (120 bpm in 4/4: a beat
// every 0.5 s, a bar every 2 s) and the boundaries are exact. The clip is a 2 s rigless clip with one `hit` marker at
// 0.5 s, made in memory. Time comes from `engine.step(dt)` and the fake clock only. A released play's start shift is
// read from `state()`: `normalizedTime * duration - time * speed` is the clip seconds it started in (f32-free host
// arithmetic, compared at 1e-9).
import { describe, expect, it, vi } from "vitest";
import { Animator, Audio, GameObject, type AnimationPlayResult, type AudioPlaylistHandle } from "../../../../myco";
import { ByteWriter, encodeStringTable, writeContainer } from "../../../../engine/animation/binaryWriter";
import { applyTestPlugins } from "../../../testPlugins";
import { eventKit, pla } from "../../../audio/runtime/playlists/testKit";

const kit = eventKit();
const fake = kit.fake;

const DURATION = 2;
const HIT = 0.5;
const CLIP = "anim/dance.anim";
/** Exact host arithmetic on the clocks (no f32 involved). */
const EXACT = 1e-9;

/** A 2 s clip with no tracks but one marker track: a `hit` marker at 0.5 s. */
function hitClip(): Uint8Array {
  const NONE = 0xffffffff;
  const info = new ByteWriter().f32(DURATION).f32(30).u32(61).u32(1).u32(NONE).u32(0).u32(NONE).u32(0).finish();
  const track = new ByteWriter().u8(14).u8(0).u8(0).u8(0).u32(NONE).u32(NONE).u32(NONE).u32(NONE).u32(NONE).u32(0).u32(1).finish();
  const keys = new ByteWriter().f32(HIT).f32(HIT).u32s([2, 0, 0, 0, 0]).u32(0);
  return writeContainer("MYCOANIM", 1, 0, [
    { kind: 1, count: 1, data: encodeStringTable(["Hit"]) },
    { kind: 2, count: 1, data: info },
    { kind: 3, count: 1, data: track },
    { kind: 4, count: 1, data: keys.finish() },
  ]);
}

const CLIP_URL = `data:application/octet-stream;base64,${Buffer.from(hitClip()).toString("base64")}`;

/** 16 s of music at 120 bpm in 4/4, with an Exit marker at 3 s. */
const MUSIC = pla("sequence", [], {
  sequence: {
    length: 16,
    tempo: { bpm: 120, meter: "4/4" },
    markers: [{ id: "x", name: "Out", at: 3, type: "exit" }],
    tracks: [{ id: "t", kind: "audio", clips: [{ id: "c", sample: "a.wav", at: 0, length: 16, sync: true }] }],
  },
});

const clipPlayer = (id: string) => ({ id, family: "sources", kind: "clipPlayer", params: { clip: `asset:${CLIP}`, loop: "once" } });
/** A graph: a machine (Idle, then Pose on the request "Go" or by travel) under a slot "Dance". */
const GRAPH = {
  format: "myco.animgraph-source@1",
  output: "dance",
  nodes: [
    clipPlayer("idle"),
    clipPlayer("pose"),
    {
      id: "machine",
      family: "logic",
      kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          { name: "Idle", root: "idle", transitions: [{ to: "Pose", if: { request: "Go" }, how: "cut" }] },
          { name: "Pose", root: "pose" },
        ],
      },
    },
    { id: "dance", family: "slots", kind: "slot", inputs: ["machine"], slot: { name: "Dance" } },
  ],
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Sets the heard clock to `t` and steps the Engine one frame of `dt`. */
const frame = (t: number, dt: number) => {
  kit.setTime(t);
  kit.frame(dt);
};

async function boot(): Promise<{ music: AudioPlaylistHandle; anim: Animator; node: GameObject }> {
  await kit.boot({ [CLIP]: CLIP_URL, "s.playlist.json": MUSIC, "dance.animgraph.json": GRAPH });
  fake.durations.set("a.wav", 16);
  const music = Audio.play("s.playlist.json");
  const node = GameObject.create("Dancer");
  const anim = node.addComponent(Animator);
  // Load the clip (and the Animator's core instance) with a plain play, then stop it: no time passes.
  anim.play(CLIP, { loop: false });
  await vi.waitFor(() => {
    kit.frame(0);
    expect(anim.state().name).toBe(CLIP);
  });
  anim.stop();
  kit.frame(0);
  expect(anim.state().name).toBe("");
  return { music, anim, node };
}

/** Clip seconds the showing play started in (see the header). */
const startedIn = (anim: Animator, speed = 1) => anim.state().normalizedTime * DURATION - anim.state().time * speed;

/**
 * Steps the heard clock from `from` by `step` (the Engine by `dt`) until the play shows; returns the heard time of the
 * frame it showed on and of the frame before.
 */
function runUntilShown(anim: Animator, from: number, step: number, dt: number, limit = 400): { shownAt: number; before: number } {
  let before = Number.NaN;
  for (let k = 1; k <= limit; k++) {
    const t = from + k * step;
    frame(t, dt);
    if (anim.state().name === CLIP) return { shownAt: t, before };
    before = t;
  }
  throw new Error("the play never showed");
}

const warnings = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));

describe("Musical timing (T72)", () => {
  it("at: 'bar' starts the play on the frame the heard clock crosses the next bar, that far into the clip", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    expect(music.music!.nextGrid("bar")!.time).toBe(2);
    void anim.play(CLIP, { at: "bar", music, loop: false });
    const { shownAt, before } = runUntilShown(anim, 0.3, 0.07, 0.03);
    expect(before).toBeLessThan(2);
    expect(shownAt).toBeGreaterThanOrEqual(2);
    expect(shownAt - 2).toBeLessThan(0.07); // within one frame
    expect(startedIn(anim)).toBeCloseTo(shownAt - 2, 9);
  });

  it("at: 'beat' starts on the next beat; the late start is scaled by the play's speed", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    void anim.play(CLIP, { at: "beat", music, loop: false, speed: 2 });
    const { shownAt, before } = runUntilShown(anim, 0.3, 0.03, 0.03);
    expect(before).toBeLessThan(0.5);
    expect(shownAt).toBeGreaterThanOrEqual(0.5);
    expect(Math.abs(startedIn(anim, 2) - 2 * (shownAt - 0.5))).toBeLessThan(EXACT * 10);
  });

  it("crossfade takes `at` too", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    void anim.crossfade(CLIP, 0.2, { at: "bar", music, loop: false });
    const { shownAt, before } = runUntilShown(anim, 0.3, 0.07, 0.03);
    expect(before).toBeLessThan(2);
    expect(shownAt).toBeGreaterThanOrEqual(2);
    expect(startedIn(anim)).toBeCloseTo(shownAt - 2, 9);
  });

  it("at: 'exit' starts once the music reports its Exit marker passing, that far into the clip", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    void anim.play(CLIP, { at: "exit", music, loop: false });
    const { shownAt, before } = runUntilShown(anim, 0.3, 0.07, 0.03);
    expect(before).toBeLessThan(3 + 0.07); // the marker is reported on the first audio frame past it
    expect(shownAt).toBeGreaterThanOrEqual(3);
    expect(shownAt - 3).toBeLessThan(2 * 0.07); // within one frame of that report
    expect(startedIn(anim)).toBeCloseTo(shownAt - 3, 9);
  });

  it("align: 'hit' starts early so the clip's hit marker lands on the bar", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    void anim.play(CLIP, { at: "bar", align: "hit", music, loop: false });
    const { shownAt, before } = runUntilShown(anim, 0.3, 0.07, 0.03);
    // The hit is 0.5 s in: the play starts at 1.5 so the hit is heard at 2.
    expect(before).toBeLessThan(1.5);
    expect(shownAt).toBeGreaterThanOrEqual(1.5);
    const shift = startedIn(anim);
    expect(shift).toBeCloseTo(shownAt - 1.5, 9);
    // Where the hit lands, in heard time: the clip's start plus the hit's distance from it.
    expect(shownAt - shift + HIT).toBeCloseTo(2, 9);
  });

  it("align: 'hit' waits for the next bar when this one is too close for the hit to land on it", async () => {
    const { music, anim } = await boot();
    frame(1.7, 0.03);
    void anim.play(CLIP, { at: "bar", align: "hit", music, loop: false });
    const { shownAt, before } = runUntilShown(anim, 1.7, 0.07, 0.03);
    expect(before).toBeLessThan(3.5);
    expect(shownAt).toBeGreaterThanOrEqual(3.5); // bar 4 s, less the 0.5 s lead
    expect(shownAt - startedIn(anim) + HIT).toBeCloseTo(4, 9);
  });

  it("align: 'hit' with at: 'exit' starts at the hit's phase: the hit is on the Exit marker", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    void anim.play(CLIP, { at: "exit", align: "hit", music, loop: false });
    const { shownAt } = runUntilShown(anim, 0.3, 0.07, 0.03);
    expect(startedIn(anim)).toBeCloseTo(HIT + (shownAt - 3), 9);
  });

  it("resolves the held play's promise once, from the play it becomes", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    const results: AnimationPlayResult[] = [];
    const p = anim.play(CLIP, { at: "bar", music, loop: false });
    void p.then((r) => results.push(r));
    expect(anim.onFinished).toBe(p);
    runUntilShown(anim, 0.3, 0.07, 0.03);
    await Promise.resolve();
    expect(results).toEqual([]);
    for (let k = 1; k <= 80; k++) frame(2.1 + k * 0.03, 0.03); // past the clip's 2 s
    await vi.waitFor(() => expect(results).toEqual([{ reason: "finished" }]));
    frame(5, 0.03);
    await Promise.resolve();
    expect(results).toHaveLength(1);
  });

  it("ends a held play `stopped` when its Animator goes away before the boundary", async () => {
    const { music, anim, node } = await boot();
    frame(0.3, 0.03);
    const results: AnimationPlayResult[] = [];
    void anim.play(CLIP, { at: "bar", music, loop: false }).then((r) => results.push(r));
    frame(0.4, 0.03);
    GameObject.destroy(node);
    frame(0.5, 0.03);
    frame(0.55, 0.03);
    await vi.waitFor(() => expect(results).toEqual([{ reason: "stopped" }]));
    for (let k = 1; k <= 60; k++) frame(0.5 + k * 0.07, 0.03);
    await Promise.resolve();
    expect(results).toHaveLength(1);
  });

  it("plays at once, with one warning, when the music stops while the play waits", async () => {
    const { music, anim } = await boot();
    frame(0.3, 0.03);
    void anim.play(CLIP, { at: "bar", music, loop: false });
    frame(0.4, 0.03);
    expect(anim.state().name).toBe("");
    music.stop(0);
    frame(0.45, 0.03);
    expect(anim.state().name).toBe(CLIP);
    expect(startedIn(anim)).toBeCloseTo(0, 9);
    expect(warnings().filter((w) => w.includes("the music stopped"))).toHaveLength(1);
  });

  it("plays at once, with one warning, without `music`", async () => {
    const { anim } = await boot();
    frame(0.3, 0.03);
    void anim.play(CLIP, { at: "bar", loop: false });
    frame(0.33, 0.03);
    expect(anim.state().name).toBe(CLIP);
    expect(warnings().filter((w) => w.includes("`at` needs `music`"))).toHaveLength(1);
  });

  describe("on a graph Animator", () => {
    async function graphAnimator(): Promise<Animator> {
      const anim = GameObject.create("Graphed").addComponent(Animator, { graph: "dance.animgraph.json" });
      await vi.waitFor(() => {
        kit.frame(0);
        expect(anim.state("Base").name).toBe("Idle");
      });
      return anim;
    }

    it("travel with at: 'bar' leaves on the bar, and its promise resolves then", async () => {
      const { music } = await boot();
      const anim = await graphAnimator();
      frame(0.3, 0.03);
      const results: string[] = [];
      void anim.travel("Pose", { at: "bar", music }).then((r) => results.push(r.reason));
      let t = 0.3;
      while (t < 1.95) frame((t += 0.07), 0.03);
      await Promise.resolve();
      expect(anim.state("Base").name).toBe("Idle");
      expect(results).toEqual([]);
      frame(2.01, 0.03);
      frame(2.04, 0.03);
      expect(anim.state("Base").name).toBe("Pose");
      await vi.waitFor(() => expect(results).toEqual(["arrived"]));
    });

    it("request with at: 'beat' is sent on the beat", async () => {
      const { music } = await boot();
      const anim = await graphAnimator();
      frame(0.3, 0.03);
      anim.request("Go", { at: "beat", music });
      frame(0.45, 0.03);
      frame(0.48, 0.03);
      expect(anim.state("Base").name).toBe("Idle");
      frame(0.51, 0.03);
      frame(0.54, 0.03);
      expect(anim.state("Base").name).toBe("Pose");
    });

    it("a slot play with at: 'bar' and align: 'hit' resolves once, after its hit landed on the bar", async () => {
      const { music } = await boot();
      const anim = await graphAnimator();
      frame(0.3, 0.03);
      const results: AnimationPlayResult[] = [];
      void anim.play(CLIP, { slot: "Dance", at: "bar", align: "hit", music }).then((r) => results.push(r));
      // The 2 s clip is released at 1.5 s heard (frame 18 of 0.07 s) so its hit lands on the 2 s bar, then plays 67
      // frames of 0.03 s: it can't have finished by frame 80, and has by frame 90.
      let doneAt = -1;
      for (let k = 1; k <= 120 && doneAt < 0; k++) {
        frame(0.3 + k * 0.07, 0.03);
        await tick(); // let loads finish between frames
        if (results.length) doneAt = k;
      }
      expect(results).toEqual([{ reason: "finished" }]);
      expect(doneAt).toBeGreaterThan(80);
      expect(doneAt).toBeLessThanOrEqual(90);
    });
  });

  it("plays at once, with one warning, when the audio plugin isn't enabled; the promise still resolves", async () => {
    const { music } = await boot();
    try {
      applyTestPlugins(["myco.audio"]);
      const anim = GameObject.create("Dancer2").addComponent(Animator);
      const results: AnimationPlayResult[] = [];
      void anim.play(CLIP, { at: "bar", music, loop: false }).then((r) => results.push(r));
      void anim.play(CLIP, { at: "beat", music, loop: false, normalizedTime: 0.5 }).then((r) => results.push(r));
      await vi.waitFor(() => {
        frame(0.3, 0); // its instance and clip load (no time passes)
        expect(anim.state().name).toBe(CLIP);
      });
      expect(warnings().filter((w) => w.includes("needs the audio plugin"))).toHaveLength(1);
      await vi.waitFor(() => expect(results).toEqual([{ reason: "interrupted" }]));
    } finally {
      applyTestPlugins();
    }
  });
});
