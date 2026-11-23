import { signal } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { addEditorOverlay } from "../engine/editor";
import { FakeRenderSurface } from "../engine/render/fakeViewport";
import { FrameWindow } from "./frameWindow";
import { StatsCollector, takeSnapshot } from "./playStats";
import { playStatsTables } from "./sdk/contributions";
import { cleanPlayGizmos, installPlayGizmos, outlineShown, playGizmos, updatePlayGizmos } from "./playGizmos";
import type { PlaySession } from "./playMode";

/** The Gizmos settings a fresh editor starts with. */
const DEFAULT_PLAY_GIZMOS = { enabled: true, navigation: true, outline: true, other: true };

describe("play stats: the frame window", () => {
  it("reports current, min and average fps over the window", () => {
    const w = new FrameWindow(1000);
    let now = 0;
    for (const dt of [10, 20, 10, 40]) w.push(dt, (now += dt));
    const s = w.summary(now)!;
    expect(s.frames).toBe(4);
    expect(s.fps).toBeCloseTo(25); // the latest frame: 40 ms
    expect(s.frameMs).toBe(40);
    expect(s.minFps).toBeCloseTo(25); // the longest frame
    expect(s.avgFps).toBeCloseTo(4000 / 80); // 4 frames in 80 ms
  });

  it("drops frames older than the window, and is empty after a pause", () => {
    const w = new FrameWindow(1000);
    w.push(100, 0); // a slow frame long ago
    for (let t = 1000; t <= 1900; t += 100) w.push(16, t);
    const s = w.summary(1950)!;
    expect(s.frames).toBe(10);
    expect(s.minFps).toBeCloseTo(1000 / 16);
    expect(w.summary(5000)).toBeNull();
  });

  it("ignores non-positive frame times", () => {
    const w = new FrameWindow();
    w.push(0, 1);
    w.push(-5, 2);
    expect(w.summary(3)).toBeNull();
  });
});

describe("play stats: the collector (the Engine's timing hook)", () => {
  it("averages each World's phases and the step between reads, then starts again", () => {
    let now = 0;
    const c = new StatsCollector(() => now);
    now = 16;
    c.frame(16, 2);
    c.world("Default", 1, 2, 3);
    c.world("Server", 0.5, 0, 0);
    now = 32;
    c.frame(16, 4);
    c.world("Default", 3, 4, 5);
    const first = c.takePhases();
    expect(first.step).toBe(3);
    expect(first.worlds.get("Default")).toEqual({ fixedMs: 2, updateMs: 3, renderMs: 4 });
    expect(first.worlds.get("Server")).toEqual({ fixedMs: 0.5, updateMs: 0, renderMs: 0 });
    expect(c.frames.summary(now)!.avgFps).toBeCloseTo(62.5);
    const second = c.takePhases();
    expect(second.step).toBeNull();
    expect(second.worlds.size).toBe(0);
  });
});

describe("play view gizmos settings", () => {
  it("shows a kind only with the master toggle on and the kind's box ticked", async () => {
    const engine = await Engine.create({ headless: true });
    const world = engine.world;
    const surface = new FakeRenderSurface(); // the game view: its viewport keeps the overlay it is given
    world.render = surface;
    // Each overlay's draw function records that it ran; `drawn` runs what the game view would draw this frame.
    const ran: string[] = [];
    for (const kind of ["navigation", "colliders", "other"] as const) addEditorOverlay(world, kind, () => (ran.push(kind), { lines: [], handles: [] }), kind);
    const drawn = (): string[] => {
      ran.length = 0;
      surface.adapter.overlay?.();
      return [...ran];
    };
    const stop = installPlayGizmos(signal<PlaySession | null>({ engine } as unknown as PlaySession));
    expect(drawn()).toEqual(["navigation", "colliders", "other"]);
    updatePlayGizmos({ navigation: false });
    expect(drawn()).toEqual(["colliders", "other"]);
    updatePlayGizmos({ navigation: true, other: false });
    expect(drawn()).toEqual(["navigation", "colliders"]);
    updatePlayGizmos({ other: true, enabled: false });
    expect(drawn()).toEqual([]); // colliders too follow the master toggle
    stop();
    world.render = null;
    playGizmos.value = cleanPlayGizmos(null);
    engine.dispose();
    const off = { ...DEFAULT_PLAY_GIZMOS, enabled: false };
    expect(outlineShown(off)).toBe(false);
    expect(outlineShown({ ...DEFAULT_PLAY_GIZMOS, outline: false })).toBe(false);
    expect(outlineShown(DEFAULT_PLAY_GIZMOS)).toBe(true);
  });

  it("replaces unusable stored values with the defaults", () => {
    expect(cleanPlayGizmos(null)).toEqual(DEFAULT_PLAY_GIZMOS);
    expect(cleanPlayGizmos({ enabled: false, navigation: "yes" as unknown as boolean })).toEqual({ ...DEFAULT_PLAY_GIZMOS, enabled: false });
  });
});

describe("play stats: plugin tables (T34)", () => {
  it("lists each registered table's rows on every World, and leaves out a table with none", async () => {
    const engine = await Engine.create({ headless: true });
    const off = [
      playStatsTables.register({ id: "test.rows", title: "Rows", rows: () => [{ label: "A", value: "1", detail: "one" }] }),
      playStatsTables.register({ id: "test.none", title: "None", rows: () => null }),
    ];
    try {
      const snapshot = takeSnapshot(engine, new StatsCollector());
      expect(snapshot.worlds[0]!.tables).toEqual([{ title: "Rows", rows: [{ label: "A", value: "1", detail: "one" }] }]);
    } finally {
      for (const o of off) o();
      engine.dispose();
    }
  });
});
