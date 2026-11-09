import { Input } from "../input/Input";
import type { StorageBackend } from "../platform/Storage";
import { createRenderSurface } from "../render/createRenderSurface";
import type { AssetSource } from "../scene/Assets";
import { SceneManager } from "../scene/SceneManager";
import { BootstrapError, bootstrapLinks, resolveBootstrap, templateConfig, type ResolveBootstrapOptions } from "./bootstrap";
import { resolveSettings, validateBootstrap, type ProjectSettings, type ProjectSettingsInput } from "./settings";
import { Graphics } from "../render/Graphics";
import type { FrameMonitor } from "../render/qualityDetect";
import { LinkApplier } from "./linkApplier";
import { bootProject } from "./projectBoot";
import { ViewAllocator } from "./viewAllocator";
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
   * Graphics quality (ADR 0050, 0055): `"player"` (default) activates the player's saved tier, or
   * detects one when the project allows it; `"keep"` leaves the active tier alone (the editor's
   * Play mode, so its previewed tier stays).
   */
  quality?: "player" | "keep";
  /**
   * Which Worlds to create (ADR 0032): a declarative config or a code bootstrap. Default: the
   * project's `bootstrap` setting, else the default bootstrap (one World).
   */
  bootstrap?: BootstrapSetting | Bootstrap;
  /**
   * Imports a code bootstrap's script (`"bootstrap": "scripts/Bootstrap.ts"`) and returns its
   * `bootstrap` export. The editor passes its script loader (ADR 0030); games import the function
   * and pass it as `bootstrap` instead.
   */
  loadScript?: ResolveBootstrapOptions["loadScript"];
}

/** @internal Editor: one World's place in the Engine's views and input, from `Engine._viewStates`. */
export interface WorldViewState {
  readonly name: string;
  /** It wants to render (`WorldConfig.renders`, or the default for its tags). */
  readonly renders: boolean;
  /** It has the Engine's main view (ADR 0034). */
  readonly mainView: boolean;
  /** It draws to a surface of its own besides the main view (`Engine._attachView`). */
  readonly extraView: boolean;
  /**
   * It handed the main view to another World (`Engine._handView`, a lobby's match World): its
   * surface is kept, hidden, until the view comes back. It's on no screen meanwhile.
   */
  readonly viewHanded: boolean;
  /** Local input reaches it. */
  readonly takesInput: boolean;
  readonly paused: boolean;
}

/**
 * @internal Editor: the Engine's timings while play mode's Stats show (`_setTiming`), in milliseconds.
 * `frame`: the frame's real delta time and how long the whole step took; `world`: one World's
 * fixed steps (with start()), update and lateUpdate (with transform propagation), and render sync and render.
 */
export interface EngineTiming {
  frame(dtMs: number, stepMs: number): void;
  world(name: string, fixedMs: number, updateMs: number, renderMs: number): void;
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
  /** Which surface and which input target each World has (ADR 0034, 0068, 0159). */
  private readonly views: ViewAllocator;
  /** Each World's config as it was created (for editor tools). */
  private readonly configs = new Map<World, WorldConfig>();
  /** Scene loads of the start-up Worlds, which `Engine.create` waits for; null once it's done. */
  private starting: Promise<void>[] | null = [];
  /** The declarative bootstrap's links (ADR 0033, 0062). */
  private readonly links = new LinkApplier({ find: (name) => this._world(name), alive: (world) => this.handles.has(world) });
  private rafId = 0;
  /** Automatic quality (ADR 0055): watches the first seconds of play and steps the tier down if they're slow. */
  private qualityMonitor: FrameMonitor | null = null;
  private monitorFrames = 0;
  private lastTime = 0;
  private running = false;
  /** @internal Editor: gets timings while set (play mode's Stats); null costs one check per phase. */
  private timing: EngineTiming | null = null;

  private constructor(private readonly options: EngineOptions) {
    this.settings = resolveSettings(options.project ?? {});
    this.views = new ViewAllocator({
      container: options.headless ? null : (options.container ?? null),
      createSurface: (element, world) => createRenderSurface(element, world.settings, world.kind),
      input: Input,
    });
  }

  /** @internal Set by the public `myco` module (ADR 0135): turns on the first-party plugins when no host (player, server, editor) has activated any. */
  static _defaultPlugins: (() => void) | null = null;

