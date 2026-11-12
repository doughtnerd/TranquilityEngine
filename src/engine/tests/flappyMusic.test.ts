// ADR 0166 task L2: the Flappy sample's town music in play. The music prefab autoloads and plays the whole time (the start
// screen, a run, game over, the next run); M shows and hides the readout of `Audio.debug().music` (the phone prime lead,
// listening-pass item P1); and game over dips the Music bus, which comes back when the next run starts.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, SceneManager, Text } from "../../myco";
import { readProject } from "../../server/project";
import { Audio } from "../../plugins/audio/runtime";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { makeFakeBackend } from "../../plugins/audio/runtime/testing";
import { events } from "../../plugins/audio/runtime/events/eventRuntime";
import { _resetMusicPlayers } from "../../plugins/audio/runtime/music/musicSystem";
import "../../editor/sampleTypes";
import { BirdEvents } from "../../../samples/flappy/scripts/data";
import { GameManager } from "../../../samples/flappy/scripts/behaviors/GameManager";

const SAMPLE = fileURLToPath(new URL("../../../samples/flappy/", import.meta.url));
const fake = makeFakeBackend();
let engine: Engine | null = null;
const RENDER = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;
const clock = fake as unknown as { time: number; rafTime: number };

const advance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    clock.time += 1 / 60;
    engine!.step(1 / 60);
  }
};
function press(key: string): void {
  Input.simulate("down", key);
  advance(1 / 30);
  Input.simulate("up", key);
  advance(1 / 30);
}

async function boot(): Promise<void> {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load("scenes/main.scene.json");
  advance(0.2);
}

const manager = () => engine!.world._componentsOfType(GameManager)[0] as GameManager;
const readout = () => manager().musicLabel!.getBehavior(Text)!.text;

beforeEach(() => {
  fake.clear();
  fake.durations.set("music/town.mp3", 40);
  clock.time = 0;
  clock.rafTime = 0;
  fake.ready = true;
  setAudioBackend(fake);
  events().now = () => clock.time;
  events()._reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  vi.restoreAllMocks();
  _resetMusicPlayers();
  events()._reset();
  setAudioBackend(null);
});

describe("Flappy's town music in play", () => {
  it("M shows the readout in the corner label and hides it again", async () => {
    await boot();
    expect(readout()).toBe("");
    press("m");
    advance(0.5);
    expect(readout()).toMatch(/^music[: ]/); // a row ("music town, lead ...", a fake backend has none) or "music: none playing"
    press("m");
    advance(0.5);
    expect(readout()).toBe("");
    expect(Audio.debug()).toBeTruthy();
  });

  it("game over dips the Music bus and the next run's start brings it back", async () => {
    await boot();
    const before = Audio.bus("Music").volume;
    press("space"); // the first flap starts the run
    expect(manager().state).toBe("playing");
    BirdEvents.push({ kind: "died" });
    advance(0.2);
    expect(manager().state).toBe("dead");
    advance(1);
    expect(Audio.bus("Music").volume, "dipped").toBeLessThan(before * 0.5);
    advance(1); // the restart delay (0.6 s) has passed
    await new Promise((r) => setTimeout(r, 20)); // the wait resolves as a promise
    advance(0.1);
    press("space"); // restart: the scene reloads
    await new Promise((r) => setTimeout(r, 50));
    advance(1.5);
    expect(Audio.bus("Music").volume, "back").toBeCloseTo(before, 3);
  });
});
