/**
 * The World-owner seam (ADR 0281): what a World's owner, the Engine, offers the modules that work
 * with Worlds beyond one World's nodes. `World._owner` holds it typed, so the network session,
 * replication, lobbies, `Component.world` and the dedicated server ask it instead of each casting
 * an opaque `_engine` to a structural slice of `Engine`. `Engine` is the one implementation; a test
 * can hand a World a fake owner. Internal: not part of the public `myco` API.
 */
import type { World } from "./World";
import type { BootstrapConfig, WorldConfig, WorldHandle } from "./worlds";

/** Where listens that give no port or host go, per transport (ADR 0067, 0255): the dedicated server sets the WebSocket one. */
export interface ListenDefaults {
  readonly port?: number;
  readonly host?: string;
}

/** @internal Editor: one World's place in the Engine's views and input, from `WorldOwner._viewStates`. */
export interface WorldViewState {
  readonly name: string;
  /** It wants to render (`WorldConfig.renders`, or the default for its tags). */
  readonly renders: boolean;
  /** It has the Engine's main view (ADR 0034). */
  readonly mainView: boolean;
  /** It draws to a surface of its own besides the main view (`Engine._attachView`). */
  readonly extraView: boolean;
  /**
   * It handed the main view to another World (`_handView`, a lobby's match World): its surface is
   * kept, hidden, until the view comes back. It's on no screen meanwhile.
   */
  readonly viewHanded: boolean;
  /** Local input reaches it. */
  readonly takesInput: boolean;
  readonly paused: boolean;
}

/** @internal The owner of a set of Worlds (ADR 0032, 0281). */
export interface WorldOwner {
  /** Create a World from a config, or from the declared bootstrap's template of that name. */
  createWorld(config: WorldConfig | string): WorldHandle;
  /** Create a World from the declared bootstrap's template `template`, named `name` (a lobby's match Worlds). Throws if there's no such template. */
  _createFromTemplate(template: string, name: string): WorldHandle;
  /**
   * The declared bootstrap: the one bootstrap World templates are looked up in, and the one the
   * bootstrap topology (ADR 0256) classifies for lobbies. Null when there's none (a code bootstrap only).
   */
  readonly _declaredBootstrap: BootstrapConfig | null;
  /** A handle on a live World, by name, or null. */
  findWorld(name: string): WorldHandle | null;
  /** Handles on every live World, in creation order. */
  worlds(): readonly WorldHandle[];
  /** The live World named `name`, or null. */
  _world(name: string): World | null;
  /** The handle on `world` while this owner keeps it alive; null once it's destroyed (or isn't this owner's). */
  _handleOf(world: World): WorldHandle | null;
  /** The config the live World named `name` was created from, or null. */
  _worldConfig(name: string): Readonly<WorldConfig> | null;
  /** Destroy a World (`WorldHandle.destroy`). */
  _destroyWorld(world: World): void;
  /** The server World a bootstrap link connected `client` to, if any (ADR 0062). */
  _linkedServer(client: World): World | null;
  /** Defaults for its Worlds' listens over `transport` that give no port or host (ADR 0067, 0255). */
  _listenDefaults(transport: string): ListenDefaults | undefined;
  /** Set (or with null, clear) those defaults. */
  _setListenDefaults(transport: string, defaults: ListenDefaults | null): void;
  /** Unique per owner in this page: loopback addresses made up for its Worlds start with it ("engine-1/Server"). */
  readonly _loopbackPrefix: string;
  /** Every World's view and input state, in creation order. */
  _viewStates(): readonly WorldViewState[];
  /** Give the main view and input to the World named `name`; returns a function that hands them back (ADR 0068). */
  _handView(name: string): () => void;
}

