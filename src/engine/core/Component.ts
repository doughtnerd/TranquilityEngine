import type { GameObject, InstantiateOptions } from "../scene/GameObject";
import type { Transform } from "../scene/Transform";
import type { TimeState, World } from "./World";

/**
 * Base class for everything attached to a node: built-in engine components and user
 * GameBehaviors (ADR 0007, 0009). Instances are created by the engine
 * (`node.addBehavior(Type)` or scene loading), never with `new` by game code.
 */
export abstract class Component {
  /** @internal */ _node!: GameObject;
  /** @internal */ _enabled = true;
  /** @internal */ _active = false;
  /** @internal */ _awoken = false;
  /** @internal */ _started = false;
  /** @internal */ _destroyed = false;
  /** @internal */ _seq = 0;

  /** The node this component is on. */
  get node(): GameObject {
    return this._node;
  }

  /** Unity-style alias for `node`. */
  get gameObject(): GameObject {
    return this._node;
  }

  /**
   * The node this component acts for: the node itself when attached directly, or the parent
   * node when this component lives on a component node (ADR 0009).
   */
  get owner(): GameObject {
    const node = this._node;
    return node.isComponentNode && node.parent ? node.parent : node;
  }

  /** The Transform of the node this component is on, if it has one. */
  get transform(): Transform {
    const t = this._node.transform;
    if (!t) throw new Error(`Node "${this._node.name}" has no Transform.`);
    return t;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (this._enabled === value) return;
    this._enabled = value;
    this.world._refreshComponent(this);
  }

  /** True when enabled, the node is active in the hierarchy, and the node is in a loaded world. */
  get isActiveAndEnabled(): boolean {
    return this._active;
  }

  /** @internal */
  get world(): World {
    return this._node.world;
  }

  /**
   * This component's World's clock (ADR 0032): the same values as `Time`, but safe to read
   * outside the World's frame too (after an `await`, say).
   */
  get time(): Readonly<TimeState> {
    return this._node.world.time;
  }

  /**
   * Instantiate a prefab in this component's World (ADR 0034), like `GameObject.instantiate`.
   * Use it in code that may run after an `await`: by then the frame is over and the current World
   * is the Engine's default one, which may not be this component's. A `parent` from another
   * World throws.
   */
  instantiate(prefabPath: string, options: InstantiateOptions = {}): GameObject {
    const world = this._node.world;
    world._assertOwns(options.parent, `${this.constructor.name}.instantiate("${prefabPath}") parent`);
    return world._instantiatePrefab(prefabPath, options);
  }

  // Internal hooks used by built-in components. Game code uses the lifecycle methods instead.
  /** @internal Called once when the component is added to a node. */
  _onAttach(): void {}
  /** @internal Called once when the component is removed or its node destroyed. */
  _onDetach(): void {}
  /** @internal Called whenever the component becomes active and enabled. */
  _onActivate(): void {}
  /** @internal Called whenever the component stops being active and enabled. */
  _onDeactivate(): void {}
  /**
   * @internal True for built-in components whose activation hooks also run inside an edit-mode
   * subtree (ADR 0026), because the editor must show what they make (a UIDocument's elements, ADR 0077).
   */
  get _activatesInEditMode(): boolean {
    return false;
  }
}

