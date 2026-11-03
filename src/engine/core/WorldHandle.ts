/**
 * World handles (ADR 0032): the only cross-World API. A handle controls a World's lifetime and
 * setup (scenes, systems, pausing) but never exposes its nodes, so Worlds stay isolated.
 */
import { connectWorld, connectWorlds } from "../net/session";
import { SceneManager } from "../scene/SceneManager";
import { World } from "./World";
import type { WorldHandle, WorldTag } from "./worlds";

/** @internal What a handle needs from the Engine that owns its World. */
export interface WorldOwner {
  _destroyWorld(world: World): void;
}

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
    connectWorlds(world, server.#world, transport, options).catch((err) =>
      console.error(`[myco] Connecting World "${this.name}" to "${server.name}" over "${transport}" failed:`, err),
    );
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
