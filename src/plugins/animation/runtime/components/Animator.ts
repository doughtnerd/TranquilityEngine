/**
 * The Animator (ADR 0372): one per animated hierarchy. It runs an animation graph (`*.animgraph.json`) or, without one,
 * an implicit single-layer graph that code plays clips on (Animancer's model). Clip tracks bind relative to its node.
 * Evaluation runs in the core (ADR 0370) in `animation.Gather`, `Evaluate` and `Apply` (or `FixedEvaluate` with
 * `updateMode: "fixed"`); its methods queue commands for them and never evaluate anything themselves.
 *
 * Methods delegate to `../features/<feature>.ts`, so each build task changes its feature file, not this class.
 */
import { Component } from "../../../../engine/core/Component";
import { AssetRef, PlainObject, component, field } from "../../../../engine/core/registry";
import { GameObject } from "../../../../engine/scene/GameObject";
import * as bones from "../features/bones";
import * as graph from "../features/graph";
import * as ik from "../features/ik";
import { animatorHooks } from "../features/instances";
import * as playback from "../features/playback";
import * as warping from "../features/warp";
import type {
  AnimationPlayResult,
  AnimatorBone,
  AnimatorCrossfadeOptions,
  AnimatorCullingMode,
  AnimatorIKTarget,
  AnimatorJumpOptions,
  AnimatorLayer,
  AnimatorLodMetric,
  AnimatorParameterValue,
  AnimatorPlayOptions,
  AnimatorRequestOptions,
  AnimatorRootMotion,
  AnimatorStateInfo,
  AnimatorStopOptions,
  AnimatorTravelOptions,
  AnimatorTravelResult,
  AnimatorUpdateMode,
  AnimatorWarpTarget,
} from "../types";

@component("engine.Animator")
export class Animator extends Component {
  // ------------------------------------------------------------------------------------------------ graph

  /** The animation graph (`*.animgraph.json`). Empty: an implicit single-layer graph that `play` and `crossfade` drive. */
  @field(AssetRef, { kind: "animgraph", animatable: false, description: "The animation graph. Empty: code plays clips on an implicit single-layer graph." })
  graph = "";
  /**
   * A clip the implicit graph plays on start when there is no `graph` (Unity's legacy Animation, Godot's autoplay). Empty:
   * nothing plays until code calls `play`.
   */
  @field(AssetRef, { kind: "animclip", animatable: false, description: "Without a graph, the clip that plays on start." })
  defaultClip = "";
  /** Linked-graph nodes to run another graph in, by node name; `linkedGraphs[i]` replaces node `linkedGraphNodes[i]`'s default. */
  @field([String], { description: "Linked-graph nodes whose graph this Animator replaces." })
  linkedGraphNodes: string[] = [];
  /** The graph each of `linkedGraphNodes` runs (`*.animgraph.json`); an empty entry keeps the node's default. */
  @field([AssetRef], { kind: "animgraph", description: "The graph each linked-graph node runs instead of its default." })
  linkedGraphs: string[] = [];
  /**
   * Starting values of graph parameters, by name, overriding the graph asset's defaults: numbers, booleans, and number
   * arrays for `vec2`, `vec3` and `quat` (`node` parameters start empty). Edited in the Animator's Inspector section.
   */
  @field(PlainObject, { hidden: true })
  parameters: Record<string, number | boolean | number[]> = {};

  // ------------------------------------------------------------------------------------------------ update

  /** How its time advances: the World's scaled time, unscaled time, or fixed steps before physics (physics-driven and predicted characters). */
  @field(String, { choices: ["normal", "unscaled", "fixed"], animatable: false, description: "Scaled time, unscaled time, or fixed steps before physics." })
  updateMode: AnimatorUpdateMode = "normal";
  /** What it does while no camera sees it: keep animating, freeze the pose while playheads advance, or keep only root motion. */
  @field(String, { choices: ["always", "whenVisible", "rootMotionOnly"], animatable: false, description: "What happens while no camera sees it." })
  cullingMode: AnimatorCullingMode = "always";
  /** Where root motion goes. `characterController` and `rigidBody` need the physics plugin; every mode fills the `RootMotion` buffer. */
  @field(String, { choices: ["none", "transform", "characterController", "rigidBody"], animatable: false, description: "Where root motion goes; the RootMotion buffer gets it in every mode." })
  rootMotion: AnimatorRootMotion = "none";

