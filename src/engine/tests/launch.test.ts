// The game launch (ADR 0155), headless with in-memory ports: the order of its steps, the entry scene rule
// for empty start-up Worlds, teardown in reverse, and failures that undo what was done.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, type AssetSource, type Bootstrap, type BootstrapConfig } from "../index";
import { _scriptAssetRefs, _setScriptAssetRefs } from "../scene/warmUp";
import { launchGame, type GameLaunchOptions, type LaunchedGame } from "../launch";

const ENTRY = "scenes/main.scene.json";
const HUD = "scenes/hud.scene.json";
const files = (): AssetSource =>
  Assets.fromObject({
    [ENTRY]: { format: "myco.scene@1", nodes: [{ id: "floor", name: "Floor" }] },
    [HUD]: { format: "myco.scene@1", nodes: [{ id: "score", name: "Score" }] },
  });

/** The names of the scene roots each World holds, by World name. */
function scenesByWorld(engine: Engine): Record<string, string[]> {
  return Object.fromEntries(engine.worlds().map((w) => [w.name, engine._world(w.name)!.sceneNodes.map((n) => n.name)]));
}

const launch = (overrides: Partial<GameLaunchOptions> = {}) =>
  launchGame({ assets: files(), activatePlugins: () => {}, project: {}, entryScene: ENTRY, headless: true, ...overrides });

let running: LaunchedGame | null = null;
afterEach(() => {
  running?.dispose();
  running = null;
  _setScriptAssetRefs([]);
  vi.restoreAllMocks();
});

describe("launchGame", () => {
  it("registers the assets, sets the script refs, loads scripts, activates plugins, then creates the Engine", async () => {
    const steps: string[] = [];
    const assets = files();
    const bootstrap: Bootstrap = (engine) => {
      steps.push("bootstrap");
      engine.createWorld({ name: "Game" });
    };
    running = await launch({
      assets,
      scriptAssetRefs: ["asset:prefabs/enemy.prefab.json"],
      async loadScripts() {
        steps.push(`scripts (assets ${Assets.has(ENTRY) ? "registered" : "missing"}, refs ${_scriptAssetRefs().join()})`);
      },
      activatePlugins: () => void steps.push("plugins"),
      bootstrap,
    });
    expect(steps).toEqual(["scripts (assets registered, refs prefabs/enemy.prefab.json)", "plugins", "bootstrap"]);
    expect(running.engine.isRunning).toBe(false); // the host owns the loop
    expect(scenesByWorld(running.engine)).toEqual({ Game: ["main"] });
  });

  it("loads the entry scene only into start-up Worlds with no `scenes` key and no nodes", async () => {
    const bootstrap: BootstrapConfig = {
      worlds: [
        { name: "Unnamed" },
        { name: "Empty", scenes: [] },
        { name: "Hud", scenes: [HUD] },
      ],
    };
    running = await launch({ bootstrap });
    expect(scenesByWorld(running.engine)).toEqual({ Unnamed: ["main"], Empty: [], Hud: ["hud"] });
  });

  it("leaves a World a code bootstrap filled, and fills one it left empty", async () => {
    running = await launch({
      bootstrap: async (engine) => {
        const menu = engine.createWorld({ name: "Menu" });
        engine.createWorld({ name: "Game" });
        await menu.loadScene(HUD);
      },
    });
    expect(scenesByWorld(running.engine)).toEqual({ Menu: ["hud"], Game: ["main"] });
  });

  it("fills nothing without an entry scene (the dedicated server)", async () => {
    running = await launch({ entryScene: null, bootstrap: { worlds: [{ name: "Server", tags: ["server"] }] } });
    expect(scenesByWorld(running.engine)).toEqual({ Server: [] });
  });

  it("disposes the Engine, then removes the asset source; once", async () => {
    const assets = files();
    const game = await launch({ assets });
    const order: string[] = [];
    const dispose = game.engine.dispose.bind(game.engine);
    vi.spyOn(game.engine, "dispose").mockImplementation(() => {
      order.push(`engine (assets ${Assets.has(ENTRY) ? "registered" : "gone"})`);
      dispose();
    });
    const remove = vi.spyOn(Assets, "removeSource");
    game.dispose();
    game.dispose();
    expect(order).toEqual(["engine (assets registered)"]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(assets);
    expect(Assets.has(ENTRY)).toBe(false);
  });

  it("stops on a plugin that fails to activate, before any Engine, and removes the assets", async () => {
    const bootstrap = vi.fn<Bootstrap>((engine) => void engine.createWorld({ name: "Game" }));
    await expect(
      launch({
        bootstrap,
        activatePlugins: () => {
          throw new Error("acme.broken failed to activate: boom");
        },
      }),
    ).rejects.toThrow("acme.broken failed to activate: boom");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(Assets.has(ENTRY)).toBe(false);
  });

  it("stops on a script that fails to load, before the plugins", async () => {
    const activatePlugins = vi.fn();
    await expect(launch({ loadScripts: () => Promise.reject(new Error("bad script")), activatePlugins })).rejects.toThrow("bad script");
    expect(activatePlugins).not.toHaveBeenCalled();
    expect(Assets.has(ENTRY)).toBe(false);
  });

  it("rethrows a bootstrap problem unchanged and removes the assets", async () => {
    await expect(launch({ bootstrap: { worlds: [] } })).rejects.toThrow(/Invalid bootstrap/);
    expect(Assets.has(ENTRY)).toBe(false);
  });

  it("disposes the Engine when the entry scene fails to load", async () => {
    const disposed = vi.spyOn(Engine.prototype, "dispose");
    await expect(launch({ entryScene: "scenes/missing.scene.json" })).rejects.toThrow(/missing\.scene\.json/);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(Assets.has(ENTRY)).toBe(false);
  });
});
