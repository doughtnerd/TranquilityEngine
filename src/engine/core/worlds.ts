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
   * Whether the World wants to draw. Default: true unless it's tagged `server`. Of the Worlds that
   * want to, the first gets the Engine's main view (the editor tiles the others, ADR 0034).
   */
  renders?: boolean;
  /** Whether the World receives local input. Default: the World with the main view does. */
  input?: boolean;
  /** Scenes loaded when the World starts, in order (the first replaces, the rest are additive). */
  scenes?: readonly string[];
  systems?: SystemSelection;
  /** Turn on the lobby service in this server World (ADR 0068): see `LobbyOptions` and the multiplayer guide. */
  lobby?: import("../net/lobby/protocol").LobbyOptions;
}

/** A transport link between two Worlds (ADR 0033). */
export interface LinkConfig {
  /** The client side: the World that connects. */
  from: string;
  /** The server side: the World that listens. */
  to: string;
  /** A registered transport name: `"loopback"`, `"websocket"`, … */
  transport: string;
  /**
   * Settings for the link and its transport: `address` (where the server listens; loopback makes
   * one up per Engine and server World), `port` (WebSocket servers, Node only), `url` (where a
   * WebSocket client connects), `interpolationMs` (the client's interpolation buffer, default 100),
   * `commandSlack` (ticks a client's inputs run ahead, default 2), `handshakeTimeoutMs` (5000),
   * `idleTimeoutMs` (15000), `maxConnections` (the server's cap, 64), and transport options such
   * as loopback's `latencyMs`, `jitterMs` and `loss`.
   */
  options?: Record<string, unknown>;
}

/** The declarative bootstrap: `project.json`'s `bootstrap` section when it's an object. */
export interface BootstrapConfig {
  /** Worlds created at start, in order. The first is the Engine's default World (`engine.world`). */
  worlds: readonly WorldConfig[];
  /**
   * Client-to-server links. Each applies once both of its Worlds exist: at start-up, or when game
   * code creates a Spawnable World it names (ADR 0062).
   */
  links?: readonly LinkConfig[];
  /** Spawnable Worlds: named World configs to create later: `Engine.createWorld("Match")` or `createWorld({ ...templates.Match, name })`. */
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
  /**
   * Join this World (client side) to `server` over a transport (ADR 0033): a World of this page,
   * or the address of a server elsewhere, such as a dedicated server's `"ws://host:7777"` (ADR 0036).
   */
  connect(server: WorldHandle | string, transport: string, options?: Record<string, unknown>): void;
  /**
   * Make this World a server and listen over a transport (ADR 0067). Resolves with the address
   * clients connect to; rejects with a reason. Options: `port`, `host`, `path`, `address`,
   * `maxConnections` and timeouts. Throws if the World is a client.
   */
  listen(transport: string, options?: Record<string, unknown>): Promise<string>;
  /** Where this World listens (ADR 0067). Empty if it doesn't. */
  addresses(): readonly string[];
  pause(): void;
  resume(): void;
  /** Destroy the World and everything in it. */
  destroy(): void;
}

/** True if a `worlds` filter (a system's or component's) admits a World with `tags`. A filter containing `"*"` admits every World. */
export function worldsMatch(filter: readonly WorldTag[] | undefined, tags: readonly WorldTag[]): boolean {
  const f = filter ?? DEFAULT_SYSTEM_WORLDS;
  return f.includes("*") || f.some((t) => tags.includes(t));
}

/** @internal Thrown by contract stubs until their task lands (see docs/architecture/worlds-and-netcode-plan.md). */
export function notYet(task: string, what: string): never {
  throw new Error(`${what} isn't implemented yet (${task} in docs/architecture/worlds-and-netcode-plan.md).`);
}
