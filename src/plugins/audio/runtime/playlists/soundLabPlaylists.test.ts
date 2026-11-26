// ADR 0158 §8, migrated to playlists (ADR 0343): the Sound Lab sample's events and music pages (samples/sound-lab) loaded
// headless from disk on the fake backend (the TypeScript automation evaluator runs): the scenes load, the playlists the
// migration wrote play what the old events played, a global parameter drives track automation, and nothing warns.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { readProject } from "../../../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import.meta.glob("../../../../../samples/sound-lab/scripts/behaviors/*.ts", { eager: true });
import { setAudioBackend } from "../backend";
import { makeFakeBackend, endAudioSession } from "../testing";
import { Audio } from "../index";
import { playlistHost } from "../playlists/host";
import { serveSampleUI } from "../../../../engine/tests/sampleUI";

const SAMPLE = fileURLToPath(new URL("../../../../../samples/sound-lab", import.meta.url));
const fake = makeFakeBackend();
const warnings: string[] = [];
const errors: string[] = [];
let engine: Engine | null = null;

/** The world plays audio only with a render host; this stub is enough for scene loads and the Camera's detach. */
const RENDER = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;

async function boot(scene: string): Promise<void> {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  serveSampleUI(import.meta.glob("../../../../../samples/sound-lab/ui/*.svelte", { eager: true }));
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load(scene);
}

/** Steps the engine for `seconds` of game time with the fake audio clock moving along. */
const advance = (seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    fake.advance(1 / 60);
    engine!.step(1 / 60);
  }
};
/** The clip lengths the playlists' timing needs (`fake.clear()` forgets them). */
const LENGTHS: Record<string, number> = {
  "audio/events/engine-start.wav": 0.9, "audio/events/engine-idle.wav": 1.3, "audio/events/engine-mid.wav": 1.3, "audio/events/engine-high.wav": 1.3,
  "audio/events/engine-off.wav": 1.2, "audio/events/engine-single.wav": 2.5,
  "audio/events/music-pad.wav": 4, "audio/events/music-pulse.wav": 4, "audio/events/music-lead.wav": 4,
  "audio/music/explore-pad.wav": 4, "audio/music/explore-arp.wav": 4,
};
const clearPlays = () => {
  fake.clear();
  for (const [p, s] of Object.entries(LENGTHS)) fake.durations.set(p, s);
};
const playsOf = (re: RegExp) => fake.plays.filter((p) => re.test(p.path));
const voicesOf = (re: RegExp) => fake.voices.filter((v) => re.test(v.request.path));

beforeEach(() => {
  clearPlays();
  fake.advanceTo(0);
  fake.ready = true;
  setAudioBackend(fake);
  playlistHost().now = () => fake.time; // cooldowns follow the fake clock, not wall time
  endAudioSession();
  warnings.length = 0;
  errors.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});

afterEach(() => {
  if (engine) engine.world.render = undefined as never;
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  vi.restoreAllMocks();
  endAudioSession();
  setAudioBackend(null);
});

