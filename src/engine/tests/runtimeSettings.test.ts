import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../index";
import { World } from "../core/World";
import { RUNTIME_SETTINGS, defaultSettings, resolveSettings, settingsIssues, type ProjectSettingsInput } from "../core/settings";

// ADR 0272: each runtime project.json section declared once: key, default, and a parse giving the value and its problems.

afterEach(() => vi.restoreAllMocks());

const fields = (input: Record<string, unknown>) => settingsIssues(input).problems.map((p) => p.field);

describe("runtime settings sections", () => {
  it("declare every key the engine reads, with a default that is what an absent section parses to", () => {
    expect(Object.keys(RUNTIME_SETTINGS)).toEqual(["name", "display", "time", "physics", "render", "graphics", "lighting2D", "navigation", "audio", "input", "autoload", "plugins", "languages", "subtitles"]);
    for (const section of Object.values(RUNTIME_SETTINGS)) {
      expect(section.parse(undefined)).toEqual({ value: section.default, problems: [], warnings: [] });
    }
    expect(defaultSettings).toEqual(resolveSettings({}));
    expect(defaultSettings.display).toEqual({ width: 1280, height: 720, backgroundColor: "#000000", scaleMode: "fit" });
    expect("plugins" in defaultSettings).toBe(false);
    expect(settingsIssues({})).toEqual({ problems: [], warnings: [] });
  });

  it("replace a value of the wrong type or range with its default, and say so by field", () => {
    const input = { name: "", display: { width: -5, height: 600, scaleMode: "zoom" }, time: { maxSubSteps: 1.5 }, render: { pixelsPerUnit: 0 } } as unknown as ProjectSettingsInput;
    const settings = resolveSettings(input);
    expect(settings.name).toBe("Untitled");
    expect(settings.display).toEqual({ width: 1280, height: 600, backgroundColor: "#000000", scaleMode: "fit" });
    expect(settings.time.maxSubSteps).toBe(5);
    expect(settings.render.pixelsPerUnit).toBe(100);
    expect(fields(input as Record<string, unknown>)).toEqual(["name", "display.width", "display.scaleMode", "time.maxSubSteps", "render.pixelsPerUnit"]);
  });

  it("keep what's written and valid, unknown keys included", () => {
    const settings = resolveSettings({ display: { width: 800, custom: 1 } as never, time: { fixedDeltaTime: 0.01 } });
    expect(settings.display).toMatchObject({ width: 800, height: 720, custom: 1 });
    expect(settings.time.fixedDeltaTime).toBe(0.01);
  });

  it("accept a fixed timestep longer than the max frame time, like Unity: fixed steps then run less than once a frame", () => {
    const time = { fixedDeltaTime: 0.5, maxSubSteps: 5, maxFrameTime: 0.25 };
    expect(settingsIssues({ time })).toEqual({ problems: [], warnings: [] });
    expect(resolveSettings({ time }).time).toEqual(time);
    const world = new World("runtime", { time });
    world.step(0.25);
    expect(world.time.fixedStepCount).toBe(0);
    world.step(0.25);
    expect(world.time.fixedStepCount).toBe(1);
    world.step(10); // clamped to maxFrameTime: still half a step a frame, never a burst
    expect(world.time.fixedStepCount).toBe(1);
  });

  it("check physics the same way for the engine and the Physics settings section: gravity, layers, the matrix and backend ids", () => {
    const physics = { gravity: [0], layers: ["Default", "Default"], collisionMatrix: { Default: ["Ghost"] }, backend2d: "", backend3d: "rapier" };
    const { value, problems } = RUNTIME_SETTINGS.physics.parse(physics);
    expect(problems.map((p) => p.field)).toEqual(["physics.gravity", "physics.layers.1", "physics.backend2d", "physics.collisionMatrix"]);
    expect(value.gravity).toEqual([0, -9.81]); // replaced
    expect(value.layers).toEqual(["Default", "Default"]); // layers are named by index: kept, the duplicate reported
    expect(value.backend2d).toBeUndefined(); // a bad id is dropped, so the only enabled backend is used
    expect(value.backend3d).toBe("rapier");
    expect(RUNTIME_SETTINGS.physics.parse({ layers: Array.from({ length: 17 }, (_, i) => `L${i}`) }).problems.map((p) => p.message)).toEqual(["There can be at most 16 physics layers."]);
  });

  it("report the lenient sections' problems under their key, and warnings apart", () => {
    expect(RUNTIME_SETTINGS.graphics.parse({ tiers: 5 }).problems.every((p) => p.field === "graphics")).toBe(true);
    expect(RUNTIME_SETTINGS.navigation.parse(5).problems.length).toBeGreaterThan(0);
    expect(RUNTIME_SETTINGS.render.parse({ sortingLayers: ["Back"] }).warnings.map((w) => w.field)).toEqual(["render.sortingLayers"]);
    expect(RUNTIME_SETTINGS.plugins.parse({ disabled: 3 }).value).toEqual({ disabled: 3 });
    expect(RUNTIME_SETTINGS.plugins.parse({ disabled: 3 }).problems.map((p) => p.field)).toEqual(["plugins"]);
  });
});

describe("the Engine's start-up warnings", () => {
  it("say every runtime section's problems and warnings, one rule for all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const project = { display: { width: 0 }, physics: { gravity: "down" }, render: { sortingLayers: ["Back"] }, navigation: 7 } as unknown as ProjectSettingsInput;
    const engine = await Engine.create({ headless: true, project });
    try {
      const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[myco] project.json"));
      const issues = settingsIssues(project);
      expect(said).toEqual([...issues.problems, ...issues.warnings].map((i) => `[myco] project.json ${i.message}`));
      expect(said).toEqual(expect.arrayContaining([
        "[myco] project.json Display width must be a whole number of pixels above 0.",
        "[myco] project.json Gravity must be two numbers, x and y, or three with z.",
        '[myco] project.json There\'s no "Default" sorting layer, which sprites use unless they name another.',
      ]));
      expect(issues.problems.some((p) => p.field === "navigation")).toBe(true);
      expect(engine.settings.display.width).toBe(1280);
    } finally {
      engine.dispose();
    }
  });
});
