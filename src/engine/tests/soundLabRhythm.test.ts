// ADR 0166 task Rh3: the Sound Lab's rhythm page (samples/sound-lab/scenes/rhythm.scene.json, scripts/behaviors/RhythmLab.ts).
// The scene data is valid (the two playlists, migrated from audio events (ADR 0343), parse and lint clean, the click clip is one bar with a click on every beat, the
// scene and the tour's link load), and the page's script is run headless on the fake backend with synthetic taps: a
// calibration run feeds `Calibration.fromTaps` and sets `Audio.calibration`, the offset is stored and read back as after a
// reload, an unsteady run is refused, and the tap game grades taps by `judged`. The browser run is E3's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager, UIDocument } from "../../myco";
import { readProject } from "../../server/project";
import { Storage } from "../platform/Storage";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import.meta.glob("../../../samples/sound-lab/scripts/behaviors/*.ts", { eager: true });
import { parsePlaylist } from "../audio/playlist/format";
import { lintPlaylist } from "../audio/playlist/lint";
import { parseAudioProject } from "../audio/project/format";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { makeFakeBackend, endAudioSession } from "../../plugins/audio/runtime/testing";
import { Audio } from "../../plugins/audio/runtime";
import { setCalibration } from "../../plugins/audio/runtime/music/calibration";
import type { RhythmLab, RhythmState, RhythmTap } from "../../../samples/sound-lab/scripts/behaviors/RhythmLab";

/** Lets the calibration's storage read or write land (a few promise turns). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SAMPLE = fileURLToPath(new URL("../../../samples/sound-lab/", import.meta.url));
const read = (path: string): Buffer => readFileSync(`${SAMPLE}${path}`);
const json = (path: string): unknown => JSON.parse(read(path).toString("utf8"));

/** A mono 16-bit WAV's length in seconds, from its header (what `tools/makeMusic.mjs` writes). */
function seconds(path: string): number {
  const b = read(path);
  return b.readUInt32LE(40) / 2 / b.readUInt32LE(24);
}

describe("the rhythm page's data", () => {
  for (const [name, stems] of [["rhythm-click", ["click-track"]], ["rhythm-game", ["combat-drums", "combat-bass"]]] as const) {
    it(`${name}: parses without a problem, one sequence looping its whole length on a 120 bpm grid, and the lint finds nothing (parallel stems are no problem)`, () => {
      const { playlist, problems } = parsePlaylist(json(`audio/music/${name}.playlist.json`), name);
      expect(problems).toEqual([]);
      expect(playlist.type).toBe("sequence");
      expect(playlist.playback.plays).toBe("untilStopped");
      const seq = playlist.sequence!;
      expect(seq.tempo).toEqual({ bpm: 120, meter: "4/4" });
      expect(seq.loops.map((l) => [l.start, l.end, l.active])).toEqual([[0, seq.length, "always"]]);
      // Every stem is a sync clip over the whole sequence, as long as its WAV.
      const clips = seq.tracks.flatMap((t) => t.clips);
      expect(clips.map((c) => c.sample)).toEqual(stems.map((s) => `audio/music/${s}.wav`));
      for (const c of clips) {
        expect([c.at, c.length, c.sync]).toEqual([0, seq.length, true]);
        expect(seconds(c.sample!)).toBeCloseTo(seq.length, 6);
      }
      // Stems are sync clips on parallel tracks, all on the sequence clock (UI pass decision 4): no warning.
      expect(lintPlaylist(playlist)).toEqual([]);
    });
  }

  it("the click track is one bar (2 s at 22.05 kHz) with a click on each beat and silence between", () => {
    const b = read("audio/music/click-track.wav");
    const rate = b.readUInt32LE(24);
    const frames = b.readUInt32LE(40) / 2;
    expect(frames / rate).toBeCloseTo(2, 6);
    const at = (s: number) => b.readInt16LE(44 + Math.round(s * rate) * 2);
    for (let beat = 0; beat < 4; beat++) {
      let peak = 0;
      for (let i = 0; i < 0.01 * rate; i++) peak = Math.max(peak, Math.abs(b.readInt16LE(44 + (Math.round(beat * 0.5 * rate) + i) * 2)));
      expect(peak).toBeGreaterThan(5000); // the click is in the first 10 ms of its beat
      expect(Math.abs(at(beat * 0.5 + 0.3))).toBeLessThan(50); // quiet by 300 ms
    }
  });

  it("the tour scene links to the page with R, and the project turns rhythm mode on", () => {
    const main = JSON.stringify(json("scenes/main.scene.json"));
    expect(main).toContain('"scene":"scenes/rhythm.scene.json"');
    expect(main).toContain('"key":"r"');
    expect(parseAudioProject(json("audio.json")).project.settings.rhythmMode).toBe(false); // project-wide, so off in the lab (build log D17)
  });
});

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
  advance(0.1); // the page's start() runs on the first step
}

