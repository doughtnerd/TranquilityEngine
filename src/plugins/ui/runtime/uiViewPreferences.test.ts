import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The system's preferences, as a browser's `window.matchMedia` reports them: set before anything reads them (Svelte's
// `prefersReducedMotion` is made when `svelte/motion` is imported), and flipped below as a player changes their OS
// setting.
const system = vi.hoisted(() => {
  const state = { reduce: true, dark: false, listeners: new Set<() => void>() };
  (globalThis as Record<string, unknown>).matchMedia = (query: string) => ({
    get matches() {
      return query.includes("reduced-motion") ? state.reduce : query.includes("dark") ? state.dark : false;
    },
    addEventListener: (_type: string, listener: () => void) => state.listeners.add(listener),
  });
  return {
    set(next: { reduce?: boolean; dark?: boolean }) {
      Object.assign(state, next);
      for (const l of [...state.listeners]) l();
    },
  };
});

import { Assets, Engine, GameObject, Input, MemoryStorage, SceneManager, Storage } from "../../../engine/index";
import { UIPanel, UIText } from "../../../engine/ui/components";
import { UIPreferences } from "./index";
import { UIView } from "./UIView";
import * as PreferencesModule from "./testComponents/Preferences.svelte";

// ADR 0431: `UIPreferences` (the player's reduced motion and colour scheme, defaulting to the system's) as canvas
// `@media (prefers-reduced-motion)`/`(prefers-color-scheme)`, Svelte's `prefersReducedMotion` and `MediaQuery`, through
// a UIView stepped by the engine, and persisted in player storage.

const DT = 1 / 60;
let engine: Engine | null = null;

async function boot(storage = new MemoryStorage()): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "ui/preferences.svelte": PreferencesModule }));
  engine = await Engine.create({ headless: true, storage });
  await SceneManager.load("s.json");
}

async function view(): Promise<UIView> {
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/preferences.svelte", props: {} });
  await v.ready;
  engine!.step(DT);
  return v;
}

const state = (v: UIView) => v.query("#state")!.as(UIText).text;
const box = (v: UIView) => {
  const p = v.query("#box")!.as(UIPanel);
  return { opacity: p.opacity, gap: p.gap, padding: p.padding };
};

beforeEach(() => {
  Input.reset();
  system.set({ reduce: true, dark: false });
});

afterEach(() => {
  UIPreferences.reset();
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  Input.reset();
  vi.restoreAllMocks();
});

describe("UIPreferences", () => {
  it("defaults to the system's preferences, followed live, in @media, prefersReducedMotion and MediaQuery", async () => {
    await boot();
    const v = await view();
    expect(UIPreferences.reducedMotion).toBe(true);
    expect(UIPreferences.colorScheme).toBe("light");
    expect(state(v)).toBe("reduce reduce light");
    expect(box(v)).toEqual({ opacity: 0.5, gap: 0, padding: 2 });

    system.set({ reduce: false, dark: true }); // the player changes their OS setting
    engine!.step(DT);
    engine!.step(DT);
    expect(state(v)).toBe("motion motion dark");
    expect(box(v)).toEqual({ opacity: 1, gap: 3, padding: 0 });
  });

  it("the game's choice overrides the system's and restyles; null follows the system again", async () => {
    await boot();
    const v = await view();
    const changes: string[] = [];
    const off = UIPreferences.onChange(() => changes.push(`${UIPreferences.reducedMotion} ${UIPreferences.colorScheme}`));
    UIPreferences.reducedMotion = false;
    UIPreferences.colorScheme = "dark";
    engine!.step(DT);
    engine!.step(DT);
    expect(state(v)).toBe("motion motion dark");
    expect(box(v)).toEqual({ opacity: 1, gap: 3, padding: 0 });
    system.set({ reduce: true, dark: false }); // the system's change doesn't override the player's choice
    expect(UIPreferences.reducedMotion).toBe(false);

    UIPreferences.reducedMotion = null;
    engine!.step(DT);
    engine!.step(DT);
    expect(state(v)).toBe("reduce reduce dark");
    expect(changes).toEqual(["false light", "false dark", "true dark"]);
    off();
  });

  it("persists the player's choice under settings/myco.ui; a new game loads it before its first scene; reset deletes it", async () => {
    const storage = new MemoryStorage();
    await boot(storage);
    UIPreferences.colorScheme = "dark";
    await vi.waitFor(async () => expect(await Storage.load("myco.ui", "settings")).toEqual({ colorScheme: "dark" }));
    engine!.dispose();
    engine = null;
    expect(UIPreferences.colorScheme).toBe("light"); // that game ended: the next one starts from its own storage

    await boot(storage);
    expect(UIPreferences.colorScheme).toBe("dark");
    const v = await view();
    expect(state(v)).toBe("reduce reduce dark");

    UIPreferences.reset();
    expect(UIPreferences.colorScheme).toBe("light");
    await vi.waitFor(async () => expect(await Storage.load("myco.ui", "settings")).toBeUndefined());
  });

  it("refuses values that aren't preferences, with a warning", async () => {
    await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    UIPreferences.colorScheme = "sepia" as never;
    UIPreferences.reducedMotion = "yes" as never;
    expect(UIPreferences.colorScheme).toBe("light");
    expect(UIPreferences.reducedMotion).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
