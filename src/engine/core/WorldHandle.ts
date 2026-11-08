/**
 * World handles (ADR 0032): the only cross-World API. A handle controls a World's lifetime and
 * setup (scenes, systems, pausing) but never exposes its nodes, so Worlds stay isolated.
 */
import { connectWorld, connectWorlds, listenWorld, netSession } from "../net/session";
import { SceneManager } from "../scene/SceneManager";
import { World } from "./World";
import type { WorldHandle, WorldTag } from "./worlds";
import { _setWorldServiceLookup } from "./worldServices";

/** @internal What a handle needs from the Engine that owns its World. */
export interface WorldOwner {
  _destroyWorld(world: World): void;
  /** The server World a bootstrap link connected `client` to, if any (ADR 0062). */
  _linkedServer?(client: World): World | null;
}

/** Handles to their Worlds, for engine internals that take a handle (`Lobby.host`, ADR 0068). */
const worldsByHandle = new WeakMap<WorldHandle, World>();

/** @internal The World behind a handle made by an Engine, or null (a destroyed World's handle, or another object). */
export function _worldOf(handle: WorldHandle): World | null {
  return handle.alive ? (worldsByHandle.get(handle) ?? null) : null;
}

// `worldService(handle, key)` (ADR 0135) finds the World behind a handle, and the current World, through these.
_setWorldServiceLookup(_worldOf, () => World.active);

/** @internal One per World, made by its Engine. */
export class WorldHandleImpl implements WorldHandle {
  /** @internal Set by the Engine when the World is destroyed. */
  _alive = true;
  // A true private field: nothing reachable from a handle leads to the World's nodes.
  readonly #world: World;
  readonly #owner: WorldOwner;

  /** @internal */
  constructor(world: World, owner: WorldOwner) {
    this.#world = world;
    this.#owner = owner;
    worldsByHandle.set(this, world);
  }

  get name(): string {
    return this.#world.name;
  }

  get tags(): readonly WorldTag[] {
    return this.#world.worldTags;
  }

  get alive(): boolean {
    return this._alive;
  }

  get paused(): boolean {
    return this.#world._paused;
  }

  hasTag(tag: WorldTag): boolean {
    return this.#world.worldTags.includes(tag);
  }

  async loadScene(path: string, options: { additive?: boolean } = {}): Promise<void> {
    const world = this.live();
    await World._runIn(world, () => SceneManager.load(path, options));
  }

  addSystem(name: string): void {
    this.live().addSystem(name);
  }

  removeSystem(name: string): void {
    this.live().removeSystem(name);
  }

  systems(): readonly string[] {
    return this.live().systemNames();
  }

  /**
   * Join this World (the client) to `server` over a transport (ADR 0033), as a bootstrap link does.
   * `server` may belong to another Engine in the same page. Over loopback the client is connecting
   * when this returns (an address is made up unless `options.address` is given); over a transport
   * that listens asynchronously (WebSocket, in Node) it connects once the server listens, and a
   * failure is logged. Either way the connection opens over the next frames: watch for the client's
   * `Connection` node to become `open`.
   *
   * `server` can instead be an address (ADR 0036): a server in another process, such as a
   * dedicated server, e.g. `connect("ws://localhost:7777", "websocket")`.
   */
  connect(server: WorldHandle | string, transport: string, options: Record<string, unknown> = {}): void {
    const world = this.live();
    if (typeof server === "string") {
      connectWorld(world, transport, { ...options, url: server, address: server });
      return;
    }
    if (!(server instanceof WorldHandleImpl) || !server.alive) throw new Error(`Can't connect World "${this.name}" to "${server.name}": it isn't a live World.`);
    if (this.#owner._linkedServer?.(world) === server.#world) {
      console.warn(`[myco] World "${this.name}" is already connected to "${server.name}" by a link in the project's bootstrap; connect() did nothing.`);
      return;
    }
    connectWorlds(world, server.#world, transport, options).catch((err) =>
      console.error(`[myco] Connecting World "${this.name}" to "${server.name}" over "${transport}" failed:`, err),
    );
  }

  /**
   * Make this World a server and start listening over a transport (ADR 0067), as a bootstrap link
   * does for its server: e.g. a match World created at runtime. Resolves with the address clients
   * connect to (`ws://localhost:7777/match/3`, or a loopback address) and rejects with the reason
   * listening failed. `options` are a link's listen options: `port`, `host`, `path`, `address`,
   * `maxConnections`, `handshakeTimeoutMs`, `idleTimeoutMs`. Over WebSocket in Node, Worlds that
   * listen on the same port share it, each at its own `path`; on the dedicated server a listen
   * without a port uses the server's (`--port`). Over loopback, a `path` makes the address unique.
   *
   * Throws if the World is a network client, or already listens over that transport at that
   * address. Browsers can't listen over WebSocket: that rejects, saying so.
   */
  listen(transport: string, options: Record<string, unknown> = {}): Promise<string> {
    const world = this.live();
    const session = netSession(world);
    if (session?.isClient) throw new Error(`World "${this.name}" is a network client; a World can't be both a server and a client yet.`);
    let already = false;
    try {
      already = !!session?.listensAt(transport, options);
    } catch {
      // No address for it: listenWorld below rejects with the reason.
    }
    if (already) throw new Error(`World "${this.name}" already listens over "${transport}" there (${session!.listening().map((l) => l.address).join(", ") || "still starting"}).`);
    try {
      return listenWorld(world, transport, options);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Where this World listens (ADR 0067): one address per `listen` or link that has finished starting. Empty if it isn't a server. */
  addresses(): readonly string[] {
    if (!this._alive) return [];
    return netSession(this.#world)?.listening().map((l) => l.address) ?? [];
  }

  pause(): void {
    this.live()._paused = true;
  }

  resume(): void {
    this.live()._paused = false;
  }

  destroy(): void {
    this.#owner._destroyWorld(this.live());
  }

  private live(): World {
    if (!this._alive) throw new Error(`World "${this.name}" has been destroyed.`);
    return this.#world;
  }
}