describe("the Sound Lab's events page on playlists (ADR 0343)", () => {
  it("loads the tour scene and the events scene without a warning", async () => {
    await boot("scenes/main.scene.json");
    await SceneManager.load("scenes/events.scene.json");
    advance(0.1);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("starts the music playlist's three stems together on the Music bus; Intensity is a global parameter that fades the upper stems", async () => {
    await boot("scenes/events.scene.json");
    advance(2.5); // the page sets Intensity to 0 and its music starts once the 2 s glide from the default 1 is over
    expect(Audio.getParameter("Intensity")).toBe(0);
    const stems = playsOf(/audio\/events\/music-/);
    expect(stems.map((p) => p.path)).toEqual(["audio/events/music-pad.wav", "audio/events/music-pulse.wav", "audio/events/music-lead.wav"]);
    // One sequence: every stem starts stamped at the same heard time, on the Music bus.
    expect(new Set(stems.map((p) => p.at)).size).toBe(1);
    for (const p of stems) expect(p.bus).toBe("Music");
    expect(stems[0]!.volume).toBeCloseTo(0.8, 2); // the pad's -1.94 dB
    const rows = Audio.debug().events.filter((r) => r.asset.endsWith("music-intensity.playlist.json"));
    expect(rows).toHaveLength(1);
    // At Intensity 0 the pulse and the lead are silent (their tracks' automation), the pad is not.
    advance(0.5);
    // ADR 0350: the upper stems' lanes are beat-quantised: their level is the voice's stamped gain ramp (its last one).
    const ramps = (v: (typeof fake.voices)[number]) => v.events.filter((e): e is Extract<typeof e, { kind: "paramsShaped" }> => e.kind === "paramsShaped");
    const level = (re: RegExp) => { const v = voicesOf(re).at(-1)!; return v.volume * (ramps(v).at(-1)?.gain ?? 1); };
    expect(level(/music-pad/)).toBeGreaterThan(0.5);
    expect(level(/music-pulse/)).toBeCloseTo(0, 2);
    expect(level(/music-lead/)).toBeCloseTo(0, 2);
    Audio.setParameter("Intensity", 1);
    advance(2.5);
    expect(level(/music-pulse/)).toBeGreaterThan(0.5);
    expect(level(/music-lead/)).toBeGreaterThan(0.5);
    // Each moved on a beat of the 120 bpm sequence (a multiple of 0.5 s after the stems' start).
    const t0 = stems[0]!.at!;
    for (const re of [/music-pulse/, /music-lead/]) {
      const at = ramps(voicesOf(re).at(-1)!).at(-1)!.at!;
      expect(((at - t0) / 0.5) % 1).toBeCloseTo(0, 6);
    }
    expect(warnings).toEqual([]);
  });

  it("plays footsteps from the clips of the current Surface", async () => {
    await boot("scenes/events.scene.json");
    clearPlays();
    for (const surface of ["Grass", "Gravel", "Wood", "Metal"]) {
      Audio.setParameter("Surface", surface);
      Audio.play("audio/events/footstep.playlist.json");
      const last = fake.plays[fake.plays.length - 1]!;
      expect(last.path).toMatch(new RegExp(`step-${surface.toLowerCase()}-[123]\\.wav$`));
      expect(last.bus).toBe("Foley");
      advance(0.1); // past the playlist's cooldown
    }
    expect(warnings).toEqual([]);
  });

  it("plays the blended engine: start, then the RPM blend of three looped clips, then the end clip on release", async () => {
    await boot("scenes/events.scene.json");
    clearPlays();
    const h = Audio.play("audio/events/engine.playlist.json", { bus: "Engine", parameters: { RPM: 0 } });
    expect(h.playing).toBe(true);
    expect(fake.plays.map((p) => p.path)).toEqual(["audio/events/engine-start.wav"]);
    advance(1.2);
    for (const n of ["idle", "mid", "high"]) {
      const plays = playsOf(new RegExp(`engine-${n}\\.wav`));
      expect(plays).toHaveLength(1);
      expect(plays[0]!.loop).toBe(true); // its sidecar's held loop (0.15..1.15 s, the old event's loop region)
    }
    const idle = () => voicesOf(/engine-idle/).at(-1)!;
    const high = () => voicesOf(/engine-high/).at(-1)!;
    expect(idle().volume).toBeGreaterThan(0.3);
    expect(high().volume).toBeCloseTo(0, 2);
    h.setParameter("RPM", 1);
    advance(1.5);
    expect(h.getParameter("RPM")).toBe(1);
    expect(high().volume).toBeGreaterThan(0.3);
    expect(idle().volume).toBeCloseTo(0, 2);
    // Past the held loop's wrap: the blend still playing isn't started again (its clip keeps sounding across the wrap).
    for (const n of ["idle", "mid", "high"]) expect(playsOf(new RegExp(`engine-${n}\\.wav`))).toHaveLength(1);
    // The held loop keeps the blend going until release, then the sequence goes on to its end clip.
    expect(playsOf(/engine-off\.wav/)).toHaveLength(0);
    h.release();
    advance(0.5);
    expect(playsOf(/engine-off\.wav/)).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("plays the single-clip engine: a held loop region, released into its tail", async () => {
    await boot("scenes/events.scene.json");
    clearPlays();
    const h = Audio.play("audio/events/engine-single.playlist.json", { bus: "Engine", parameters: { RPM: 0.5 } });
    expect(fake.plays.map((p) => p.path)).toEqual(["audio/events/engine-single.wav"]);
    advance(3);
    expect(fake.plays[0]!.loop).toBe(true);
    expect(h.playing).toBe(true); // still held
    h.release();
    // The sample's held loop (its sidecar, the old event's loop region): it loops 0.5..1.5 s until release, then the tail.
    const loops = fake.voices[0]!.events.filter((e) => e.kind === "loop");
    expect(loops).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: true }, { kind: "loop", start: 0.5, end: 1.5, looping: false }]);
    expect(warnings).toEqual([]);
  });
});

describe("the Sound Lab's music page on playlists (ADR 0343)", () => {
  it("loads without a warning and starts the world Switch on its explore entry", async () => {
    await boot("scenes/music.scene.json");
    advance(0.5);
    const stems = playsOf(/audio\/music\//);
    expect(stems.map((p) => p.path)).toEqual(["audio/music/explore-pad.wav", "audio/music/explore-arp.wav"]);
    for (const p of stems) expect(p.bus).toBe("Music");
    expect(Audio.debug().events.map((r) => r.asset)).toContain("audio/music/music-world.playlist.json");
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  /** Plays of `re` since `from` (index into `fake.plays`), as [path, heard start rounded to 1 ms]. */
  const playsSince = (from: number, re: RegExp) => fake.plays.slice(from).filter((p) => re.test(p.path)).map((p) => [p.path.replace(/.*\//, ""), Math.round((p.at ?? Number.NaN) * 1000) / 1000]);

  it("the world Switch: calm to combat waits for the bar, plays the riser, and combat enters at the riser's end", async () => {
    await boot("scenes/main.scene.json"); // a page without its own music
    for (const p of ["calm-pad", "calm-bells", "combat-drums", "combat-bass"]) fake.durations.set(`audio/music/${p}.wav`, 4);
    fake.durations.set("audio/music/bridge-riser.wav", 2);
    const h = Audio.play("audio/music/music-world.playlist.json", { parameters: { State: "calm" } });
    const start = playsOf(/calm-pad/)[0]!.at!;
    expect(playsSince(0, /audio\/music\//)).toEqual([["calm-pad.wav", start], ["calm-bells.wav", start]]);
    advance(0.6); // into the first bar (a bar is 2 s at 120 bpm)
    const mark = fake.plays.length;
    h.setParameter("State", "combat");
    advance(5);
    const bar = start + 2;
    expect(playsSince(mark, /riser|combat/)).toEqual([["bridge-riser.wav", bar], ["combat-drums.wav", bar + 2], ["combat-bass.wav", bar + 2]]);
    expect(warnings).toEqual([]);
  });

  it("the loop playlist: the 2-bar loop wraps while Loop is hold; released, it plays its last bar and ends", async () => {
    await boot("scenes/main.scene.json");
    fake.durations.set("audio/music/loop-body.wav", 6);
    const h = Audio.play("audio/music/music-loop.playlist.json", { parameters: { Loop: "hold" } });
    const start = playsOf(/loop-body/)[0]!.at!;
    advance(9); // two wraps at 4 s and 8 s: the sync clip starts again from its start each time
    expect(playsSince(0, /loop-body/)).toEqual([["loop-body.wav", start], ["loop-body.wav", start + 4], ["loop-body.wav", start + 8]]);
    h.setParameter("Loop", "release");
    advance(5); // the pass in play finishes at 12 s, then the last bar plays on to 14 s
    expect(playsSince(0, /loop-body/)).toHaveLength(3);
    expect(h.music?.bar ?? 4).toBeGreaterThanOrEqual(3);
    advance(1);
    for (const v of fake.voices) v.end();
    advance(0.2);
    expect(h.playing).toBe(false);
    expect(warnings).toEqual([]);
  });
});
