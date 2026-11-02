import { Input } from "../input/Input";
import { MemoryStorage, Storage, type StorageBackend } from "../platform/Storage";
import { BrowserStorage } from "../platform/BrowserStorage";
import { getFileSystem, isTauri } from "../platform/FileSystem";
import { TauriStorage } from "../platform/TauriStorage";
import { RenderBackend } from "../render/RenderBackend";
import { Assets, type AssetSource } from "../scene/Assets";
import { SceneManager } from "../scene/SceneManager";
import { resolveBootstrap, selectSystems, templateConfig } from "./bootstrap";
import { resolveSettings, type ProjectSettings, type ProjectSettingsInput } from "./settings";
import { listSystemCatalog } from "./systems";
import { World, type WorldKind } from "./World";
import { WorldHandleImpl } from "./WorldHandle";
import { DEFAULT_WORLD_TAGS, type Bootstrap, type BootstrapEngine, type BootstrapSetting, type WorldConfig, type WorldHandle } from "./worlds";

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
  /**
   * "runtime" for games (default); "editor" for the scene editor's Editor World (ADR 0016, 0022).
   * Without a `bootstrap` option, an editor (or server) Engine gets that one World and ignores the
   * project's bootstrap.
   */
  kind?: WorldKind;
  /**
   * Which Worlds to create (ADR 0032): a declarative config or a code bootstrap. Default: the
   * project's `bootstrap` setting, else the default bootstrap (one World).
   */
  bootstrap?: BootstrapSetting | Bootstrap;
}

/**
 * Owns the Worlds and drives them frame by frame (ADR 0011, 0032). A bootstrap creates the
 * start-up Worlds; game code creates more at runtime through handles. `engine.world` is the
 * default World: the first one the bootstrap made.
 *
 * ```ts
 * const engine = await Engine.create({ container, project, assets });
 * await SceneManager.load("scenes/main.scene.json");
 * engine.start();
 * ```
 */
export class Engine implements BootstrapEngine {
  readonly settings: ProjectSettings;
  private defaultWorld: World | null = null;
  /** Live Worlds, in creation (and step) order. */
  private readonly list: World[] = [];
  private readonly handles = new Map<World, WorldHandleImpl>();
  private readonly container: HTMLElement | null;
  private render: RenderBackend | null = null;
  private renderWorld: World | null = null;
  /** Set once a World has claimed rendering (and, by default, input), container or not. */
  private renderClaimed = false;
  /** Scene loads of the start-up Worlds, which `Engine.create` waits for; null once it's done. */
  private starting: Promise<void>[] | null = [];
  private rafId = 0;
  private lastTime = 0;
  private running = false;

  private constructor(private readonly options: EngineOptions) {
    this.settings = resolveSettings(options.project ?? {});
    this.container = options.headless ? null : (options.container ?? null);
  }

  static async create(options: EngineOptions = {}): Promise<Engine> {
    const engine = new Engine(options);
    for (const source of ([] as AssetSource[]).concat(options.assets ?? [])) Assets.addSource(source);
    Storage.use(options.storage ?? (await defaultStorage(engine.settings.name, !engine.container)));

    // The editor's Engine holds just the Editor World unless it's told otherwise (ADR 0022).
    const kind = options.kind ?? "runtime";
    const bootstrap: Bootstrap =
      kind !== "runtime" && options.bootstrap === undefined
        ? (e) => void e.createWorld(KIND_WORLDS[kind])
        : await resolveBootstrap(options.bootstrap ?? engine.settings.bootstrap);
    await bootstrap(engine);
    const starting = engine.starting!;
    engine.starting = null;
    if (!engine.defaultWorld) throw new Error("The bootstrap created no Worlds.");
    await Promise.all(starting);
    World.active = engine.defaultWorld;
    return engine;
  }

  /** The default World: the first one the bootstrap created (the next one, if that's destroyed). */
  get world(): World {
    if (!this.defaultWorld) throw new Error("This Engine has no Worlds yet.");
    return this.defaultWorld;
  }

