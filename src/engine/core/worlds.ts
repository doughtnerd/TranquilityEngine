/**
 * Worlds, World handles and bootstraps (ADR 0032): the contract wave 1 builds against.
 *
 * An Engine holds several isolated Worlds. Each World has a name, tags, its own clock and its own
 * systems. Bootstraps decide which Worlds exist at start: the default one, a declarative one from
 * `project.json`, or a project script. Game code creates and finds Worlds at runtime through
 * handles, which control a World's lifetime but never expose its nodes.
 */

/** A World tag. The presets are below; projects can add their own (`"ai"`, `"replay"`). */
export type WorldTag = "default" | "client" | "server" | "local" | "editor" | (string & {});

/** Tags a World gets when its config names none. */
export const DEFAULT_WORLD_TAGS: readonly WorldTag[] = ["default", "local"];

/** The `worlds` filter a system or component gets when it declares none. */
export const DEFAULT_SYSTEM_WORLDS: readonly WorldTag[] = ["default", "local"];

/** The name of the World the default bootstrap creates. */
export const DEFAULT_WORLD_NAME = "Default";

/** Systems to add to or leave out of a World by name, on top of those its tags select. */
export interface SystemSelection {
  /** Catalog systems added even though their `worlds` filter doesn't match the World's tags. */
  include?: readonly string[];
  /** Catalog systems left out even though their filter matches. */
  exclude?: readonly string[];
}

/**
 * One World, as a declarative bootstrap lists it in `project.json` or as `Engine.createWorld`
 * takes it at runtime.
 */
export interface WorldConfig {
  /** Unique within the Engine. */
  name: string;
  /** Default: `DEFAULT_WORLD_TAGS`. */
  tags?: readonly WorldTag[];
  /** Fixed steps per second. Default: `1 / project.time.fixedDeltaTime` (60). */
  tickRate?: number;
  /** Starting time scale. Default 1. */
  timeScale?: number;
  /**
   * Whether the World draws to a surface. Default: true for the first World of an Engine that
   * has a container, false otherwise.
   */
  renders?: boolean;
  /** Whether the World receives local input. Default: the same as `renders`. */
  input?: boolean;
  /** Scenes loaded when the World starts, in order (the first replaces, the rest are additive). */
  scenes?: readonly string[];
  systems?: SystemSelection;
}

/** A transport link between two Worlds (ADR 0033). */
export interface LinkConfig {
  /** The client side: the World that connects. */
  from: string;
  /** The server side: the World that listens. */
  to: string;
  /** A registered transport name: `"loopback"`, `"websocket"`, … */
  transport: string;
  /** Transport-specific settings (an address; simulated latency for loopback). */
  options?: Record<string, unknown>;
}

/** The declarative bootstrap: `project.json`'s `bootstrap` section when it's an object. */
export interface BootstrapConfig {
  /** Worlds created at start, in order. The first is the Engine's default World (`engine.world`). */
  worlds: readonly WorldConfig[];
  links?: readonly LinkConfig[];
  /** Named World configs to create later: `Engine.createWorld("Match")` or `createWorld({ ...templates.Match, name })`. */
  templates?: Readonly<Record<string, Omit<WorldConfig, "name"> & { name?: string }>>;
}

/**
 * A code bootstrap (Unity's `ICustomBootstrap`): a project script's `bootstrap` export. It
 * creates the Engine's start-up Worlds with `engine.createWorld`.
 */
export type Bootstrap = (engine: BootstrapEngine) => void | Promise<void>;

/** What a code bootstrap can do with the Engine. */
export interface BootstrapEngine {
  createWorld(config: WorldConfig | string): WorldHandle;
  findWorld(name: string): WorldHandle | null;
  readonly settings: import("./settings").ProjectSettings;
}

/**
 * `project.json`'s `bootstrap`: a declarative config, or the path of a project script exporting
 * `bootstrap(engine)`. Omitted means the default bootstrap.
 */
export type BootstrapSetting = BootstrapConfig | string;

/**
 * A handle on a World: the only cross-World API. It controls the World's lifetime and setup but
 * never exposes its nodes, so Worlds stay isolated (ADR 0032).
 */
export interface WorldHandle {
  readonly name: string;
  readonly tags: readonly WorldTag[];
  /** False once destroyed. Methods on a destroyed handle throw. */
  readonly alive: boolean;
  readonly paused: boolean;
  hasTag(tag: WorldTag): boolean;
  /** Load a scene into the World (at the end of its next frame if it's mid-frame). */
  loadScene(path: string, options?: { additive?: boolean }): Promise<void>;
  /** Add a catalog system by name. Throws for unknown names. */
  addSystem(name: string): void;
  removeSystem(name: string): void;
  /** The World's systems by name, in execution order per phase. */
  systems(): readonly string[];
  /** Join this World (client side) to `server` over a transport (ADR 0033, wave 3). */
  connect(server: WorldHandle, transport: string, options?: Record<string, unknown>): void;
  pause(): void;
  resume(): void;
  /** Destroy the World and everything in it. */
  destroy(): void;
}

/** True if a `worlds` filter (a system's or component's) admits a World with `tags`. */
export function worldsMatch(filter: readonly WorldTag[] | undefined, tags: readonly WorldTag[]): boolean {
  return (filter ?? DEFAULT_SYSTEM_WORLDS).some((t) => tags.includes(t));
}

/** @internal Thrown by contract stubs until their task lands (see docs/architecture/worlds-and-netcode-plan.md). */
export function notYet(task: string, what: string): never {
  throw new Error(`${what} isn't implemented yet (${task} in docs/architecture/worlds-and-netcode-plan.md).`);
}