  static async create(options: EngineOptions = {}): Promise<Engine> {
    Engine._defaultPlugins?.();
    const engine = new Engine(options);
    const kind = options.kind ?? "runtime";
    engine.qualityMonitor = await bootProject(engine.settings, {
      project: options.project,
      assets: options.assets,
      storage: options.storage,
      draws: !options.headless && !!options.container,
      kind,
      quality: options.quality ?? "player",
    });

    // The editor's Engine holds just the Editor World unless it's told otherwise (ADR 0022).
    const ownWorld = kind !== "runtime" && options.bootstrap === undefined;
    const setting = options.bootstrap ?? engine.settings.bootstrap;
    const bootstrap: Bootstrap = ownWorld ? (e) => void e.createWorld(KIND_WORLDS[kind]) : await resolveBootstrap(setting, { loadScript: options.loadScript });
    try {
      await bootstrap(engine);
      const starting = engine.starting!;
      engine.starting = null;
      if (!engine.defaultWorld) throw new Error("The bootstrap created no Worlds.");
      // A declarative bootstrap's links (ADR 0033, 0062): each `from` World connects to its `to`
      // World once both exist. Links naming a Spawnable World (a template) apply when it's created.
      await engine.links.startUp(ownWorld ? [] : bootstrapLinks(setting));
      await Promise.all(starting);
    } catch (err) {
      engine.dispose(); // no half-made Engine left holding a canvas and input listeners
      throw err;
    }
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
    // Check everything before anything changes, so a bad config leaves the Engine as it was.
    const problems = validateBootstrap({ worlds: [c] }, listSystemCatalog()).map((p) => p.replace(/^bootstrap\.worlds\[0\]/, "World config"));
    if (this.list.some((w) => w.name === c.name)) problems.push(`There's already a World named "${c.name}" in this Engine.`);
    if (problems.length > 0) throw new BootstrapError(`Can't create the World "${c.name}"`, problems);

    const tags = c.tags ?? DEFAULT_WORLD_TAGS;
    const kind: WorldKind = tags.includes("editor") ? "editor" : tags.includes("server") ? "server" : "runtime";
    const world = new World(kind, this.options.project ?? {}, { name: c.name, tags });
    world._engine = this;
    if (c.tickRate !== undefined) world.time.fixedDeltaTime = 1 / c.tickRate;
    if (c.timeScale !== undefined) world.time.timeScale = c.timeScale;

    // Tags decide the rest of its systems, and keep deciding as the catalog changes (ADR 0032):
    // only the World's own choices are recorded.
    for (const name of c.systems?.include ?? []) world.addSystem(name);
    for (const name of c.systems?.exclude ?? []) world.removeSystem(name);

    this.configs.set(world, c);

    const handle = new WorldHandleImpl(world, this);
    this.handles.set(world, handle);
    this.list.push(world);
    const first = !this.defaultWorld;
    if (first) this.defaultWorld = world;
    // A server World doesn't want the view unless it asks; any other World does unless it says no.
    this.views.add(world, { renders: c.renders ?? !tags.includes("server"), input: c.input });

    // Autoloads are game-wide nodes (a GameManager, say): they go in the default World only.
    if (first) World._runIn(world, () => SceneManager.loadAutoloads(world));
    let loading = Promise.resolve();
    (c.scenes ?? []).forEach((path, i) => {
      loading = loading.then(() => (handle.alive ? handle.loadScene(path, { additive: i > 0 }) : undefined));
    });
    if (this.starting) this.starting.push(loading);
    else loading.catch((err) => console.error(`[myco] World "${c.name}" couldn't load its scenes:`, err));
    // Links this World completes (ADR 0062); the start-up Worlds' are applied by `Engine.create`, once they all exist.
    if (!this.starting) this.links.worldCreated(world);
    return handle;
  }

  /**
   * @internal The server World a link connected `client` to, while that connection lasts or is
   * still being made (`WorldHandle.connect` skips connecting them again).
   */
  _linkedServer(client: World): World | null {
    return this.links.linkedServer(client);
  }

  /** A handle on one of this Engine's Worlds, by name, or null. */
  findWorld(name: string): WorldHandle | null {
    const world = this.list.find((w) => w.name === name);
    return world ? this.handles.get(world)! : null;
  }

  /** @internal The handle on one of this Engine's Worlds, or null (`Component.world`, ADR 0132). */
  _handleOf(world: World): WorldHandle | null {
    return this.handles.get(world) ?? null;
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
    this.views.retire(world);
    world.atFrameEnd(() => this.tearDown(world));
    if (World.active === world && !world.inFrame) World.active = this.defaultWorld;
  }

  private tearDown(world: World): void {
    world._destroyAll(); // releases its objects from the render surface (`atFrameEnd` runs this with the World current)
    this.configs.delete(world);
    this.views.release(world);
  }

  /** @internal Editor: the live World named `name`, or null. For editor tools; game code goes through handles. */
  _world(name: string): World | null {
    return this.list.find((w) => w.name === name) ?? null;
  }

  /** @internal Editor: the config the live World named `name` was created from, or null. */
  _worldConfig(name: string): Readonly<WorldConfig> | null {
    const world = this._world(name);
    return world ? (this.configs.get(world) ?? null) : null;
  }

  /** @internal Editor: every World's view and input state, in creation order. */
  _viewStates(): WorldViewState[] {
    return this.list.map((w) => ({ name: w.name, ...this.views.state(w), takesInput: w._takesInput, paused: w._paused }));
  }

