// ADR 0166 task L2: the Sound Lab's last polish, run headless on the fake backend. (1) A page that claims the keyboard
// (`globalThis.__soundLabKeys.claim()`) keeps the main page's own handlers (1 a click and a beep, 5 a burst) from firing
// on the same keys; releasing gives them back. (2) The music page starts the lab's eight-stem and A, B, C events itself
// (keys 4 and 5), and D shows the music readout. (3) The touch forms: the music page's on-screen buttons go through the keys'
// code, and on the rhythm page a pointer press on the game canvas is a tap timed from the event's own time stamp while a press
// on a button is not. The DOM is a few stubs (the engine tests run in Node). The event files' data is in soundLabMusic.test.ts.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, SceneManager, Text } from "../../myco";
import { readProject } from "../../server/project";
import.meta.glob("../../../samples/sound-lab/scripts/behaviors/*.ts", { eager: true });
import { MusicLab } from "../../../samples/sound-lab/scripts/behaviors/MusicLab";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { makeFakeBackend } from "../../plugins/audio/runtime/testing";
import { Audio } from "../../plugins/audio/runtime";
import { resetCalibrationForTests, setCalibration, calibrationSettled } from "../../plugins/audio/runtime/music/calibration";
import { _resetMusicPlayers } from "../../plugins/audio/runtime/music/musicSystem";
import { events } from "../../plugins/audio/runtime/events/eventRuntime";
import type { RhythmLab, RhythmState } from "../../../samples/sound-lab/scripts/behaviors/RhythmLab";

const SAMPLE = fileURLToPath(new URL("../../../samples/sound-lab/", import.meta.url));
const fake = makeFakeBackend();
let engine: Engine | null = null;
const RENDER = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;
const clock = fake as unknown as { time: number; rafTime: number };

async function boot(scene: string): Promise<void> {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load(scene);
  advance(0.1);
}

const advance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    clock.time += 1 / 60;
    engine!.step(1 / 60);
  }
};

/** A key goes down and the frame that reads it runs. */
function press(key: string): void {
  Input.simulate("down", key);
  advance(1 / 30);
  Input.simulate("up", key);
  advance(1 / 30);
}

const claims = () => (globalThis as unknown as { __soundLabKeys: { claim(): () => void; claims: number } }).__soundLabKeys;
const playedClips = () => fake.plays.map((p) => p.path);

// The fake remembers a group only when it is primed; the lab's clips are decoded (admitted, never primed).
const admit = fake.music!.admitGroup.bind(fake.music);
fake.music!.admitGroup = (req) => {
  fake.music!.primeGroup(req);
  return admit(req);
};

beforeEach(() => {
  fake.clear();
  for (const p of ["events/music-pad", "events/music-pulse", "events/music-lead", "melody-loop"]) fake.durations.set(`audio/${p}.wav`, 4);
  for (const p of ["click-track", "combat-drums", "combat-bass", "explore-pad", "explore-arp"]) fake.durations.set(`audio/music/${p}.wav`, p === "click-track" ? 2 : 4);
  clock.time = 0;
  clock.rafTime = 0;
  fake.ready = true;
  setAudioBackend(fake);
  events().now = () => clock.time;
  events()._reset();
  resetCalibrationForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetMusicPlayers();
  events()._reset();
  setCalibration(0);
  await calibrationSettled();
  setAudioBackend(null);
});

describe("a page that claims the keyboard", () => {
  it("keeps the main page's handlers from firing on its keys, and gives them back on release", async () => {
    await boot("scenes/main.scene.json");
    press("1");
    expect(playedClips().filter((c) => c.endsWith("audio/click.wav") || c.endsWith("audio/beep.wav")).length, "1 is a click and a beep").toBe(2);
    fake.plays.length = 0;

    const release = claims().claim();
    press("1");
    press("5");
    expect(playedClips().filter((c) => /click\.wav|beep\.wav|burst\.wav/.test(c)), "claimed: neither 1 nor 5 reached the main page").toEqual([]);
    expect(claims().claims).toBe(1);

    release();
    release(); // releasing twice is harmless
    expect(claims().claims).toBe(0);
    press("5");
    expect(playedClips().some((c) => c.endsWith("audio/burst.wav")), "released: 5 is the burst again").toBe(true);
  });
});

describe("the music page", () => {
  const music = () => engine!.world._componentsOfType(MusicLab)[0] as MusicLab;
  const label = () => music().node.getBehavior(Text)!;
  const assets = () => events().debugRows(new Map()).map((r) => r.asset);

  it("starts the eight-stem event with 4 and the A, B, C playlist with 5, each stopping the one before", async () => {
    await boot("scenes/music.scene.json");
    expect(assets().some((a) => a.includes("music-world"))).toBe(true);
    press("4");
    expect(assets().filter((a) => a.includes("music-stems8"))).toHaveLength(1);
    expect(label().text).toContain("eight stems");
    press("5");
    expect(label().text).toContain("playlist A, B, C");
    press("o");
    expect(label().text).toContain("Music: off");
  });

  it("D shows the music readout under the label, and D again hides it", async () => {
    await boot("scenes/music.scene.json");
    const shown = /readout: |lead [\d.-]+ ms/;
    expect(label().text).not.toMatch(shown);
    press("d");
    advance(0.5);
    expect(label().text).toMatch(shown);
    press("d");
    advance(0.5);
    expect(label().text).not.toMatch(shown);
    expect(Audio.debug()).toBeTruthy();
  });
});