  // ------------------------------------------------------------------------------------------------ LOD (ADR 0370)

  /**
   * What update-rate LOD measures: nothing (every frame), distance to the camera, the share of the screen's height, or
   * the enclosing `LODGroup`'s level for the main camera (ADR 0459 §6: level 0 updates every frame, level 1 every 2nd,
   * level 2 and below every 4th; a group culled by LOD counts as not visible for `cullingMode`).
   */
  @field(String, { choices: ["off", "distance", "screenSize", "lodGroup"], animatable: false, description: "What update-rate LOD measures: distance, screen size, or the enclosing LODGroup's level." })
  lodMetric: AnimatorLodMetric = "off";
  /** Past this distance (metres), or below this screen-height share, the pose updates every 2nd frame, interpolated between. */
  @field(Number, { animatable: false, description: "Distance (m) past which, or screen share below which, it updates every 2nd frame." })
  lodEvery2 = 20;
  /** Past this distance, or below this screen-height share, the pose updates every 4th frame. */
  @field(Number, { animatable: false, description: "Distance (m) past which, or screen share below which, it updates every 4th frame." })
  lodEvery4 = 40;
  /** Past this distance (metres) the rig stack and spring bones switch off; 0 keeps them on. */
  @field(Number, { animatable: false, description: "Distance (m) past which the rig stack and spring bones switch off; 0: never." })
  rigCullDistance = 0;
  /** At each slower LOD rate, motion-matching searches run this many times less often. */
  @field(Number, { animatable: false, description: "How much less often motion matching searches at each slower LOD rate." })
  lodSearchMultiplier = 2;

  // ------------------------------------------------------------------------------------------------ IK bindings

  /** IK goals of the graph's rig stack bound to nodes, by goal name; `ikTargetNodes[i]` is goal `ikTargets[i]`'s target. */
  @field([String], { description: "IK goals of the graph bound to scene nodes." })
  ikTargets: string[] = [];
  /** The node each of `ikTargets` follows (its world transform, every frame). */
  @field([GameObject], { description: "The node each IK goal follows." })
  ikTargetNodes: (GameObject | null)[] = [];

  // ------------------------------------------------------------------------------------------------ replicated state (ADR 0370, 0033; T33)
  // Written by servers in `animation.Apply`, applied by clients in `animation.Gather` (`features/network/`); each a
  // compact JSON array stamped with server ticks (`features/network/wire.ts`), at most 255 bytes (ADR 0068).

  /** @internal Each layer machine's state and the tick it was entered on (T33). */
  @field(String, { replicate: true, hidden: true, animatable: false })
  netStates = "";
  /** @internal Each slot's latest play: clip, start tick, section, speed, loop, blend, and a stop's tick and fade (T33). */
  @field(String, { replicate: true, hidden: true, animatable: false })
  netSlots = "";
  /** @internal Linked-graph choices made at run time (`link`), with their ticks (T33). */
  @field(String, { replicate: true, hidden: true, animatable: false })
  netLinks = "";
  /** @internal Values code set for graph parameters declared `replicate` (quantised), with the tick they last changed (T33). */
  @field(String, { replicate: true, hidden: true, animatable: false })
  netParameters = "";

  // ------------------------------------------------------------------------------------------------ API (ADR 0372)

  /** Set a graph parameter. The value must match the parameter's kind (float, int, bool, vec2, vec3, quat or node). */
  set(name: string, value: AnimatorParameterValue): void {
    graph.setParameter(this, name, value);
  }

  /**
   * Ask for a transition that reads `name` (no triggers, ADR 0372): the request stays open for `within` seconds (default
   * 0.25), is consumed by the first transition that reads it, and otherwise expires, so it never fires late.
   */
  request(name: string, options: AnimatorRequestOptions = {}): void {
    graph.request(this, name, options);
  }

