import { Input } from "../input/Input";
import { MemoryStorage, Storage, type StorageBackend } from "../platform/Storage";
import { BrowserStorage } from "../platform/BrowserStorage";
import { getFileSystem, isTauri } from "../platform/FileSystem";
import { TauriStorage } from "../platform/TauriStorage";
import { RenderBackend } from "../render/RenderBackend";
import { Assets, type AssetSource } from "../scene/Assets";
import { SceneManager } from "../scene/SceneManager";
import type { ProjectSettingsInput } from "./settings";
import { World, type WorldKind } from "./World";

export interface EngineOptions {
  /** Project settings (usually the game's `project.json`). */
  project?: ProjectSettingsInput;
  /** Asset sources, e.g. `Assets.fromGlob(import.meta.glob("./**\/*.png", { eager: true, import: "default" }))`. */
  assets?: AssetSource | AssetSource[];
  /** Element the canvas is placed in. Omit (or pass `headless: true`) to run without rendering. */
  container?: HTMLElement;
  headless?: boolean;
  /** Storage backend for saves/settings (ADR 0024). Defaults to files under Tauri, IndexedDB in browsers, memory when headless. */
  storage?: StorageBackend;
  /** "runtime" for games (default); "editor" for the scene editor's Editor World (ADR 0016, 0022). */
  kind?: WorldKind;
}

/**
 * Owns a World and drives it frame by frame (ADR 0011).
 *
 * ```ts
 * const engine = await Engine.create({ container, project, assets });
 * await SceneManager.load("scenes/main.scene.json");
 * engine.start();
 * ```
 */
export class Engine {
  readonly world: World;
  private readonly render: RenderBackend | null;
  private accumulator = 0;
  private rafId = 0;
  private lastTime = 0;
  private running = false;

  private constructor(world: World, render: RenderBackend | null) {
    this.world = world;
    this.render = render;
  }

  static async create(options: EngineOptions = {}): Promise<Engine> {
    const world = new World(options.kind ?? "runtime", options.project ?? {});
    World.active = world;

    for (const source of ([] as AssetSource[]).concat(options.assets ?? [])) Assets.addSource(source);

    let render: RenderBackend | null = null;
    const headless = options.headless || !options.container;
    if (!headless) {
      render = new RenderBackend(options.container!, world.settings, world.kind);
      world.render = render;
      Input.attach(render.canvas);
    }

    Storage.use(options.storage ?? (await defaultStorage(world.settings.name, headless)));
    SceneManager.loadAutoloads(world);
    return new Engine(world, render);
  }

  /** True while the requestAnimationFrame loop is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Start the requestAnimationFrame loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      const dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      this.step(dt);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (!this.running) return; // never started (headless, stepped by hand): nothing to cancel
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /**
   * Advance one frame by `dt` real seconds. Used by the loop; call it directly in tests.
   * Order follows ADR 0011.
   */
  step(dt: number): void {
    const world = this.world;
    const time = world.time;
    const settings = world.settings.time;
    World.active = world;
    world._inFrame = true;
    try {
      // 1. Begin frame
      time.realtimeSinceStartup += dt;
      time.unscaledDeltaTime = Math.min(Math.max(dt, 0), settings.maxFrameTime);
      time.deltaTime = time.unscaledDeltaTime * time.timeScale;
      time.time += time.deltaTime;
      time.frameCount++;

      // 2. Input snapshot
      Input.beginFrame();

      // 3. start() for newly enabled behaviors
      world._runPendingStarts();

      // 4. Fixed steps
      const fdt = time.fixedDeltaTime;
      if (time.timeScale > 0) {
        this.accumulator += time.deltaTime;
        let steps = 0;
        while (this.accumulator >= fdt && steps < settings.maxSubSteps) {
          time.fixedStepCount++;
          time.fixedTime += fdt;
          world._resolveWaits("fixed");
          world.scheduler.run("fixedUpdate", fdt);
          this.accumulator -= fdt;
          steps++;
        }
        if (steps === settings.maxSubSteps) this.accumulator = Math.min(this.accumulator, fdt);
      }
      time.fixedAlpha = fdt > 0 ? this.accumulator / fdt : 0;

      // 5–6. update and lateUpdate
      world._resolveWaits("update");
      world.scheduler.run("update", time.deltaTime);
      world.scheduler.run("lateUpdate", time.deltaTime);

      // 7. Transform propagation
      world._propagateTransforms();

      // 8–9. Render sync and render
      if (this.render) {
        this.render.sync(world);
        this.render.render(world);
      }
    } finally {
      // 10. End of frame: deferred destroys, buffers, then scene loads
      world._flushDestroyed();
      world._clearBuffers();
      const ops = world._sceneOps;
      world._sceneOps = [];
      world._inFrame = false;
      for (const op of ops) op();
    }
  }

  /** Stop the loop, destroy the World's nodes (scripts get onDestroy, audio stops) and release GPU resources. */
  dispose(): void {
    this.stop();
    World.active = this.world;
    this.world._destroyAll();
    this.render?.dispose();
    Input.detach();
    if (World.active === this.world) World.active = null;
  }
}

/** Platform storage (ADR 0024): files in the app data folder under Tauri, IndexedDB in a browser, memory when headless. */
async function defaultStorage(gameName: string, headless: boolean): Promise<StorageBackend> {
  if (headless) return new MemoryStorage();
  if (isTauri()) return TauriStorage.create(await getFileSystem());
  if (typeof indexedDB !== "undefined") return new BrowserStorage(gameName);
  return new MemoryStorage();
}
