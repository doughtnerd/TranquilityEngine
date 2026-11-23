// Starting a game (ADR 0236): the one ordered launch the player, the dedicated server and the editor's play
// mode share. Each host is an adapter that supplies the ports: where the files come from, how its scripts
// load, which plugin set it activates, the entry scene and its Engine flags. The engine knows nothing of
// plugins (ADR 0135), so activation is a function the host passes.
import { Engine, type EngineOptions } from "./core/Engine";
import { acquireProjectContext } from "./core/projectContext";
import { World } from "./core/World";
import { SceneManager } from "./scene/SceneManager";
import type { AssetSource } from "./scene/Assets";
import { _setScriptAssetRefs } from "./scene/warmUp";

export interface GameLaunchOptions {
  /** The game's files; registered first, in a project context of their own (ADR 0319), and removed by `dispose()`. */
  readonly assets: AssetSource;
  /** Prefabs and materials the scripts name, warmed up with every scene (ADR 0080). Omit to keep the refs the host's script loader set. */
  readonly scriptAssetRefs?: readonly string[];
  /** Load the host's scripts and plugin modules, after the assets are registered (they register their types). */
  readonly loadScripts?: () => Promise<void>;
  /** Make the host's plugin set active (ADR 0144). A throw stops the launch, as a broken script does. */
  readonly activatePlugins: () => void;
  /** `project.json`. */
  readonly project: EngineOptions["project"];
  /** Which Worlds to create, over the project's bootstrap (the server's filtered one). */
  readonly bootstrap?: EngineOptions["bootstrap"];
  /** Imports a code bootstrap's script. */
  readonly loadScript?: EngineOptions["loadScript"];
  /**
   * The scene that start-up Worlds whose config has no `scenes` key, and that hold no nodes after the
   * bootstrap, load: the build's main scene, play mode's open scene. Null: no World is filled (the server).
   */
  readonly entryScene: string | null;
  /** The element the game draws in; omit, or set `headless`, to run without rendering. */
  readonly container?: HTMLElement;
  readonly headless?: boolean;
  /** `"keep"` leaves the active graphics tier alone (play mode); default `"player"`. */
  readonly quality?: EngineOptions["quality"];
  /** Saves and settings (ADR 0317): play mode passes the played project's own; default the game's (`storageScope.ts`). */
  readonly storage?: EngineOptions["storage"];
  /** Log shader variants compiled mid-game (ADR 0080; play mode). */
  readonly reportShaderVariants?: boolean;
}

export interface LaunchedGame {
  /** The game's Engine, not yet started: the host owns the loop. */
  readonly engine: Engine;
  /** Undo the launch in reverse: dispose the Engine (stopping it, releasing its context), then release the asset source's. Idempotent. */
  dispose(): void;
}

/**
 * Launch a game: register the assets, load the scripts, activate the plugins, create the Engine and fill
 * empty start-up Worlds with the entry scene. A failure at any step undoes the steps done and rethrows the
 * error unchanged, for the host to present.
 */
export async function launchGame(options: GameLaunchOptions): Promise<LaunchedGame> {
  // The files come first, on their own: the scripts load from them before the Engine (and its context) exists.
  const files = acquireProjectContext({ assets: options.assets });
  let engine: Engine | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    engine?.dispose();
    files.release();
  };
  try {
    if (options.scriptAssetRefs) _setScriptAssetRefs(options.scriptAssetRefs);
    await options.loadScripts?.();
    options.activatePlugins();
    engine = await Engine.create({
      project: options.project,
      ...(options.bootstrap !== undefined ? { bootstrap: options.bootstrap } : {}),
      ...(options.loadScript ? { loadScript: options.loadScript } : {}),
      ...(options.container ? { container: options.container } : {}),
      headless: options.headless ?? !options.container,
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      // The autoloads start with the entry scene, after its preparation (preload audio packages, ADR 0351 §9).
      autoloadsWithFirstScene: options.entryScene !== null,
    });
    if (options.reportShaderVariants) engine._setVariantReport(true);
    if (options.entryScene !== null) await fillEmptyWorlds(engine, options.entryScene);
    // A default World the entry scene didn't fill (a code bootstrap's own nodes): its autoloads now.
    for (const handle of engine.worlds()) {
      const world = engine._world(handle.name);
      if (world?._autoloadsPending) World._runIn(world, () => SceneManager.loadAutoloads(world));
    }
  } catch (err) {
    dispose();
    throw err;
  }
  return { engine, dispose };
}

/** Load `scene` into every start-up World whose config names no scenes (`scenes` absent, not `[]`) and that holds no nodes. */
async function fillEmptyWorlds(engine: Engine, scene: string): Promise<void> {
  for (const handle of engine.worlds()) {
    if (engine._worldConfig(handle.name)?.scenes !== undefined) continue;
    const world = engine._world(handle.name);
    if (!world || world.sceneNodes.length > 0) continue;
    await handle.loadScene(scene);
  }
}
