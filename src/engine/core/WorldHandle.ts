/**
 * World handles (ADR 0032): the only cross-World API. A handle controls a World's lifetime and
 * setup (scenes, systems, pausing) but never exposes its nodes, so Worlds stay isolated.
 */
import { SceneManager } from "../scene/SceneManager";
import { World } from "./World";
import { notYet, type WorldHandle, type WorldTag } from "./worlds";

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

  connect(server: WorldHandle, transport: string, _options?: Record<string, unknown>): void {
    this.live();
    notYet("T10", `Connecting World "${this.name}" to "${server.name}" over "${transport}"`);
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