const advance = (seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    fake.advance(1 / 60);
    engine!.step(1 / 60);
  }
};

const page = () => (globalThis as unknown as { __rhythmLab: { state(): RhythmState; page: RhythmLab } }).__rhythmLab;
const state = () => page().state();

/** A performance time whose heard time (`Audio.timeAt`) is `delta` seconds after the beat nearest the present. */
function tapNearBeat(delta: number, beatsAhead = 0): number {
  const here = fake.rafTime;
  const music = (page().page as unknown as { handle: { music: { positionAt(t: number): { nearestBeatTime: number } } } }).handle.music;
  const beat = music.positionAt(here).nearestBeatTime + beatsAhead * 0.5;
  return here + (beat + delta - Audio.timeAt(here)) * 1000;
}

beforeEach(() => {
  fake.clear();
  for (const [p, s] of [["click-track", 2], ["combat-drums", 4], ["combat-bass", 4]] as const) fake.durations.set(`audio/music/${p}.wav`, s);
  fake.advanceTo(0); // the rAF time moves with it, back to 0
  fake.ready = true;
  setAudioBackend(fake);
  endAudioSession();
  warnings.length = 0;
  errors.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});

afterEach(async () => {
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  vi.restoreAllMocks();
  endAudioSession();
  setCalibration(0);
  await settle();
  setAudioBackend(null);
});

/** Starts a run (C or G) and steps until the music is playing on the grid, so `positionAt` answers. */
async function begin(key: "calibrate" | "game"): Promise<void> {
  page().page.begin(key);
  advance(1.5);
  expect((page().page as unknown as { handle: { music: { segment: string | null } } }).handle.music.segment).not.toBeNull();
}

