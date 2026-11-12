// ADR 0158 §8: the Sound Lab sample's events page (samples/sound-lab, E5.1) loaded headless from disk on the fake backend
// (the TypeScript automation evaluator runs): both scenes load, the events play what their files say, a global parameter
// drives node-level automation, and nothing warns.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { readProject } from "../../../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import.meta.glob("../../../../../samples/sound-lab/scripts/behaviors/*.ts", { eager: true });
import { setAudioBackend } from "../backend";
import { _resetHandleWarningsForTests } from "../core/handle";
import { makeFakeBackend } from "../testing";
import { Audio } from "../index";
import { musicPlayers } from "../music/musicSystem";
import { events } from "./eventRuntime";

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
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load(scene);
}

/** Steps the engine for `seconds` of game time with the fake audio clock moving along (the audio system runs `events().update`). */
const advance = (seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    (fake as { time: number }).time += 1 / 60;
    engine!.step(1 / 60);
  }
};
/** `fake.clear()` also forgets the clip lengths the engine start needs. */
const clearPlays = () => {
  fake.clear();
  fake.durations.set("audio/events/engine-start.wav", 0.9);
};
const playsOf = (re: RegExp) => fake.plays.filter((p) => re.test(p.path));
const voiceOf = (re: RegExp) => fake.voices.find((v) => re.test(v.request.path))!;

beforeEach(() => {
  clearPlays();
  (fake as { time: number }).time = 0;
  fake.ready = true;
  setAudioBackend(fake);
  events().now = () => (fake as { time: number }).time; // cooldowns follow the fake clock, not wall time
  events()._reset();
  _resetHandleWarningsForTests();
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
  events()._reset();
  setAudioBackend(null);
});

describe("the Sound Lab events page (ADR 0158)", () => {
  it("loads the tour scene and the events scene without a warning", async () => {
    await boot("scenes/main.scene.json");
    await SceneManager.load("scenes/events.scene.json");
    advance(0.1);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("starts the music event as a segment with stems on the Music bus; Intensity is a global parameter", async () => {
    await boot("scenes/events.scene.json");
    advance(2.5); // the page sets Intensity to 0 and its music starts once the 2 s glide from the default 1 is over
    expect(Audio.getParameter("Intensity")).toBe(0);
    // A segment plays through the music player, not through per-clip plays: the stems are the members of one group.
    expect(playsOf(/music-/)).toHaveLength(0);
    const players = musicPlayers();
    expect(players).toHaveLength(1);
    expect(players[0].root.type).toBe("segment");
    expect(players[0].root.id).toBe("intensity");
    const group = fake.music!.admitted[0];
    expect(group.members.map((m) => m.stem)).toEqual(["pad", "pulse", "lead"]);
    expect(group.members.map((m) => m.play.path)).toEqual(["audio/events/music-pad.wav", "audio/events/music-pulse.wav", "audio/events/music-lead.wav"]);
    for (const m of group.members) expect(m.play.bus).toBe("Music");
    expect(group.members[0].play.volume).toBeCloseTo(0.8, 2);
    expect(warnings).toEqual([]);
  });

  it("plays footsteps from the clips of the current Surface", async () => {
    await boot("scenes/events.scene.json");
    clearPlays();
    for (const surface of ["Grass", "Gravel", "Wood", "Metal"]) {
      Audio.setParameter("Surface", surface);
      Audio.play("audio/events/footstep.audioevent.json");
      const last = fake.plays[fake.plays.length - 1];
      expect(last.path).toMatch(new RegExp(`step-${surface.toLowerCase()}-[123]\\.wav$`));
      expect(last.bus).toBe("Foley");
      advance(0.1); // past the event's cooldown
    }
    expect(warnings).toEqual([]);
  });

  it("plays the blended engine: start, then the RPM blend of three looped clips, then the end clip on release", async () => {
    await boot("scenes/events.scene.json");
    clearPlays();
    const h = Audio.play("audio/events/engine.audioevent.json", { bus: "Engine", parameters: { RPM: 0 } });
    expect(h.playing).toBe(true);
    expect(fake.plays.map((p) => p.path)).toEqual(["audio/events/engine-start.wav"]);
    fake.voices[0].end();
    advance(0.5);
    for (const n of ["idle", "mid", "high"]) {
      const plays = playsOf(new RegExp(`engine-${n}\\.wav`));
      expect(plays).toHaveLength(1);
      expect(plays[0].loop).toBe(true);
    }
    const idle = voiceOf(/engine-idle/);
    const high = voiceOf(/engine-high/);
    expect(idle.volume).toBeGreaterThan(0.3);
    expect(high.volume).toBeCloseTo(0, 2);
    h.setParameter("RPM", 1);
    advance(1.5);
    expect(h.getParameter("RPM")).toBe(1);
    expect(high.volume).toBeGreaterThan(0.3);
    expect(idle.volume).toBeCloseTo(0, 2);
    h.release();
    expect(playsOf(/engine-off\.wav/)).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("plays the single-clip engine: a sustained loop region, released into its tail", async () => {
    await boot("scenes/events.scene.json");
    clearPlays();
    const h = Audio.play("audio/events/engine-single.audioevent.json", { bus: "Engine", parameters: { RPM: 0.5 } });
    expect(fake.plays).toHaveLength(1);
    expect(fake.plays[0].path).toBe("audio/events/engine-single.wav");
    expect(fake.plays[0].loop).toBe(true);
    h.release();
    const loops = fake.voices[0].events.filter((e) => e.kind === "loop");
    expect(loops).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: true }, { kind: "loop", start: 0.5, end: 1.5, looping: false }]);
    expect(warnings).toEqual([]);
  });
});