  /**
   * Go to `state` by the shortest path through the layer's state machine (Godot's `travel`), using each hop's timing and
   * blend. The promise resolves when the machine gets there (`arrived`), when no path leads there (`unreachable`, with a
   * warning), or when another travel or jump comes first (`interrupted`).
   */
  travel(state: string, options: AnimatorTravelOptions = {}): Promise<AnimatorTravelResult> {
    return graph.travel(this, state, options);
  }

  /** Cut straight to `state`, with no path and no blend (inertialized). */
  jump(state: string, options: AnimatorJumpOptions = {}): void {
    graph.jump(this, state, options);
  }

  /**
   * Play a clip: in a graph slot as a one-shot over the graph (`{ slot: "UpperBody" }`), or, on an Animator without a
   * graph, on a layer of the implicit graph. `clip` is a clip asset (`asset:anims/slash.anim.json`, `asset:hero.glb#Anim/Run`)
   * or a clip named in the graph. The promise resolves when the play ends, with `finished`, `interrupted` (another play
   * took over) or `stopped`.
   */
  play(clip: string, options: AnimatorPlayOptions = {}): Promise<AnimationPlayResult> {
    return playback.play(this, clip, options);
  }

  /** Fade from what is playing to `clip` over `duration` seconds (`play` with a fade, plus an avatar mask). */
  crossfade(clip: string, duration: number, options: AnimatorCrossfadeOptions = {}): Promise<AnimationPlayResult> {
    return playback.crossfade(this, clip, duration, options);
  }

  /** Stop plays: on one layer, in one slot, or (with neither) all of them; their promises resolve with `stopped`. */
  stop(options: AnimatorStopOptions = {}): void {
    playback.stop(this, options);
  }

  /** Run `linked` (`*.animgraph.json`) in the linked-graph node `node` (weapon layers); null puts back the node's default. */
  link(node: string, linked: string | null): void {
    graph.link(this, node, linked);
  }

  /** Set a layer's weight, 0–1. */
  layerWeight(layer: AnimatorLayer, weight: number): void {
    playback.setLayerWeight(this, layer, weight);
  }

  /** The active state of a layer (default 0), as of the last evaluation. */
  state(layer: AnimatorLayer = 0): AnimatorStateInfo {
    return playback.stateOf(this, layer);
  }

  /**
   * Fill a parameter from `fn` once per frame, before evaluation (computed parameters, ADR 0372): transitions read it like
   * any other parameter, the debugger shows it and takes record it. Null stops it.
   */
  compute(name: string, fn: (() => AnimatorParameterValue) | null): void {
    graph.compute(this, name, fn);
  }

  /** An IK goal of the graph's rig stack, by name, to aim from code: `anim.ik("LeftHand").target(grip, { weight: 1 })`. */
  ik(name: string): AnimatorIKTarget {
    return ik.ikTarget(this, name);
  }

  /** Where the motion-warp window `window` (a cue marker range of the playing clip) should land; null clears it. */
  warp(window: string, target: AnimatorWarpTarget | null): void {
    warping.warp(this, window, target);
  }

  /** A bone of the skeleton, to read this frame's pose and override it from `lateUpdate()`: `anim.bone("Head").localRotation = q`. */
  bone(name: string): AnimatorBone {
    return bones.bone(this, name);
  }

  /** The latest play's promise: it resolves when that play ends, by finishing, interruption or `stop`. */
  get onFinished(): Promise<AnimationPlayResult> {
    return playback.finished(this);
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  /** @internal Activates in a scene being edited, inert until an editor preview drives it (ADR 0026, D135; `features/instances.ts`). */
  override get _activatesInEditMode(): boolean {
    return true;
  }

  override _onAttach(): void {
    animatorHooks.attach?.(this);
  }

  override _onActivate(): void {
    animatorHooks.activate?.(this);
  }

  override _onDeactivate(): void {
    animatorHooks.deactivate?.(this);
  }

  override _onDetach(): void {
    animatorHooks.detach?.(this);
  }
}
