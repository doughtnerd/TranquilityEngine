// ADR 0171 amended by 0172, task Sa2: the Sound Lab's Mixer page (samples/sound-lab, scenes/mixer.scene.json) loaded headless
// from disk on the fake backend: it opens from the tour with the `-` key, loads without a warning, its beds play on their
// buses, the voice and burst keys start their sounds on Voice and SFX, and the tour script cycles the triggers on the
// game clock (never a wall clock). That each rule ducks is proved on the real core in `golden/audioGoldenM5.test.ts` (DSd).
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, SceneManager } from "../../../../myco";
import { readProject } from "../../../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import.meta.glob("../../../../../samples/sound-lab/scripts/behaviors/*.ts", { eager: true });
import { setAudioBackend } from "../backend";
import { _resetHandleWarningsForTests } from "../core/handle";
import { makeFakeBackend } from "../testing";
import { events } from "../events/eventRuntime";

const SAMPLE = fileURLToPath(new URL("../../../../../samples/sound-lab", import.meta.url));
const fake = makeFakeBackend();
const warnings: string[] = [];
const errors: string[] = [];
let engine: Engine | null = null;

const RENDER = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;

async function boot(scene: string): Promise<void> {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load(scene);
}

/** Steps the engine for `seconds` of game time, the fake audio clock moving with it. */
const advance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    (fake as { time: number }).time += 1 / 60;
    engine!.step(1 / 60);
  }
};
const press = (key: string) => {
  Input.simulate("down", key);
  advance(1 / 60);
  Input.simulate("up", key);
  advance(1 / 60);
};
const playsOf = (re: RegExp) => fake.plays.filter((p) => re.test(p.path));

beforeEach(() => {
  fake.clear();
  (fake as { time: number }).time = 0;
  fake.ready = true;
  setAudioBackend(fake);
  events().now = () => (fake as { time: number }).time;
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

describe("the Sound Lab's Mixer page (Sa2)", () => {
  it("opens from the tour with the - key and loads without a warning", async () => {
    await boot("scenes/main.scene.json");
    advance(0.1);
    press("-");
    // The load is asynchronous: step frames until the Mixer scene's Ambience bed (the tour has no noise on Ambience at start) plays.
    for (let i = 0; i < 200 && playsOf(/noise-loop/).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
      advance(1 / 60);
    }
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    expect(playsOf(/noise-loop/).some((p) => p.bus === "Ambience")).toBe(true);
  });

  it("the beds play on Music and Ambience; the voice key starts the voice loop on Voice and again stops it", async () => {
    await boot("scenes/mixer.scene.json");
    advance(0.2);
    expect(playsOf(/music-loop/).map((p) => p.bus)).toEqual(["Music"]);
    expect(playsOf(/noise-loop/).map((p) => p.bus)).toEqual(["Ambience"]);
    expect(playsOf(/voice-loop/)).toHaveLength(0);
    press("1");
    expect(playsOf(/voice-loop/).map((p) => [p.bus, p.loop])).toEqual([["Voice", true]]);
    const voice = fake.voices.find((v) => /voice-loop/.test(v.request.path))!;
    expect(voice.playing ?? true).toBe(true);
    press("1");
    expect(fake.voices.filter((v) => /voice-loop/.test(v.request.path) && !v.stopped)).toHaveLength(0);
    expect(warnings).toEqual([]);
  });

  it("the burst key plays a burst on SFX", async () => {
    await boot("scenes/mixer.scene.json");
    advance(0.2);
    press("2");
    expect(playsOf(/burst/).map((p) => p.bus)).toEqual(["SFX"]);
  });

  it("the tour cycles the triggers on the game clock: the voice, quiet, a burst, the voice and a burst, quiet, again", async () => {
    await boot("scenes/mixer.scene.json");
    advance(0.2);
    press("3");
    const voices = () => fake.voices.filter((v) => /voice-loop/.test(v.request.path));
    const live = () => voices().filter((v) => !v.stopped).length;
    advance(0.5);
    expect(live(), "step 1 (5 s): the voice alone").toBe(1);
    expect(playsOf(/burst/)).toHaveLength(0);
    advance(5);
    expect(live(), "step 2 (2 s): quiet").toBe(0);
    advance(2);
    expect(playsOf(/burst/), "step 3: a burst alone").toHaveLength(1);
    expect(live()).toBe(0);
    advance(2.5);
    expect(live(), "step 4: the voice and a burst").toBe(1);
    expect(playsOf(/burst/)).toHaveLength(2);
    advance(5);
    expect(live(), "step 5: quiet").toBe(0);
    advance(2);
    expect(live(), "the tour comes round to the voice again").toBe(1);
    press("3");
    expect(live(), "the key ends the tour and stops the voice").toBe(0);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });
});