  /**
   * @internal Give the main view, and local input with it, to the World named `name` (a lobby's
   * match World over the paused menu, ADR 0068), as if it had always had it: its own surface in
   * the Engine's container, laid out as the main canvas was. The World that had the view keeps its
   * surface, hidden, and isn't drawn meanwhile. Returns a function that hands the view back (a
   * no-op once done); it also comes back when the World given it is destroyed. If the World that
   * had it is destroyed meanwhile, the World given the view keeps it. Hand-overs nest: handing
   * back an outer one hands back the ones over it too.
   */
  _handView(name: string): () => void {
    return this.views.handView(this.requireWorld(name));
  }

  /**
   * @internal Editor: draw the World named `name` to a surface of its own in `element` (a tile of
   * the tiled game view), synced and rendered in that World's frame. Returns a function that
   * removes the surface; it also goes when the World is destroyed, takes the main view, or the
   * Engine is disposed. The main view (ADR 0034) stays as it is: its World can't have a second.
   */
  _attachView(name: string, element: HTMLElement): () => void {
    return this.views.attachView(this.requireWorld(name), element);
  }

  /**
   * @internal Editor: give local input to the World named `name` and take it from the others,
   * except Worlds whose config sets `input` (ADR 0034). Null gives it back to the main view's World.
   */
  _focusInput(name: string | null): void {
    this.views.focusInput(name === null ? null : this.requireWorld(name));
  }

  private requireWorld(name: string): World {
    const world = this._world(name);
    if (!world) throw new Error(`There's no World named "${name}" in this Engine.`);
    return world;
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

  /** Feed the quality monitor (ADR 0055), from the 30th frame on so start-up and the first load are past. */
  private watchQuality(dt: number): void {
    const monitor = this.qualityMonitor;
    if (!monitor || ++this.monitorFrames < 30) return;
    if (!Graphics.autoDetected) {
      this.qualityMonitor = null; // the player chose a tier meanwhile
      return;
    }
    const verdict = monitor.frame(dt);
    if (verdict === "done") this.qualityMonitor = null;
    else if (verdict === "stepDown") {
      const tiers = Graphics.tiers;
      const i = tiers.indexOf(Graphics.quality);
      if (i > 0) {
        Graphics._applyDetected(tiers[i - 1]);
        console.info(`[myco] graphics quality stepped down to "${tiers[i - 1]}" to keep the frame rate up.`);
      }
      monitor.steppedDown();
      monitor.setAtLowest(i - 1 <= 0);
    }
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
    const timing = this.timing;
    const begun = timing ? performance.now() : 0;
    this.watchQuality(dt);
    this.links.retryDeferred();
    // 2. Input snapshot: once per Engine frame, shared by the Worlds that take input
    Input.beginFrame();
    for (const world of [...this.list]) {
      if (world._paused || !this.handles.has(world)) continue; // paused, or destroyed earlier this frame
      this.stepWorld(world, dt);
    }
    if (this.defaultWorld) World.active = this.defaultWorld;
    timing?.frame(dt * 1000, performance.now() - begun);
  }

  /** @internal Editor play mode (ADR 0080): every surface, now and later, logs shader variants compiled after loading. */
  _setVariantReport(on: boolean): void {
    this.views.setVariantReport(on);
  }

  /** @internal Editor: report frame and per-World phase timings to `timing` from now on (null stops). */
  _setTiming(timing: EngineTiming | null): void {
    this.timing = timing;
  }

  /**
   * @internal Editor: advance only the World named `name` one frame by `dt` (play mode's per-World
   * Step), paused or not. Input isn't snapshotted again, so keys pressed meanwhile show next frame.
   */
  _stepWorld(name: string, dt: number): void {
    this.stepWorld(this.requireWorld(name), dt);
    if (this.defaultWorld) World.active = this.defaultWorld;
  }

  /**
   * @internal Editor: draw every World's view again without stepping (after an edit while the
   * game is paused): transforms are propagated, then each surface is synced and rendered.
   */
  _redraw(): void {
    for (const world of this.list) {
      const surface = this.views.surfaceOf(world);
      if (surface) world.redraw(surface);
    }
    if (this.defaultWorld) World.active = this.defaultWorld;
  }

  /** One World's frame (ADR 0011, 0160): to the surface it has, reporting timings while play mode's Stats show. */
  private stepWorld(world: World, dt: number): void {
    const timing = this.timing;
    world.step(dt, {
      surface: this.views.surfaceOf(world),
      timings: timing ? (fixedMs, updateMs, renderMs) => timing.world(world.name, fixedMs, updateMs, renderMs) : undefined,
    });
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
    this.configs.clear();
    this.views.dispose();
    if (World.active && worlds.includes(World.active)) World.active = null;
  }
}

/** The one World an editor or server Engine gets when it's given no bootstrap. */
const KIND_WORLDS: Record<Exclude<WorldKind, "runtime">, WorldConfig> = {
  editor: { name: "Editor", tags: ["editor"] },
  server: { name: "Server", tags: ["server"] },
};
