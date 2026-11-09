import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { MemoryStorage, type StorageNamespace, type StorageValue } from "../engine/platform/Storage";
import { SetField } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { sceneOpenMigrations } from "./sdk/contributions";
import { shortcutFor } from "./shortcuts";
import { createSceneTabs, tabsToClose, type SceneTabs } from "./sceneTabs";
import { openScene, openScenes, sceneCamera, select, selectedKeys, status, type OpenScene } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings, sampleProject } from "./testing";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

const tabs = ["a", "b", "c", "d"];
const dirty = (t: string) => t === "b" || t === "d";

describe("tabsToClose", () => {
  it("closes by mode", () => {
    expect(tabsToClose(tabs, "c", "this", dirty)).toEqual(["c"]);
    expect(tabsToClose(tabs, "c", "others", dirty)).toEqual(["a", "b", "d"]);
    expect(tabsToClose(tabs, "c", "all", dirty)).toEqual(tabs);
    expect(tabsToClose(tabs, "b", "right", dirty)).toEqual(["c", "d"]);
    expect(tabsToClose(tabs, "c", "left", dirty)).toEqual(["a", "b"]);
    expect(tabsToClose(tabs, "a", "saved", dirty)).toEqual(["a", "c"]);
  });
  it("closes nothing to the right of the last tab", () => {
    expect(tabsToClose(tabs, "d", "right", dirty)).toEqual([]);
    expect(tabsToClose(tabs, "a", "left", dirty)).toEqual([]);
  });
});

