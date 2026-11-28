import type { GameObject, InstantiateOptions } from "../scene/GameObject";
import type { Transform } from "../scene/Transform";
import type { AudioMarkerEvent } from "../audio/markerTypes";
import type { MusicEvent } from "../audio/musicTypes";
import type { TimeState, World } from "./World";
import type { WorldHandle } from "./worlds";
import type { PlayerInput } from "../input/facade";

/** Builds a behavior's `input` (set by `input/facade.ts`, which core can't import). */
let inputFacade: ((behavior: GameBehavior) => PlayerInput) | null = null;

/** @internal The input module registers how a behavior's `input` is made. */
export function _setInputFacade(make: (behavior: GameBehavior) => PlayerInput): void {
  inputFacade = make;
}

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
    this._world._refreshComponent(this);
  }

  /** True when enabled, the node is active in the hierarchy, and the node is in a loaded world. */
  get isActiveAndEnabled(): boolean {
    return this._active;
  }

  /** @internal The World this component's node is in. Game code uses `world`, its handle (ADR 0132). */
  get _world(): World {
    return this._node.world;
  }

  /**
   * A handle on this component's World (ADR 0132): the same one `Engine.findWorld` returns. Load
   * a scene into it, pause, connect or destroy it: `this.world.loadScene("scenes/level2.scene.json")`.
   * Throws for a World no Engine owns.
   */
  get world(): WorldHandle {
    const world = this._node.world;
    const handle = world._owner?._handleOf(world);
    if (!handle) throw new Error(`${this.constructor.name}: the World "${world.name}" has no handle: it isn't in an Engine.`);
    return handle;
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
   * subtree (ADR 0026), because the editor must show what they make (a UIView's elements, ADR 0423).
   */
  get _activatesInEditMode(): boolean {
    return false;
  }
}

/**
 * What both physics plugins' collision hooks receive (`Collision2D` and `Collision` have these and more).
 * Core names only the shared shape: physics lives in plugins (ADR 0135).
 */
export interface PhysicsCollision {
  /** The other collider. */
  readonly collider: Component;
  /** This side's collider. */
  readonly otherCollider: Component;
  /** The other collider's owner node. */
  readonly gameObject: GameObject;
  readonly rigidbody: Component | null;
}

/** What both character controllers' hits have (`ControllerColliderHit2D` and `ControllerColliderHit` have more). */
export interface PhysicsControllerHit {
  readonly controller: Component;
  readonly collider: Component;
  readonly gameObject: GameObject;
  readonly rigidbody: Component | null;
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
  /**
   * The other collider: a Collider2D in 2D physics, a Collider in 3D physics (the physics plugins, ADR
   * 0135). Annotate the parameter with the one your game uses: `onTriggerEnter(other: Collider2D)`.
   */
  onTriggerEnter?(other: Component): void;
  /** Every fixed step after onTriggerEnter while the two still overlap (ADR 0093). */
  onTriggerStay?(other: Component): void;
  onTriggerExit?(other: Component): void;
  /** A Collision2D in 2D physics, a Collision in 3D physics: annotate the parameter with the one your game uses. */
  onCollisionEnter?(collision: PhysicsCollision): void;
  /** Every fixed step after onCollisionEnter while the two still touch (ADR 0093). */
  onCollisionStay?(collision: PhysicsCollision): void;
  onCollisionExit?(collision: PhysicsCollision): void;
  /** A Joint or Joint2D on this node broke (its `breakForce` or `breakTorque` was exceeded); it is destroyed after this (ADR 0092). */
  onJointBreak?(joint: Component, force: number, torque: number): void;
  /** A CharacterController or CharacterController2D on this node ran into a collider during `move` (ADR 0091): a ControllerColliderHit or ControllerColliderHit2D. */
  onControllerColliderHit?(hit: PhysicsControllerHit): void;
  /**
   * A beat of the playlist an `AudioSource` on this node plays, when its playing entry has a tempo (a Sequence with a
   * tempo, or a sample with one): delivered by the audio system (late update) on the first frame whose heard clock has
   * passed it. After a gap of more than one beat the beats coalesce into one call with `e.missed` set (ADR 0166, 0343).
   * Defining the hook is the subscription. `e` is reused: read it during the call, don't keep it.
   */
  onMusicBeat?(e: MusicEvent): void;
  /** The first beat of each bar of that music (`e.beat` is 1), delivered as `onMusicBeat` is. */
  onMusicBar?(e: MusicEvent): void;
  /**
   * A cue of ADR 0166's music events. Playlists report cues as markers (`onAudioMarker`), so it isn't called for them
   * (ADR 0343); kept so old scripts still compile.
   */
  onMusicCue?(e: MusicEvent): void;
  /**
   * A marker passing in the playlist an `AudioSource` on this node plays (ADR 0343): the Cue, Exit and Hit markers of its
   * samples and its sequences' `cue` and `exit` markers, every type (`e.type` says which), delivered by the audio system
   * (late update) on the first frame whose heard clock has passed it (`e.time` is exact). A playlist's beats and bars
   * reach `onMusicBeat`/`onMusicBar` from there too. Defining the hook is the subscription; the handle's
   * `onMarker(type, fn)` is the same for scripts that hold the handle.
   */
  onAudioMarker?(e: AudioMarkerEvent): void;
}

export type FrameHook = "fixedUpdate" | "update" | "lateUpdate";

/**
 * The hooks the World sends as behaviour messages (ADR 0303): those that take an argument, which the
 * sender chooses (the other collider, the hit, the music event).
 */
export type MessageHook = {
  [K in keyof LifecycleHooks]-?: Parameters<NonNullable<LifecycleHooks[K]>> extends [] ? never : K;
}[keyof LifecycleHooks];

/** The arguments a message hook takes. */
export type MessageArgs<H extends MessageHook> = Parameters<NonNullable<LifecycleHooks[H]>>;

/** Every lifecycle hook's name: a named message may not use one (checked complete against `LifecycleHooks`). */
const LIFECYCLE_HOOK_NAMES: ReadonlySet<string> = new Set(
  Object.keys({
    awake: 1, onEnable: 1, start: 1, fixedUpdate: 1, update: 1, lateUpdate: 1, onDisable: 1, onDestroy: 1,
    onTriggerEnter: 1, onTriggerStay: 1, onTriggerExit: 1, onCollisionEnter: 1, onCollisionStay: 1, onCollisionExit: 1,
    onJointBreak: 1, onControllerColliderHit: 1, onMusicBeat: 1, onMusicBar: 1, onMusicCue: 1, onAudioMarker: 1,
  } satisfies Record<keyof LifecycleHooks, 1>),
);

/**
 * @internal A behaviour method an engine feature names at run time rather than at compile time: an animation clip's
 * notify (ADR 0372, `World._sendMessage(nodes, NamedMessage.of("footstep"), e)`). The World delivers it with the same
 * rules as the hooks (ADR 0303). `of` refuses (null) a lifecycle hook's name, so data can't fake a collision or call
 * `update`, and any member `GameBehavior` or `Component` themselves have (`enabled`, `wait`, `transform`, `constructor`…): only a
 * method a behaviour class declares can be named. Instances are shared per name.
 */
export class NamedMessage {
  private static readonly byName = new Map<string, NamedMessage>();

  private constructor(readonly method: string) {}

  /** The message for `method`, or null when that name is reserved (see the class). */
  static of(method: string): NamedMessage | null {
    const known = NamedMessage.byName.get(method);
    if (known) return known;
    if (!method || LIFECYCLE_HOOK_NAMES.has(method) || method in GameBehavior.prototype) return null;
    const m = new NamedMessage(method);
    NamedMessage.byName.set(method, m);
    return m;
  }
}

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

  /**
   * The input of the player controlling this behavior's node (ADR 0336, 0337): the pawn's actions
   * (the nearest node up with `ControlledBy` or an action set), else player 0's.
   * `this.input.vector2("move")`, `this.input.performed("jump")`, `this.input.on("heavy", "performed", fn)`.
   */
  get input(): PlayerInput {
    if (!inputFacade) throw new Error("input: the input module isn't loaded.");
    return inputFacade(this);
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
    const time = this.owner._world.time;
    return this.add("seconds", time.time + seconds);
  }

  /** Resolve after `seconds` of real time, ignoring pause and time scale. */
  realtime(seconds: number): Promise<void> {
    const time = this.owner._world.time;
    return this.add("realtime", time.realtimeSinceStartup + seconds);
  }

  /** Resolve at the start of the next frame's update phase. */
  nextFrame(): Promise<void> {
    return this.add("frame", this.owner._world.time.frameCount);
  }

  /** Resolve at the next fixed step, before `fixedUpdate`. */
  fixedStep(): Promise<void> {
    return this.add("fixed", this.owner._world.time.fixedStepCount);
  }

  /** Resolve on the first frame `predicate()` returns true. */
  until(predicate: () => boolean): Promise<void> {
    return this.add("until", 0, predicate);
  }

  private add(kind: WaitKind, target: number, predicate?: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.owner.isActiveAndEnabled) return; // dropped: never resolves
      this.owner._world._waits.push({ owner: this.owner, kind, target, predicate, resolve });
    });
  }
}
