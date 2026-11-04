import { Input } from "../input/Input";
import { MemoryStorage, Storage, type StorageBackend } from "../platform/Storage";
import { BrowserStorage } from "../platform/BrowserStorage";
import { getFileSystem, isTauri } from "../platform/FileSystem";
import { TauriStorage } from "../platform/TauriStorage";
import { RenderBackend } from "../render/RenderBackend";
import { Assets, type AssetSource } from "../scene/Assets";
import { SceneManager } from "../scene/SceneManager";
import { connectWorlds, netSession } from "../net/session";
import { BootstrapError, bootstrapLinks, resolveBootstrap, templateConfig, type ResolveBootstrapOptions } from "./bootstrap";
import { resolveSettings, validateBootstrap, type ProjectSettings, type ProjectSettingsInput } from "./settings";
import { parseGraphics } from "./graphics";
import { AUTO_QUALITY_KEY, Graphics, QUALITY_KEY } from "../render/Graphics";
import { FrameMonitor } from "../render/qualityDetect";
import { listSystemCatalog } from "./systems";
import { World, type WorldKind } from "./World";
import { WorldHandleImpl } from "./WorldHandle";
import { DEFAULT_WORLD_TAGS, type Bootstrap, type BootstrapEngine, type BootstrapSetting, type LinkConfig, type WorldConfig, type WorldHandle } from "./worlds";

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
  /** Local input reaches it. */
  readonly takesInput: boolean;
  readonly paused: boolean;
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
  /**
   * The World that has the view (the canvas, when there's a container) and, unless its config
   * says otherwise, local input. When it's destroyed, the view passes to the next World that
   * wants it (ADR 0032, 0034).
   */
  private viewWorld: World | null = null;
  /** Per World: whether it wants the view, and its `input` setting (undefined: input follows the view). */
  private readonly viewWishes = new Map<World, { renders: boolean; input: boolean | undefined }>();
  /** Each World's config as it was created (for editor tools). */
  private readonly configs = new Map<World, WorldConfig>();
  /**
   * Editor: Worlds drawn to a surface of their own besides the main view (tiled play mode), each
   * by its own backend, since a backend draws exactly one World (ADR 0032).
   */
  private readonly extraViews = new Map<World, RenderBackend>();
  /** Editor: the World `_focusInput` gave local input to; null: input follows the main view. */
  private inputWorld: World | null = null;
  /** The canvas Input listens to: the input World's, when it has one. */
  private inputCanvas: HTMLCanvasElement | null = null;
  /** Scene loads of the start-up Worlds, which `Engine.create` waits for; null once it's done. */
  private starting: Promise<void>[] | null = [];
  /** The declarative bootstrap's links (ADR 0033, 0062), set once the start-up Worlds exist. */
  private links: readonly LinkConfig[] = [];
  /**
   * The connection a link made for each client World: its server, and the client's server peer
   * once connected (`pending` while the server is still starting to listen).
   */
  private readonly linkedServers = new WeakMap<World, { server: World; peer: unknown; pending: boolean }>();
  /** Links waiting for a client's old connection to close (its server was destroyed and created again in one frame). */
  private deferredLinks: LinkConfig[] = [];
  private rafId = 0;
  /** Automatic quality (ADR 0055): watches the first seconds of play and steps the tier down if they're slow. */
  private qualityMonitor: FrameMonitor | null = null;
  private monitorFrames = 0;
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
    // Graphics quality (ADR 0050): the project's tiers, and the player's saved choice; with
    // `autoDetect`, a detected tier until the player picks one (ADR 0055).
    for (const p of parseGraphics(options.project?.graphics).problems) console.warn(`[myco] project.json ${p}`);
    if ((options.quality ?? "player") === "player") {
      const graphics = engine.settings.graphics;
      const saved = await Storage.load(QUALITY_KEY, "settings").catch(() => undefined);
      const auto = graphics.autoDetect ? await Storage.load(AUTO_QUALITY_KEY, "settings").catch(() => undefined) : undefined;
      Graphics._configure(graphics, saved, auto);
      const detect = graphics.autoDetect && !!engine.container && (options.kind ?? "runtime") === "runtime" && (saved === undefined || Graphics.autoDetected);
      if (detect) {
        if (!Graphics.autoDetected) Graphics._applyDetected(Graphics.detectQuality());
        engine.qualityMonitor = new FrameMonitor({ targetFps: graphics.targetFrameRate });
        engine.qualityMonitor.setAtLowest(Graphics.tiers.indexOf(Graphics.quality) <= 0);
      }
    }

    // The editor's Engine holds just the Editor World unless it's told otherwise (ADR 0022).
    const kind = options.kind ?? "runtime";
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
      engine.links = ownWorld ? [] : bootstrapLinks(setting);
      for (const link of engine.links) {
        const client = engine._world(link.from);
        const server = engine._world(link.to);
        // Skipped if a script created a Spawnable World while an earlier link waited, and that applied it.
        if (!client || !server || engine.linkedServers.get(client)?.server === server) continue;
        const record = { server, peer: null as unknown, pending: true };
        engine.linkedServers.set(client, record);
        await connectWorlds(client, server, link.transport, link.options ?? {});
        record.peer = netSession(client)?.serverPeer ?? null;
        record.pending = false;
      }
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

    // A server World doesn't want the view unless it asks; any other World does unless it says no.
    this.viewWishes.set(world, { renders: c.renders ?? !tags.includes("server"), input: c.input });
    this.configs.set(world, c);

    const handle = new WorldHandleImpl(world, this);
    this.handles.set(world, handle);
    this.list.push(world);
    const first = !this.defaultWorld;
    if (first) this.defaultWorld = world;
    this.assignView();

    // Autoloads are game-wide nodes (a GameManager, say): they go in the default World only.
    if (first) World._runIn(world, () => SceneManager.loadAutoloads(world));
    let loading = Promise.resolve();
    (c.scenes ?? []).forEach((path, i) => {
      loading = loading.then(() => (handle.alive ? handle.loadScene(path, { additive: i > 0 }) : undefined));
    });
    if (this.starting) this.starting.push(loading);
    else loading.catch((err) => console.error(`[myco] World "${c.name}" couldn't load its scenes:`, err));
    this.applyLinks(world);
    return handle;
  }

  /**
   * Links that `world` completes (ADR 0062): for each link naming it whose other World is alive,
   * the client connects to the server, as if the script had called `connect` right after creating
   * it. Start-up Worlds' links are applied by `Engine.create`, once they all exist.
   */
  private applyLinks(world: World): void {
    if (this.starting) return;
    for (const link of this.links) {
      if ((link.from === world.name || link.to === world.name) && !this.applyLink(link)) this.deferredLinks.push(link);
    }
  }

  /**
   * Connect one link's client to its server if both are alive and it isn't already. False to try
   * again next frame: the client still holds its connection to a server World that was destroyed
   * (a match restarted with `destroy()` then `createWorld()` in one frame), which closes during
   * its next step.
   */
  private applyLink(link: LinkConfig): boolean {
    const client = this._world(link.from);
    const server = this._world(link.to);
    if (!client || !server) return true;
    const existing = this.linkedServers.get(client);
    if (existing?.server === server) return true;
    if (netSession(client)?.serverPeer) {
      if (existing && !this.handles.has(existing.server)) return false;
      console.warn(`[myco] Link ${link.from} → ${link.to} not applied: World "${link.from}" is already connected to another server.`);
      return true;
    }
    const record = { server, peer: null as unknown, pending: true };
    try {
      const connected = connectWorlds(client, server, link.transport, link.options ?? {});
      this.linkedServers.set(client, record);
      const settle = () => {
        record.peer = netSession(client)?.serverPeer ?? null;
        record.pending = false;
      };
      settle();
      record.pending = record.peer === null; // still listening (WebSocket): the peer comes later
      connected.then(settle, (err) => {
        if (this.linkedServers.get(client) === record) this.linkedServers.delete(client);
        console.error(`[myco] Link ${link.from} → ${link.to} over "${link.transport}" failed:`, err);
      });
    } catch (err) {
      console.warn(`[myco] Link ${link.from} → ${link.to} not applied: ${(err as Error).message}`);
    }
    return true;
  }

  /**
   * @internal The server World a link connected `client` to, while that connection lasts or is
   * still being made (`WorldHandle.connect` skips connecting them again).
   */
  _linkedServer(client: World): World | null {
    const record = this.linkedServers.get(client);
    if (!record || !this.handles.has(record.server)) return null;
    if (record.pending) return record.server;
    const peer = netSession(client)?.serverPeer;
    return peer && peer === record.peer ? record.server : null;
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
    World._runIn(world, () => world._destroyAll()); // releases its objects from the render surface
    this.viewWishes.delete(world);
    this.configs.delete(world);
    this.extraViews.get(world)?.dispose();
    this.extraViews.delete(world);
    if (world === this.inputWorld) this.inputWorld = null;
    if (world === this.viewWorld) {
      world.render = null;
      this.render?.releaseWorld();
      this.viewWorld = null;
    }
    this.assignView();
  }

  /**
   * Give the view to the first World that wants it, if no World has it (ADR 0034): the canvas and
   * render surface when there's a container, and local input unless the World's config sets
   * `input`. Called when a World is created and when one is destroyed, so a menu World that
   * creates a match World and destroys itself hands the screen over.
   */
  private assignView(): void {
    if (!this.viewWorld || !this.list.includes(this.viewWorld)) {
      const next = this.list.find((w) => this.viewWishes.get(w)?.renders) ?? null;
      this.viewWorld = next;
      if (next && this.container) {
        // A World drawn to a surface of its own (an editor tile) gives it up for the main view.
        this.extraViews.get(next)?.dispose();
        this.extraViews.delete(next);
        this.render ??= new RenderBackend(this.container, next.settings, next.kind);
        next.render = this.render;
      }
    }
    this.applyInput();
  }

  /**
   * Local input goes to one World (ADR 0034): the one `_focusInput` picked, while it lives, else
   * the World with the main view. A World whose config sets `input` keeps that. Input listens to
   * the chosen World's canvas, if it has one.
   */
  private applyInput(): void {
    const target = this.inputWorld ?? this.viewWorld;
    for (const world of this.list) world._takesInput = this.viewWishes.get(world)?.input ?? world === target;
    const canvas = !target ? null : target === this.viewWorld ? this.render?.canvas : this.extraViews.get(target)?.canvas;
    if (canvas && canvas !== this.inputCanvas) {
      // Moving to another canvas keeps what's held: it's the same keyboard and mouse.
      if (this.inputCanvas) Input.retarget(canvas);
      else Input.attach(canvas);
      this.inputCanvas = canvas;
    }
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
    return this.list.map((w) => ({
      name: w.name,
      renders: this.viewWishes.get(w)?.renders ?? false,
      mainView: w === this.viewWorld,
      extraView: this.extraViews.has(w),
      takesInput: w._takesInput,
      paused: w._paused,
    }));
  }

  /**
   * @internal Editor: draw the World named `name` to a surface of its own in `element` (a tile of
   * the tiled game view), synced and rendered in that World's frame. Returns a function that
   * removes the surface; it also goes when the World is destroyed, takes the main view, or the
   * Engine is disposed. The main view (ADR 0034) stays as it is: its World can't have a second.
   */
  _attachView(name: string, element: HTMLElement): () => void {
    const world = this._world(name);
    if (!world) throw new Error(`There's no World named "${name}" in this Engine.`);
    if (world === this.viewWorld) throw new Error(`World "${name}" has the main view already.`);
    if (this.extraViews.has(world)) throw new Error(`World "${name}" has a view already.`);
    const backend = new RenderBackend(element, world.settings, world.kind);
    this.extraViews.set(world, backend);
    world.render = backend;
    this.applyInput(); // if it has input, Input listens to its canvas now
    return () => {
      if (this.extraViews.get(world) !== backend) return; // gone with its World, or replaced
      this.extraViews.delete(world);
      // Its three.js objects live in this backend and go with it; the World runs on without a surface.
      world.render = null;
      backend.dispose();
      if (this.inputCanvas === backend.canvas) this.inputCanvas = null;
      if (this.inputWorld === world) this.inputWorld = null; // no surface to point at: input goes back to the main view
      this.applyInput();
    };
  }

  /**
   * @internal Editor: give local input to the World named `name` and take it from the others,
   * except Worlds whose config sets `input` (ADR 0034). Null gives it back to the main view's World.
   */
  _focusInput(name: string | null): void {
    const world = name === null ? null : this._world(name);
    if (name !== null && !world) throw new Error(`There's no World named "${name}" in this Engine.`);
    this.inputWorld = world;
    this.applyInput();
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
    this.watchQuality(dt);
    if (this.deferredLinks.length) this.deferredLinks = this.deferredLinks.filter((link) => !this.applyLink(link));
    // 2. Input snapshot: once per Engine frame, shared by the Worlds that take input
    Input.beginFrame();
    for (const world of [...this.list]) {
      if (world._paused || !this.handles.has(world)) continue; // paused, or destroyed earlier this frame
      this.stepWorld(world, dt);
    }
    if (this.defaultWorld) World.active = this.defaultWorld;
  }

  /**
   * @internal Editor: advance only the World named `name` one frame by `dt` (play mode's per-World
   * Step), paused or not. Input isn't snapshotted again, so keys pressed meanwhile show next frame.
   */
  _stepWorld(name: string, dt: number): void {
    const world = this._world(name);
    if (!world) throw new Error(`There's no World named "${name}" in this Engine.`);
    this.stepWorld(world, dt);
    if (this.defaultWorld) World.active = this.defaultWorld;
  }

  /**
   * @internal Editor: draw every World's view again without stepping (after an edit while the
   * game is paused): transforms are propagated, then each surface is synced and rendered.
   */
  _redraw(): void {
    for (const world of this.list) {
      const surface = world === this.viewWorld ? this.render : this.extraViews.get(world);
      if (!surface) continue;
      World._runIn(world, () => {
        world._propagateTransforms();
        surface.sync(world);
        surface.render(world);
      });
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

      // 8–9. Render sync and render: to the main view, or to the World's own surface (editor tiles)
      const surface = world === this.viewWorld ? this.render : this.extraViews.get(world);
      if (surface) {
        surface.sync(world);
        surface.render(world);
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
    this.viewWishes.clear();
    this.configs.clear();
    for (const backend of this.extraViews.values()) backend.dispose();
    this.extraViews.clear();
    this.render?.dispose();
    this.render = null;
    this.viewWorld = null;
    this.inputWorld = null;
    this.inputCanvas = null;
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