describe("close tab shortcut", () => {
  it("is Ctrl/Cmd+W, and plain W is still the move tool", () => {
    expect(shortcutFor({ key: "w", ctrlKey: true, metaKey: false, shiftKey: false })).toBe("close-tab");
    expect(shortcutFor({ key: "w", ctrlKey: false, metaKey: true, shiftKey: false })).toBe("close-tab");
    expect(shortcutFor({ key: "w", ctrlKey: false, metaKey: false, shiftKey: false })).toBe("tool:move");
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Per-user history storage in memory whose reads can be held back, counting writes. */
class GatedStorage extends MemoryStorage {
  gate: Promise<void> | null = null;
  saves = 0;
  override async load(ns: StorageNamespace, key: string): Promise<StorageValue | undefined> {
    if (this.gate) await this.gate;
    return super.load(ns, key);
  }
  override async save(ns: StorageNamespace, key: string, value: StorageValue): Promise<void> {
    this.saves++;
    return super.save(ns, key, value);
  }
}

const PREFAB = "prefabs/pipe-pair.prefab.json";
const tick = () => new Promise((r) => setTimeout(r, 0));
const setBirdY = (scene: OpenScene, y: number) => scene.stack.execute(new SetField("bird", "engine.Transform", "position", [-4, y, 0]));
const birdY = (scene: OpenScene) => (scene.doc.fieldValue("bird", "engine.Transform", "position") as number[])[1];

describe("scene tabs (ADR 0026, 0027)", () => {
  let engine: Engine;
  let storage: GatedStorage;
  let sceneTabs: SceneTabs;
  /** Titles of the dialogs asked, in order. */
  let asked: string[];
  /** How the scripted confirm answers. */
  let answer: (options: ConfirmOptions) => Promise<{ ok: boolean }>;
  let switches: number;
  const project = sampleProject(); // read-only: its histories go to per-user storage

  beforeEach(async () => {
    Input.reset();
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    storage = new GatedStorage();
    asked = [];
    answer = async () => ({ ok: true });
    switches = 0;
    status.value = null;
    sceneTabs = createSceneTabs({
      world: () => engine.world,
      history: { project: () => project, location: () => "user", platform: async () => ({ fs: null, userStorage: storage }) },
      confirm: (options) => {
        asked.push(options.title);
        return answer(options);
      },
      beforeSwitch: () => switches++,
    });
  });

  afterEach(async () => {
    await sceneTabs.settled();
    await sceneTabs.closeAll();
    engine.dispose();
    sceneCamera.value = null;
  });

  it("opens, switches between, closes and closes all tabs, each keeping its view", async () => {
    await sceneTabs.open(DEMO_SCENE);
    const main = openScene.value!;
    expect(openScenes.value).toEqual([main]);
    expect(main.sync.nodeFor("bird")).toBeTruthy();
    select(["bird"]);

    await sceneTabs.open(PREFAB);
    const prefab = openScene.value!;
    expect(openScenes.value).toEqual([main, prefab]);
    expect(main.sync.nodeFor("bird")).toBeFalsy(); // put aside: no nodes in the World
    expect(selectedKeys.value).toEqual([]);

    await sceneTabs.open(DEMO_SCENE); // open already: switches to its tab
    expect(openScene.value).toBe(main);
    expect(openScenes.value).toEqual([main, prefab]);
    expect(main.sync.nodeFor("bird")).toBeTruthy();
    expect(selectedKeys.value).toEqual(["bird"]);

    setBirdY(main, 7);
    sceneTabs.activate(prefab);
    expect(openScene.value).toBe(prefab);
    sceneTabs.activate(main);
    expect(birdY(main)).toBe(7); // unsaved changes stay with the tab
    expect(main.sync.nodeFor("bird")!.transform!.position.y).toBe(7);

    answer = async () => ({ ok: false });
    expect(await sceneTabs.close([main])).toBe(0);
    expect(asked).toEqual(["Close main.scene.json?"]);
    expect(openScenes.value).toEqual([main, prefab]);

    answer = async () => ({ ok: true });
    expect(await sceneTabs.close([main])).toBe(1);
    expect(openScenes.value).toEqual([prefab]);
    expect(openScene.value).toBe(prefab); // its neighbour
    expect(await sceneTabs.close([main])).toBe(0); // closed already

    await sceneTabs.open(DEMO_SCENE);
    expect(openScenes.value.map((s) => s.path)).toEqual([PREFAB, DEMO_SCENE]);
    expect(switches).toBeGreaterThan(0); // play mode stops before the tab changes

    await sceneTabs.closeAll();
    expect(openScenes.value).toEqual([]);
    expect(openScene.value).toBeNull();
    expect(engine.world.root.children.map((c) => c.name)).toEqual(["SceneCamera"]); // only the editor's own tools are left
  });

  it("closing a tab while its history is attaching leaves no history saving and runs no migrations", async () => {
    const migrated: string[] = [];
    const off = sceneOpenMigrations.register({ id: "test.migration", failure: "migrate", migrate: async (s) => void migrated.push(s.path) });
    try {
      await sceneTabs.open(DEMO_SCENE);
      await sceneTabs.settled();
      expect(migrated).toEqual([DEMO_SCENE]);

      const gate = deferred<void>();
      storage.gate = gate.promise;
      await sceneTabs.open(PREFAB);
      const prefab = openScene.value!;
      await tick(); // the history is loading now
      expect(await sceneTabs.close([prefab])).toBe(1);
      storage.gate = null;
      gate.resolve();
      await sceneTabs.settled();
      expect(migrated).toEqual([DEMO_SCENE]);

      const saves = storage.saves;
      prefab.stack.execute(new SetField("top", "engine.Transform", "position", [0, 1, 0]));
      await tick();
      await tick();
      expect(storage.saves).toBe(saves); // detached: the closed tab's edits aren't written

      setBirdY(openScene.value!, 3); // the open tab's still are
      await vi.waitFor(() => expect(storage.saves).toBeGreaterThan(saves));
    } finally {
      off();
    }
  });

  it("a scene that fails to open brings the previous tab back", async () => {
    await sceneTabs.open(DEMO_SCENE);
    const main = openScene.value!;
    select(["bird"]);
    await sceneTabs.open("scenes/missing.scene.json");
    expect(status.value?.kind).toBe("error");
    expect(status.value?.text).toContain("Couldn't open scenes/missing.scene.json");
    expect(openScene.value).toBe(main);
    expect(openScenes.value).toEqual([main]);
    expect(main.sync.nodeFor("bird")).toBeTruthy();
    expect(selectedKeys.value).toEqual(["bird"]);
  });

  it("offers unsaved changes back on reopening, and ignores the answer once the tab has closed", async () => {
    await sceneTabs.open(DEMO_SCENE);
    await sceneTabs.settled();
    const first = openScene.value!;
    const savedY = birdY(first);
    setBirdY(first, 5);
    expect(await sceneTabs.close([first])).toBe(1); // "close without saving": the change stays in the history
    await sceneTabs.settled();

    await sceneTabs.open(DEMO_SCENE);
    await sceneTabs.settled();
    const second = openScene.value!;
    expect(asked).toEqual(["Close main.scene.json?", "Restore unsaved changes?"]);
    expect(birdY(second)).toBe(5); // restored while open
    expect(status.value?.text).toBe(`Restored the unsaved changes to ${DEMO_SCENE}.`);
    setBirdY(second, 6);
    expect(await sceneTabs.close([second])).toBe(1);
    await sceneTabs.settled();

    const restore = deferred<{ ok: boolean }>();
    answer = (options) => (options.title.startsWith("Restore") ? restore.promise : Promise.resolve({ ok: true }));
    status.value = null;
    await sceneTabs.open(DEMO_SCENE);
    const third = openScene.value!;
    await vi.waitFor(() => expect(asked.filter((t) => t.startsWith("Restore"))).toHaveLength(2));
    expect(third.stack.dirty).toBe(false);
    expect(await sceneTabs.close([third])).toBe(1);
    restore.resolve({ ok: true });
    await sceneTabs.settled();
    expect(birdY(third)).toBe(savedY); // not restored into the closed tab
    expect(status.value).toBeNull();
  });
});

describe("the scene tabs are the only writer of openScene and openScenes", () => {
  const SRC = resolve(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
    });

  it("writes them in one place, in sceneTabs.ts", () => {
    const writes = files(SRC).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/\bopenScenes?\.value\s*=(?!=)/g)].map((m) => `${relative(SRC, f).replaceAll("\\", "/")}: ${m[0].replace(/\s*=$/, "")}`),
    );
    expect(writes.sort()).toEqual(["editor/sceneTabs.ts: openScene.value", "editor/sceneTabs.ts: openScenes.value"]);
  });
});