describe("the rhythm page's script", () => {
  it("loads, shows how to use it, and reads the calibration state", async () => {
    await boot("scenes/rhythm.scene.json");
    advance(0.2);
    const s = state();
    expect(s.mode).toBe("");
    expect(s.calibrationMs).toBe(0);
    expect(s.calibrationStale).toBe(false);
    expect(s.latencyMs.reliable).toBe(false);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("a calibration run: 20 synthetic taps (a steady 40 ms late) set Audio.calibration, and the offset is stored", async () => {
    await boot("scenes/rhythm.scene.json");
    await begin("calibrate");
    expect(state().mode).toBe("calibrate");
    for (let i = 0; i < 20; i++) {
      advance(0.5);
      const jitter = ((i * 7) % 5 - 2) * 0.002; // within +-4 ms
      const tap = page().page.tap(tapNearBeat(0.04 + jitter)) as RhythmTap;
      expect(tap.offsetMs).toBeCloseTo((0.04 + jitter) * 1000, 3);
      expect(tap.grade).toBe("");
    }
    const s = state();
    expect(s.taps).toBe(20);
    expect(s.mode).toBe(""); // the run ends itself and stops the click track
    expect(s.result?.used).toBe(16);
    expect(s.result?.discarded).toBe(4);
    expect(s.result?.steady).toBe(true);
    expect(s.result?.applied).toBe(true);
    expect(s.result?.offsetMs).toBeGreaterThan(36);
    expect(s.result?.offsetMs).toBeLessThan(44);
    expect(Audio.calibration * 1000).toBeCloseTo(s.result!.offsetMs, 6);
    expect(s.calibrationMs).toBeCloseTo(s.result!.offsetMs, 6);
    // Stored per output device (the default one here), and read back by the device's start (a reload with memory gone is
    // `music/calibration.test.ts`'s, on a fresh module).
    await settle();
    const stored = await Storage.load<{ seconds: number }>("audio.calibration.default", "settings");
    expect(stored?.seconds).toBeCloseTo(Audio.calibration, 9);
    const before = Audio.calibration;
    fake.device = { outputSink: "", onOutputDevice: null }; // the default device's start (ADR 0248: the backend reports it)
    setAudioBackend(fake);
    await settle();
    expect(Audio.calibration).toBeCloseTo(before, 9);
    expect(Audio.calibrationStale).toBe(false);
    expect(errors).toEqual([]);
  });

  it("an unsteady run (taps scattered over +-100 ms) is reported but not applied", async () => {
    await boot("scenes/rhythm.scene.json");
    await begin("calibrate");
    for (let i = 0; i < 20; i++) {
      advance(0.5);
      page().page.tap(tapNearBeat(i % 2 ? 0.1 : -0.1));
    }
    const s = state();
    expect(s.result?.steady).toBe(false);
    expect(s.result?.applied).toBe(false);
    expect(Audio.calibration).toBe(0);
  });

  it("a tap with no music playing does not count", async () => {
    await boot("scenes/rhythm.scene.json");
    advance(0.2);
    expect(page().page.tap(0)).toBeNull();
    expect(state().taps).toBe(0);
  });

  it("the tap game judges by `judged`: the calibration moves the zero, and early and late read their sign", async () => {
    await boot("scenes/rhythm.scene.json");
    setCalibration(0.05); // this player hears 50 ms late
    await begin("game");
    advance(0.5);
    let tap = page().page.tap(tapNearBeat(0.05)) as RhythmTap; // 50 ms raw late = on the beat once calibrated
    expect(tap.offsetMs).toBeCloseTo(50, 3);
    expect(tap.judgedMs).toBeCloseTo(0, 3);
    expect(tap.grade).toBe("perfect");
    advance(0.5);
    tap = page().page.tap(tapNearBeat(0.05 + 0.06)) as RhythmTap; // 60 ms late
    expect(tap.judgedMs).toBeCloseTo(60, 3);
    expect(tap.grade).toBe("good");
    advance(0.5);
    tap = page().page.tap(tapNearBeat(0.05 - 0.07)) as RhythmTap; // 70 ms early
    expect(tap.judgedMs).toBeCloseTo(-70, 3);
    expect(tap.grade).toBe("good");
    advance(0.5);
    tap = page().page.tap(tapNearBeat(0.05 + 0.15)) as RhythmTap;
    expect(tap.grade).toBe("miss");
    const s = state();
    expect([s.hits, s.misses, s.streak, s.bestStreak]).toEqual([3, 1, 0, 3]);
    expect(s.last?.grade).toBe("miss");
  });

  it("beat callbacks reach the page (handle.onMusic) while the music plays", async () => {
    await boot("scenes/rhythm.scene.json");
    await begin("game");
    advance(2);
    expect(state().beats).toBeGreaterThanOrEqual(2);
    expect(state().lastBeat).toMatch(/^\d+:[1-4]$/);
  });

  it("the page shows the keys on screen", async () => {
    await boot("scenes/rhythm.scene.json");
    advance(0.2);
    expect(read("ui/rhythm.ui.xml").toString("utf8")).toContain("Tap SPACE");
    const hud = (page().page as unknown as { hud: GameObject | null }).hud;
    const text = hud?.getBehavior(UIDocument)?.data.rhythm as string;
    for (const key of ["C calibrate", "G tap game", "X reset", "O stops", "B goes back", "SPACE"]) expect(text).toContain(key);
  });
});