// --- the touch forms, with a small DOM -----------------------------------------------------------------------------------

type Handler = (e: Record<string, unknown>) => void;
class FakeCanvas {
  tabIndex = 0;
}
class FakeEl {
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  handlers: Record<string, Handler[]> = {};
  children: FakeEl[] = [];
  textContent = "";
  type = "";
  removed = false;
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: Handler) {
    (this.handlers[type] ??= []).push(fn);
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  remove() {
    this.removed = true;
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    for (const fn of this.handlers[type] ?? []) fn({ stopPropagation() {}, preventDefault() {}, ...e });
  }
}

function stubDom() {
  const body = new FakeEl();
  const win: Record<string, Handler[]> = {};
  vi.stubGlobal("document", { body, createElement: () => new FakeEl(), querySelectorAll: () => [] });
  vi.stubGlobal("HTMLCanvasElement", FakeCanvas);
  vi.stubGlobal("DOMRect", class { constructor(public left = 0, public top = 0, public width = 0, public height = 0) {} get bottom() { return this.top + this.height; } });
  vi.stubGlobal("innerHeight", 600);
  vi.stubGlobal("innerWidth", 800);
  const add = (type: string, fn: Handler) => void (win[type] ??= []).push(fn);
  const remove = (type: string, fn: Handler) => void (win[type] = (win[type] ?? []).filter((f) => f !== fn));
  vi.stubGlobal("window", { innerHeight: 600, innerWidth: 800, addEventListener: add, removeEventListener: remove });
  vi.stubGlobal("addEventListener", add);
  vi.stubGlobal("removeEventListener", remove);
  const bar = () => body.children.find((c) => "data-touch-bar" in c.attrs)!;
  const button = (key: string) => bar().children.find((b) => b.attrs["data-key"] === key)!;
  const dispatch = (type: string, e: Record<string, unknown>) => (win[type] ?? []).slice().forEach((fn) => fn(e));
  return { body, bar, button, dispatch };
}

describe("touch", () => {
  it("the music page's buttons are its keys, and Back loads the tour", async () => {
    const dom = stubDom();
    await boot("scenes/music.scene.json");
    const label = () => (engine!.world._componentsOfType(MusicLab)[0] as MusicLab).node.getBehavior(Text)!.text;
    expect(dom.bar().children.map((b) => b.attrs["data-key"])).toEqual(["1", "2", "3", "t", "y", "l", "p", "4", "5", "o", "d", "b"]);
    dom.button("4").fire("pointerdown");
    advance(0.1);
    expect(label()).toContain("eight stems");
    dom.button("o").fire("pointerdown");
    advance(0.1);
    expect(label()).toContain("Music: off");
    engine!.dispose();
    engine = null;
    expect(dom.bar().removed, "the bar goes with the page").toBe(true);
  });

  it("on the rhythm page a pointer press on the game canvas is a tap at the event's time stamp; a press on a button or elsewhere is not", async () => {
    const dom = stubDom();
    await boot("scenes/rhythm.scene.json");
    const page = () => (globalThis as unknown as { __rhythmLab: { state(): RhythmState; page: RhythmLab } }).__rhythmLab;
    dom.button("c").fire("pointerdown");
    advance(1.5);
    expect(page().state().mode).toBe("calibrate");
    const handle = (page().page as unknown as { handle: { music: { positionAt(t: number): { nearestBeatTime: number } } } }).handle;
    const stampLate = (delta: number): number => {
      const here = clock.rafTime;
      const beat = handle.music.positionAt(here).nearestBeatTime;
      return here + (beat + delta - Audio.timeAt(here)) * 1000;
    };
    clock.time += 1 / 60; // the frame that reads the press (the fake's `timeAt` follows the clock)
    dom.dispatch("pointerdown", { button: 0, target: new FakeCanvas(), timeStamp: stampLate(0.05) });
    engine!.step(1 / 60);
    expect(page().state().taps).toBe(1);
    expect(page().state().offsetsMs[0]).toBeCloseTo(50, 3); // timed from the event's stamp, not the frame
    dom.dispatch("pointerdown", { button: 0, target: {}, timeStamp: stampLate(0.05) }); // not the canvas
    dom.dispatch("pointerdown", { button: 2, target: new FakeCanvas(), timeStamp: stampLate(0.05) }); // not the primary button
    advance(1 / 30);
    expect(page().state().taps).toBe(1);
    dom.button("o").fire("pointerdown");
    advance(0.1);
    expect(page().state().mode).toBe("");
  });
});