  /**
   * Create a World in the Engine that's running the current World (ADR 0032), e.g. from a menu's
   * "Host" button. `config` is a WorldConfig or the name of a bootstrap template.
   */
  static createWorld(config: WorldConfig | string): WorldHandle {
    return Engine.current().createWorld(config);
  }

  /** A handle on a World of the current World's Engine, by name, or null. */
  static findWorld(name: string): WorldHandle | null {
    return Engine.current().findWorld(name);
  }

  private static current(): Engine {
    const engine = World.require()._engine;
    if (!(engine instanceof Engine)) throw new Error("The current World doesn't belong to an Engine.");
    return engine;
  }

  /**
   * Create a World in this Engine. See `Engine.createWorld`. Its scenes load in the background
   * (`Engine.create` waits for the start-up Worlds'), and it steps from the next frame on.
   */
  createWorld(config: WorldConfig | string): WorldHandle {
    const c = this.resolveConfig(config);
    if (this.list.some((w) => w.name === c.name)) throw new Error(`There's already a World named "${c.name}" in this Engine.`);
    if (c.tickRate !== undefined && !(c.tickRate > 0)) throw new Error(`World "${c.name}": tickRate must be a positive number (got ${c.tickRate}).`);

    const tags = c.tags ?? DEFAULT_WORLD_TAGS;
    const kind: WorldKind = tags.includes("editor") ? "editor" : tags.includes("server") ? "server" : "runtime";
    const world = new World(kind, this.options.project ?? {}, { name: c.name, tags });
    world._engine = this;
    if (c.tickRate !== undefined) world.time.fixedDeltaTime = 1 / c.tickRate;
    if (c.timeScale !== undefined) world.time.timeScale = Math.max(0, c.timeScale);

    // One container, so one World renders; later rendering Worlds run headless until views tile (T5).
    const wantsRender = c.renders !== false && !this.renderClaimed;
    if (wantsRender) this.renderClaimed = true;
    world._takesInput = c.input ?? wantsRender;
    if (wantsRender && this.container && !this.render) {
      this.render = new RenderBackend(this.container, world.settings, world.kind);
      this.renderWorld = world;
      world.render = this.render;
      Input.attach(this.render.canvas);
    }

    const catalog = listSystemCatalog();
    const selected = new Set(selectSystems({ ...c, tags }, catalog));
    for (const entry of catalog) {
      if (selected.has(entry.name)) world.addSystem(entry.name);
      else world.removeSystem(entry.name);
    }

    const handle = new WorldHandleImpl(world, this);
    this.handles.set(world, handle);
    this.list.push(world);
    const first = !this.defaultWorld;
    if (first) this.defaultWorld = world;

    // Autoloads are game-wide nodes (a GameManager, say): they go in the default World only.
    if (first) World._runIn(world, () => SceneManager.loadAutoloads(world));
    let loading = Promise.resolve();
    (c.scenes ?? []).forEach((path, i) => {
      loading = loading.then(() => (handle.alive ? handle.loadScene(path, { additive: i > 0 }) : undefined));
    });
    if (this.starting) this.starting.push(loading);
    else loading.catch((err) => console.error(`[tranquility] World "${c.name}" couldn't load its scenes:`, err));
    return handle;
  }

  /** A handle on one of this Engine's Worlds, by name, or null. */
  findWorld(name: string): WorldHandle | null {
    const world = this.list.find((w) => w.name === name);
    return world ? this.handles.get(world)! : null;
  }

  /** Handles on every World, in creation (and step) order. For the editor and bootstraps, not game scripts. */
  worlds(): readonly WorldHandle[] {
    return this.list.map((w) => this.handles.get(w)!);
  }

  /**
   * A WorldConfig as given, or a bootstrap template by name (validated): from the declarative
   * bootstrap passed to `Engine.create`, else from `project.json`'s.
   */
  private resolveConfig(config: WorldConfig | string): WorldConfig {
    if (typeof config !== "string") return config;
    const declared = typeof this.options.bootstrap === "object" ? this.options.bootstrap : this.settings.bootstrap;
    return templateConfig(declared, config);
  }