/** Lifecycle hooks a GameBehavior may implement (ADR 0007). All are optional. */
export interface LifecycleHooks {
  awake?(): void | Promise<void>;
  onEnable?(): void;
  start?(): void | Promise<void>;
  fixedUpdate?(): void;
  update?(): void;
  lateUpdate?(): void;
  onDisable?(): void;
  onDestroy?(): void;
  /** The other collider: a Collider2D in 2D physics, a Collider in 3D physics. */
  onTriggerEnter?(other: import("../physics/Collider2D").Collider2D | import("../physics/Collider").Collider): void;
  /** Every fixed step after onTriggerEnter while the two still overlap (ADR 0093). */
  onTriggerStay?(other: import("../physics/Collider2D").Collider2D | import("../physics/Collider").Collider): void;
  onTriggerExit?(other: import("../physics/Collider2D").Collider2D | import("../physics/Collider").Collider): void;
  /** A Collision2D in 2D physics, a Collision in 3D physics. */
  onCollisionEnter?(collision: import("../physics/Collider2D").Collision2D | import("../physics/Collider").Collision): void;
  /** Every fixed step after onCollisionEnter while the two still touch (ADR 0093). */
  onCollisionStay?(collision: import("../physics/Collider2D").Collision2D | import("../physics/Collider").Collision): void;
  onCollisionExit?(collision: import("../physics/Collider2D").Collision2D | import("../physics/Collider").Collision): void;
  /** A CharacterController or CharacterController2D on this node ran into a collider during `move` (ADR 0091). */
  onControllerColliderHit?(hit: import("../physics/CharacterController").ControllerColliderHit | import("../physics/CharacterController2D").ControllerColliderHit2D): void;
}

export type FrameHook = "fixedUpdate" | "update" | "lateUpdate";

/**
 * A user script. Subclass it, implement lifecycle methods, and attach it to nodes.
 *
 * ```ts
 * @behavior("game.Spinner")
 * export class Spinner extends GameBehavior {
 *   @field(Number) speed = 90;
 *   update() { this.transform.rotation2D += this.speed * Time.deltaTime; }
 * }
 * ```
 */
export abstract class GameBehavior extends Component {
  /** Lower values run earlier within the same hook. */
  static executionOrder = 0;

  /** @internal */ _wait: Waits | null = null;
  /** @internal */ _abort: AbortController | null = null;

  /** Engine-scheduled waits that respect pause and time scale, cancelled on disable/destroy (ADR 0018). */
  get wait(): Waits {
    return (this._wait ??= new Waits(this));
  }

  /** Aborted when this behavior is disabled or destroyed. Use it for fetch and other non-engine async work. */
  get abortSignal(): AbortSignal {
    return (this._abort ??= new AbortController()).signal;
  }
}

// Declaration merging adds the optional hooks to the class type.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface GameBehavior extends LifecycleHooks {}

export type WaitKind = "seconds" | "realtime" | "frame" | "fixed" | "until";

/** @internal */
export interface PendingWait {
  owner: GameBehavior;
  kind: WaitKind;
  target: number;
  predicate?: () => boolean;
  resolve: () => void;
}

/**
 * Promise-based waits. Promises are resolved by the engine scheduler at a fixed point in the
 * frame, never by timers. If the owning behavior is disabled or destroyed first, the promise
 * is dropped and the awaiting function simply stops.
 */
export class Waits {
  constructor(private readonly owner: GameBehavior) {}

  /** Resolve after `seconds` of scaled game time. */
  seconds(seconds: number): Promise<void> {
    const time = this.owner.world.time;
    return this.add("seconds", time.time + seconds);
  }

  /** Resolve after `seconds` of real time, ignoring pause and time scale. */
  realtime(seconds: number): Promise<void> {
    const time = this.owner.world.time;
    return this.add("realtime", time.realtimeSinceStartup + seconds);
  }

  /** Resolve at the start of the next frame's update phase. */
  nextFrame(): Promise<void> {
    return this.add("frame", this.owner.world.time.frameCount);
  }

  /** Resolve at the next fixed step, before `fixedUpdate`. */
  fixedStep(): Promise<void> {
    return this.add("fixed", this.owner.world.time.fixedStepCount);
  }

  /** Resolve on the first frame `predicate()` returns true. */
  until(predicate: () => boolean): Promise<void> {
    return this.add("until", 0, predicate);
  }

  private add(kind: WaitKind, target: number, predicate?: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.owner.isActiveAndEnabled) return; // dropped: never resolves
      this.owner.world._waits.push({ owner: this.owner, kind, target, predicate, resolve });
    });
  }
}