  /**
   * @internal Destroy a World and everything in it (`WorldHandle.destroy`). Mid-frame, it stops
   * stepping now and is torn down at the end of its frame. Destroying the default World makes
   * the next one the default; the last World can't be destroyed (dispose the Engine instead).
   */
  _destroyWorld(world: World): void {
    const handle = this.handles.get(world);
    const index = this.list.indexOf(world);
    if (!handle || index < 0) return;
    if (this.list.length === 1) throw new Error(`Can't destroy World "${world.name}": it's the Engine's last World. Dispose the Engine instead.`);
    handle._alive = false;
    this.list.splice(index, 1);
    this.handles.delete(world);
    if (this.defaultWorld === world) this.defaultWorld = this.list[0];
    if (world._inFrame) world._sceneOps.push(() => this.tearDown(world));
    else this.tearDown(world);
    if (World.active === world && !world._inFrame) World.active = this.defaultWorld;
  }

  private tearDown(world: World): void {
    World._runIn(world, () => world._destroyAll());
    if (world === this.renderWorld) {
      this.render?.dispose();
      this.render = null;
      this.renderWorld = null;
      Input.detach();
    }
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
   * As in Unity's player loop, every unpaused World steps once, in creation order, each on its
   * own clock (ADR 0032). Afterwards the default World is current again.
   */
  step(dt: number): void {
    // 2. Input snapshot: once per Engine frame, shared by the Worlds that take input
    Input.beginFrame();
    for (const world of [...this.list]) {
      if (world._paused || !this.handles.has(world)) continue; // paused, or destroyed earlier this frame
      this.stepWorld(world, dt);
    }
    if (this.defaultWorld) World.active = this.defaultWorld;
  }

  /** One World's frame, with it as the current World. Order follows ADR 0011. */
  private stepWorld(world: World, dt: number): void {
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

      // 3. start() for newly enabled behaviors
      world._runPendingStarts();

      // 4. Fixed steps, at this World's own rate
      const fdt = time.fixedDeltaTime;
      if (time.timeScale > 0) {
        world._accumulator += time.deltaTime;
        let steps = 0;
        while (world._accumulator >= fdt && steps < settings.maxSubSteps) {
          time.fixedStepCount++;
          time.fixedTime += fdt;
          world._resolveWaits("fixed");
          world.scheduler.run("fixedUpdate", fdt);
          world._accumulator -= fdt;
          steps++;
        }
        if (steps === settings.maxSubSteps) world._accumulator = Math.min(world._accumulator, fdt);
      }
      time.fixedAlpha = fdt > 0 ? world._accumulator / fdt : 0;

      // 5–6. update and lateUpdate
      world._resolveWaits("update");
      world.scheduler.run("update", time.deltaTime);
      world.scheduler.run("lateUpdate", time.deltaTime);

      // 7. Transform propagation
      world._propagateTransforms();

      // 8–9. Render sync and render
      if (this.render && world === this.renderWorld) {
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

  /** Stop the loop, destroy every World's nodes (scripts get onDestroy, audio stops) and release GPU resources. */
  dispose(): void {
    this.stop();
    const worlds = this.list.splice(0);
    for (const world of worlds) {
      this.handles.get(world)!._alive = false;
      World.active = world;
      world._destroyAll();
    }
    this.handles.clear();
    this.render?.dispose();
    this.render = null;
    this.renderWorld = null;
    Input.detach();
    if (World.active && worlds.includes(World.active)) World.active = null;
  }
}

/** The one World an editor or server Engine gets when it's given no bootstrap. */
const KIND_WORLDS: Record<Exclude<WorldKind, "runtime">, WorldConfig> = {
  editor: { name: "Editor", tags: ["editor"] },
  server: { name: "Server", tags: ["server"] },
};

/** Platform storage (ADR 0024): files in the app data folder under Tauri, IndexedDB in a browser, memory when headless. */
async function defaultStorage(gameName: string, headless: boolean): Promise<StorageBackend> {
  if (headless) return new MemoryStorage();
  if (isTauri()) return TauriStorage.create(await getFileSystem());
  if (typeof indexedDB !== "undefined") return new BrowserStorage(gameName);
  return new MemoryStorage();
}
