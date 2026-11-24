// Per-instance runtime state of Animators, Skeletons and BoneAttachments (ADR 0370, 0372; T17): what their lifecycle
// does, and each World's registry of them that the stages walk.
//
// - **Skeleton:** on activation it starts the World's core and acquires its skeleton asset (`skeleton`, a project path
//   to a `myco.skel@1` file; `model.glb#Skeleton` references come with the import, T14) through `acquireFile`, and reads
//   the file's bones, rest pose and bind matrices on the host (`../assetInfo.ts`). Released on detach. A `Skeleton2D`
//   (`sprites2d.ts`, T21) is a skeleton too, its bytes made on the host from an image slice's `skin`: both go through
//   `skeletonHooksFor` with their own `SkeletonSource`, so Animators bind to either the same way.
// - **Animator:** bound to the first Skeleton on its node or below it (Unity's Animator drives the hierarchy under it,
//   its Avatar's bones in that subtree), it owns one implicit-graph core instance (4 layers × 2 players and a
//   crossfade, D31) while active and bound. Deactivation or losing the Skeleton destroys the instance and ends its
//   plays with `stopped`; reactivation makes a new one (Unity resets an Animator's state on re-enable) and plays
//   `defaultClip` again. Clips are acquired once per Animator, path and the skeleton they bind to, and released on
//   detach; those bound to an earlier skeleton are released when it binds to another, once no play uses them.
//   A clip source (`*.anim.json`, `model#Anim/<name>`) resolves through `clipSources.ts` (T19): the build's compiled file, the editor's
//   compiled clip, else its raw form made here, bound to the Animator's skeleton.
//   An Animator with no Skeleton on its node or below gets a zero-bone instance (skeleton handle 0, T17b): clips play
//   and their property tracks, events, notify states and root curves run, with no pose or matrices (Unity's Animator
//   animates any property without a rig). When a Skeleton appears later it recreates the instance bound to it, as a
//   re-enable would (plays end `stopped`, `defaultClip` plays again); a Skeleton that goes away rebinds the Animator
//   to a zero-bone instance.
//   An Animator with a `graph` gets a graph instance instead (T32): `graphInstanceHooks.create` (filled by
//   `graph/register.ts`) compiles and loads the graph for the Skeleton (or for no bones) before creating it, and
//   `graphInstanceHooks.unbound` hears when it goes; everything else (binding, rebinding, plays ending) is the same.
//   A clip no file holds (an image flipbook, `image.png#Flip/<name>`) is made on the host (`subAssetClips.ts`).
// - **BoneAttachment:** joins its World's follow list (`attachments/follow.ts`) while active.
// - **Edit mode** (ADR 0026, D135): inside a scene being edited, Animators, Skeletons and Skeleton2Ds activate (they opt in
//   with `_activatesInEditMode`) but an Animator stays inert: no instance, no `defaultClip`, no graph, so nothing moves
//   and the skinned mesh keeps its bind pose. An editor preview (`editPreview.ts`) asks for an instance with
//   `setAnimatorPreview`: always the implicit graph's (a `graph` doesn't run), with nothing played until the preview
//   plays; ending the preview destroys it again, so the pose goes back to rest. Skeletons load as usual (no motion).
import type { Component } from "../../../../engine/core/Component";
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { Assets, fetchAssetBytes } from "../../../../engine/scene/Assets";
import { readClipInfo, readSkeletonInfo, type ClipInfo, type SkeletonInfo } from "../assetInfo";
import type { Animator } from "../components/Animator";
import type { BoneAttachment } from "../components/BoneAttachment";
import type { Skeleton } from "../components/Skeleton";
import type { AnimationFileKind, AnimationWorldCore } from "../core/AnimationWorldCore";
import { startAnimationCore } from "../core/service";
import type { LifecycleHooks } from "../lifecycle";
import { INPUT_LAYER_WEIGHTS, INPUT_STRIDE, HANDLE_INDEX_MASK, MAX_LAYERS, STATUS_OK } from "../wasm/wire/core";
import { joinFollowList, leaveFollowList } from "./attachments/follow";
import { resolveClip, resolveSkeleton, type AnimatorSkeleton, type ResolvedAsset } from "./clipSources";
import { endAllPlays, queueDefaultClip, type PlayCommand, type PlayRecord } from "./playback/plays";
import { subAssetClip } from "./subAssetClips";

// ------------------------------------------------------------------------------------------------ state

/** @internal A clip an Animator holds: loading (`handle` undefined), loaded, or missing (0). */
export interface ClipEntry {
  readonly path: string;
  /** What the skeleton it is bound to names ("" for none): an entry for an earlier skeleton goes once nothing uses it. */
  readonly skeleton: string;
  handle: number | undefined;
  info: ClipInfo | null;
}

/** @internal Where a skeleton component's bones come from: a file (`Skeleton`) or bytes made on the host (`Skeleton2D`). */
export interface SkeletonSource<C extends Component> {
  /** What the component names now ("" for nothing); loading again with the same key reuses the load. */
  key(component: C): string;
  /** One reference to the skeleton `key` names, in `ns`: its handle (0 when it couldn't load) and header. */
  acquire(ns: AnimationWorldCore, key: string, component: C): Promise<{ handle: number; info: SkeletonInfo | null }>;
}

/** @internal A Skeleton's (or Skeleton2D's) runtime state. */
export interface SkeletonRuntime {
  readonly component: Component;
  readonly source: SkeletonSource<Component>;
  readonly world: World;
  ns: AnimationWorldCore | null;
  /** The skeleton asset's handle; 0 until loaded (or when it couldn't load). */
  handle: number;
  info: SkeletonInfo | null;
  /** The path being (or last) loaded, and the load in flight. */
  path: string;
  loading: Promise<void> | null;
  /** The Animator animating it, if any. */
  animator: AnimatorRuntime | null;
  detached: boolean;
}

/** @internal An Animator's runtime state. */
export interface AnimatorRuntime {
  readonly animator: Animator;
  readonly world: World;
  ns: AnimationWorldCore | null;
  active: boolean;
  /** Bumped on each activation and deactivation, so a stale async activation gives up. */
  epoch: number;
  skeleton: SkeletonRuntime | null;
  /** The core instance (0: none). */
  instance: number;
  /** The instance's matrix row holds an evaluated pose. */
  evaluated: boolean;
  /** Bumps each time the instance's matrices may have changed (`skinningVersion`). */
  version: number;
  /** An editor preview wants an instance although the Animator is in edit mode (`setAnimatorPreview`). */
  previewing: boolean;
  /** This frame's visibility and whether the culling mode froze the pose (gather). */
  visible: boolean;
  frozen: boolean;
  /** Layer weights written to the input row each frame (seeded from the core's defaults). */
  readonly layerWeights: Float32Array;
  /** Plays, stops and layer settings waiting for the gather stage, in call order. */
  readonly queue: PlayCommand[];
  /** The play showing on each layer (null: none). */
  readonly layers: (PlayRecord | null)[];
  /** The latest play (`onFinished`). */
  latest: PlayRecord | null;
  /** Clips by the skeleton they were bound to and path (`clipKey`). */
  readonly clips: Map<string, ClipEntry>;
  /** Some clips bound to an earlier skeleton are still used (`releaseEarlierClips` tries again each frame). */
  earlierClips: boolean;
  detached: boolean;
}

/** One World's animation components. */
interface WorldAnimation {
  readonly animators: Set<AnimatorRuntime>;
  /** Skeletons by node entity. */
  readonly skeletons: Map<number, SkeletonRuntime>;
  /** Plays sent to the core, by play id. */
  readonly plays: Map<number, PlayRecord>;
}

const worlds = new WeakMap<World, WorldAnimation>();
const animators = new WeakMap<Animator, AnimatorRuntime>();
const skeletons = new WeakMap<Component, SkeletonRuntime>();

function worldState(world: World): WorldAnimation {
  let w = worlds.get(world);
  if (!w) worlds.set(world, (w = { animators: new Set(), skeletons: new Map(), plays: new Map() }));
  return w;
}

/** @internal The Animators of `world` that have runtime state (attached, not detached). */
export function animatorsOf(world: World): ReadonlySet<AnimatorRuntime> {
  return worldState(world).animators;
}

/** @internal Plays sent to `world`'s core instances, by play id. */
export function playsOf(world: World): Map<number, PlayRecord> {
  return worldState(world).plays;
}

/** @internal An Animator's runtime state, or null once detached. */
export function animatorRuntime(animator: Animator): AnimatorRuntime | null {
  return animators.get(animator) ?? null;
}

/** @internal The runtime state of the Skeleton on `node` (directly), or null. */
export function skeletonOnNode(world: World, node: GameObject): SkeletonRuntime | null {
  return worlds.get(world)?.skeletons.get(node.entity) ?? null;
}

/** @internal The Skeleton runtime of a Skeleton (or Skeleton2D) component. */
export function skeletonRuntime(skeleton: Component): SkeletonRuntime | null {
  return skeletons.get(skeleton) ?? null;
}

// ------------------------------------------------------------------------------------------------ files

/** Parsed file headers by URL (small, kept for the page): the core holds the bytes, the host only reads these. */
const infos = new Map<string, Promise<SkeletonInfo | ClipInfo | null>>();

function fileInfo(url: string, kind: "skeleton" | "clip"): Promise<SkeletonInfo | ClipInfo | null> {
  const key = `${kind}\u0000${url}`;
  let p = infos.get(key);
  if (!p) {
    p = fetchAssetBytes(url).then(
      (bytes) => (kind === "skeleton" ? readSkeletonInfo(bytes) : readClipInfo(bytes)),
      () => null,
    );
    infos.set(key, p);
    void p.then((v) => v ?? infos.delete(key)); // a missing file may appear later
  }
  return p;
}

/**
 * One reference to `path` loaded as `kind` in `ns` (`acquireFile`: shared and counted across Worlds), with the file's
 * header read on the host. The handle is 0 when the file is missing or the core refused it (one error is logged).
 */
async function acquireWithInfo<I>(ns: AnimationWorldCore, path: string, kind: AnimationFileKind & ("skeleton" | "clip")): Promise<{ handle: number; info: I | null }> {
  let url: string;
  try {
    url = Assets.url(path);
  } catch (err) {
    console.error(`[myco] animation: couldn't load "${path}":`, err);
    return { handle: 0, info: null };
  }
  const [handle, info] = await Promise.all([ns.acquireFile(path, kind), fileInfo(url, kind)]);
  return { handle, info: (info as I | null) ?? null };
}

/**
 * One reference to a resolved clip or skeleton (`clipSources.ts`): a file through `acquireWithInfo`, or bytes made on
 * the host (a raw clip, the editor's compiled clip, a model's skeleton) acquired by their key. Handle 0 when unresolved.
 */
async function acquireResolved<I>(ns: AnimationWorldCore, resolved: ResolvedAsset | null, kind: "skeleton" | "clip"): Promise<{ handle: number; info: I | null }> {
  if (!resolved) return { handle: 0, info: null };
  if ("path" in resolved) return acquireWithInfo<I>(ns, resolved.path, kind);
  const handle = ns.acquire(resolved.key, kind, { kind, bytes: resolved.bytes });
  const info = kind === "skeleton" ? readSkeletonInfo(resolved.bytes) : readClipInfo(resolved.bytes);
  return { handle, info: (info as I | null) ?? null };
}

/**
 * The skeleton an Animator's clips bind to now (ADR 0371: bone tracks by name): the first Skeleton on its node or below,
 * and what it names ("" for none).
 */
function clipSkeleton(rt: AnimatorRuntime): { s: SkeletonRuntime | null; ref: string } {
  const s = rt.skeleton ?? findSkeleton(rt.world, rt.animator.node);
  return { s, ref: s ? s.source.key(s.component) : "" };
}

/** `clipSkeleton`'s skeleton once loaded, for `resolveClip`; null for none. */
async function animatorSkeleton(s: SkeletonRuntime | null, ref: string): Promise<AnimatorSkeleton | null> {
  if (!s || !ref) return null;
  if (s.loading) await s.loading;
  return { ref, bones: s.info };
}

/** @internal The skeleton profile a Skeleton names (Skeleton2D has none: ""). */
export function skeletonProfileOf(s: SkeletonRuntime): string {
  const profile = (s.component as { profile?: unknown }).profile;
  return typeof profile === "string" ? profile : "";
}

/**
 * @internal The clip `path` for an Animator: acquired on first use (once per Animator, path and the skeleton its bones
 * bind to, so a Skeleton that appears or changes later gets the clip bound to its bones), released on detach.
 */
export function clipEntry(rt: AnimatorRuntime, path: string): ClipEntry {
  const { s, ref } = clipSkeleton(rt);
  const key = `${ref}\u0000${path}`;
  const entry = rt.clips.get(key);
  if (entry) return entry;
  const e: ClipEntry = { path, skeleton: ref, handle: undefined, info: null };
  rt.clips.set(key, e);
  void (async () => {
    const ns = rt.ns ?? (await startAnimationCore(rt.world).catch(() => null));
    if (!ns) {
      e.handle = 0;
      return;
    }
    const made = subAssetClip(path);
    const resolved = made === undefined ? await resolveClip(path, await animatorSkeleton(s, ref)) : null;
    const { handle, info } =
      made === undefined
        ? await acquireResolved<ClipInfo>(ns, resolved, "clip")
        : made
          ? { handle: ns.acquire(made.key, "clip", { kind: "clip", bytes: made.bytes }), info: readClipInfo(made.bytes) }
          : { handle: 0, info: null };
    if (rt.detached || rt.clips.get(key) !== e) {
      if (handle) ns.release(handle);
      return;
    }
    e.handle = handle;
    e.info = info;
    if (!handle) console.warn(`[myco] ${rt.animator.node.name}: Animator couldn't load the clip "${path}"; its plays end at once.`);
    // T70: a raw clip whose editor compile finishes switches to the compiled bytes in place (plays go on).
    const compiled = resolved && "compiled" in resolved ? resolved.compiled : undefined;
    if (handle && compiled) {
      void compiled.then((c) => {
        if (!c || rt.detached || rt.clips.get(key) !== e || e.handle !== handle || !ns.open) return;
        if (ns.core.replaceClip(handle, c.key, c.bytes) === STATUS_OK) e.info = readClipInfo(c.bytes) ?? e.info;
      });
    }
  })();
  return e;
}

function releaseClips(rt: AnimatorRuntime): void {
  for (const e of rt.clips.values()) if (e.handle && rt.ns) rt.ns.release(e.handle);
  rt.clips.clear();
  rt.earlierClips = false;
}

/**
 * @internal Features that keep clip entries in records of their own (graph slot plays, plays held for music) list the
 * ones of `rt` still in use, so an entry for an earlier skeleton isn't released under them.
 */
export const clipUsers = new Set<(rt: AnimatorRuntime) => Iterable<ClipEntry>>();

/**
 * @internal Releases `rt`'s clips bound to a skeleton other than the one it binds to now (an Animator that rebinds keeps
 * no clips for its earlier rig), except those a play still uses: those are tried again (`earlierClips`) each frame
 * until their plays end. A loading entry dropped here gives its handle back when it arrives.
 */
export function releaseEarlierClips(rt: AnimatorRuntime): void {
  const { ref } = clipSkeleton(rt);
  const used = new Set<ClipEntry>();
  for (const cmd of rt.queue) if (cmd.kind === "play" && !cmd.play.done) used.add(cmd.play.clip);
  for (const p of rt.layers) if (p && !p.done) used.add(p.clip);
  for (const p of playsOf(rt.world).values()) if (p.rt === rt && !p.done) used.add(p.clip);
  for (const users of clipUsers) for (const e of users(rt)) used.add(e);
  let kept = false;
  for (const [key, e] of rt.clips) {
    if (e.skeleton === ref) continue;
    if (used.has(e)) {
      kept = true;
      continue;
    }
    rt.clips.delete(key);
    if (e.handle && rt.ns) rt.ns.release(e.handle);
  }
  rt.earlierClips = kept;
}

// ------------------------------------------------------------------------------------------------ Skeleton

function loadSkeleton(s: SkeletonRuntime): Promise<void> {
  const path = s.source.key(s.component);
  if (s.loading && s.path === path) return s.loading;
  if (s.handle && s.ns) s.ns.release(s.handle);
  s.handle = 0;
  s.info = null;
  s.path = path;
  if (!path) return (s.loading = Promise.resolve());
  const loading = (async () => {
    const ns = await startAnimationCore(s.world).catch(() => null);
    if (!ns || s.detached || s.path !== path) return;
    s.ns = ns;
    const { handle, info } = await s.source.acquire(ns, path, s.component);
    if (s.detached || s.path !== path) {
      if (handle) ns.release(handle);
      return;
    }
    if (!handle) console.warn(`[myco] ${s.component.node.name}: Skeleton couldn't load "${path}".`);
    s.handle = handle;
    s.info = handle ? info : null;
    if (handle) bindAnimatorsAbove(s);
  })();
  s.loading = loading;
  return loading;
}

/** Animators on the Skeleton's node or above it that have no Skeleton yet bind to it. */
function bindAnimatorsAbove(s: SkeletonRuntime): void {
  for (let n: GameObject | null = s.component.node; n; n = n.parent) {
    for (const rt of worldState(s.world).animators) {
      if (rt.animator.node === n && rt.active && !rt.skeleton) rebindToSkeleton(rt);
    }
  }
}

/** @internal Whether `rt`'s Animator is inside a scene being edited (ADR 0026): it plays nothing by itself there. */
export function inEditMode(rt: AnimatorRuntime): boolean {
  return rt.animator.node.isValid && rt.world.inEditMode(rt.animator.node.entity);
}

/** In edit mode without a preview, an Animator has no instance (see the file header). */
function inert(rt: AnimatorRuntime): boolean {
  return !rt.previewing && inEditMode(rt);
}

/** Queues `defaultClip` on an Animator without a graph, outside edit mode. */
function playDefaultClip(rt: AnimatorRuntime): void {
  if (!rt.animator.graph && rt.animator.defaultClip && !inEditMode(rt)) queueDefaultClip(rt, rt.animator.defaultClip);
}

/** A Skeleton showed up for an Animator: drops its zero-bone instance (if any) and binds a new one to the Skeleton. */
function rebindToSkeleton(rt: AnimatorRuntime): void {
  if (rt.instance) {
    rt.epoch++;
    unbindAnimator(rt);
    playDefaultClip(rt);
  }
  void activateAnimator(rt);
}

/**
 * @internal The lifecycle of a skeleton component whose bones come from `source`: load them into the core's arena while
 * used; Animators on its node or above bind to it.
 */
export function skeletonHooksFor<C extends Component>(source: SkeletonSource<C>): LifecycleHooks<C> {
  return {
    attach(component) {
      const world = component.node.world;
      const s: SkeletonRuntime = { component, source: source as unknown as SkeletonSource<Component>, world, ns: null, handle: 0, info: null, path: "", loading: null, animator: null, detached: false };
      skeletons.set(component, s);
      worldState(world).skeletons.set(component.node.entity, s);
    },
    activate(component) {
      const s = skeletons.get(component);
      if (s) void loadSkeleton(s);
    },
    detach(component) {
      const s = skeletons.get(component);
      if (!s) return;
      s.detached = true;
      skeletons.delete(component);
      const w = worldState(s.world);
      if (w.skeletons.get(component.node.entity) === s) w.skeletons.delete(component.node.entity);
      const animator = s.animator;
      if (animator) unbindAnimator(animator);
      if (s.handle && s.ns) s.ns.release(s.handle);
      s.handle = 0;
      // The Animator keeps running on whatever rig is left, or none (T17b).
      if (animator?.active && !animator.detached) void activateAnimator(animator);
    },
  };
}

/** @internal A Skeleton's lifecycle: its skeleton asset (`skeleton`, a `myco.skel@1` file). */
export const skeletonHooks: LifecycleHooks<Skeleton> = skeletonHooksFor<Skeleton>({
  key: (c) => c.skeleton,
  acquire: async (ns, path) => acquireResolved<SkeletonInfo>(ns, await resolveSkeleton(path), "skeleton"),
});

// ------------------------------------------------------------------------------------------------ Animator

/** The first Skeleton on `node` or below it, depth-first (Unity's Animator binds the hierarchy under it). */
function findSkeleton(world: World, node: GameObject): SkeletonRuntime | null {
  // A load that finishes after its Animator was destroyed asks about a destroyed node: it has no skeleton.
  if (!node.isValid) return null;
  const own = worldState(world).skeletons.get(node.entity);
  if (own && !own.detached) return own;
  for (const child of node.children) {
    const found = findSkeleton(world, child);
    if (found) return found;
  }
  return null;
}

/**
 * @internal Graph-asset instances (ADR 0372; T32 fills these from `graph/register.ts`): an Animator with a `graph` gets
 * its instance from `create` (which compiles and loads the graph for the Skeleton, then creates the instance only while
 * `current()` holds, returning 0 otherwise), and `unbound` hears when it goes (its slot plays end, its graph is released).
 */
export const graphInstanceHooks: {
  create?(rt: AnimatorRuntime, ns: AnimationWorldCore, skeleton: SkeletonRuntime | null, current: () => boolean): Promise<number>;
  unbound?(rt: AnimatorRuntime, instance: number): void;
} = {};

let warnedGraph = false;

/**
 * A new instance for `rt` on `skeleton` (null: zero bones), adopted while `current()` holds: the implicit graph's
 * (synchronously), or its graph asset's (once the graph has loaded). Warns when the core refuses one.
 */
async function bindInstance(rt: AnimatorRuntime, ns: AnimationWorldCore, skeleton: SkeletonRuntime | null, current: () => boolean): Promise<void> {
  let instance: number;
  // An edit-mode preview always gets the implicit graph: the clip being edited plays alone, and no graph runs.
  if (!rt.animator.graph || inEditMode(rt)) instance = ns.createInstance(skeleton?.handle ?? 0);
  else if (graphInstanceHooks.create) {
    instance = await graphInstanceHooks.create(rt, ns, skeleton, current);
    if (!instance) return; // warned by the graph runtime, or no longer current
    if (!current()) {
      // Something changed between the graph runtime's check and here: give the instance back.
      graphInstanceHooks.unbound?.(rt, instance);
      ns.destroyInstance(instance);
      return;
    }
  } else {
    if (!warnedGraph) {
      warnedGraph = true;
      console.warn(`[myco] ${rt.animator.node.name}: Animator graphs need the graph feature, which isn't registered; it stays at its bind pose.`);
    }
    return;
  }
  if (!instance) {
    console.warn(`[myco] ${rt.animator.node.name}: Animator couldn't get a core instance (status ${ns.core.lastStatus()}).`);
    return;
  }
  if (skeleton) {
    rt.skeleton = skeleton;
    skeleton.animator = rt;
  }
  adoptInstance(rt, ns, instance);
  releaseEarlierClips(rt);
}

async function activateAnimator(rt: AnimatorRuntime): Promise<void> {
  if (inert(rt)) return;
  const epoch = rt.epoch;
  const ns = await startAnimationCore(rt.world).catch(() => null);
  if (!ns || rt.epoch !== epoch || !rt.active || inert(rt)) return;
  rt.ns = ns;
  const s = findSkeleton(rt.world, rt.animator.node);
  if (!s) {
    // No rig: a zero-bone instance, so property tracks, events, notifies and graph logic still run (T17b).
    if (rt.instance) return;
    await bindInstance(rt, ns, null, () => rt.epoch === epoch && rt.active && !rt.instance && !findSkeleton(rt.world, rt.animator.node));
    return;
  }
  if (s.animator && s.animator !== rt) {
    console.warn(`[myco] ${rt.animator.node.name}: its Skeleton ("${s.component.node.name}") is already animated by another Animator.`);
    return;
  }
  if (s.loading) await s.loading;
  const current = () => rt.epoch === epoch && rt.active && !s.detached && !!s.handle && !rt.instance && (!s.animator || s.animator === rt);
  if (current()) await bindInstance(rt, ns, s, current);
}

/** Makes `instance` the Animator's and seeds its layer weights from the core's defaults. */
function adoptInstance(rt: AnimatorRuntime, ns: AnimationWorldCore, instance: number): void {
  rt.instance = instance;
  rt.evaluated = false;
  const row = (instance & HANDLE_INDEX_MASK) * INPUT_STRIDE;
  const inputs = ns.core.views().inputs;
  for (let l = 0; l < MAX_LAYERS; l++) if (Number.isNaN(rt.layerWeights[l]!)) rt.layerWeights[l] = inputs.getFloat32(row + INPUT_LAYER_WEIGHTS + 4 * l, true);
}

/** Destroys the Animator's instance (its plays end `stopped`) and frees its Skeleton. */
function unbindAnimator(rt: AnimatorRuntime): void {
  endAllPlays(rt, "stopped");
  graphInstanceHooks.unbound?.(rt, rt.instance);
  if (rt.instance && rt.ns) rt.ns.destroyInstance(rt.instance);
  rt.instance = 0;
  rt.evaluated = false;
  rt.version++;
  if (rt.skeleton?.animator === rt) rt.skeleton.animator = null;
  rt.skeleton = null;
}

/** @internal An Animator's lifecycle: an implicit-graph instance while active and bound; plays resolve `stopped` when it goes. */
export const animatorHooks: LifecycleHooks<Animator> = {
  attach(animator) {
    const world = animator.node.world;
    const rt: AnimatorRuntime = {
      animator,
      world,
      ns: null,
      active: false,
      epoch: 0,
      skeleton: null,
      instance: 0,
      evaluated: false,
      version: 0,
      previewing: false,
      visible: true,
      frozen: false,
      layerWeights: new Float32Array(MAX_LAYERS).fill(Number.NaN),
      queue: [],
      layers: new Array<PlayRecord | null>(MAX_LAYERS).fill(null),
      latest: null,
      clips: new Map(),
      earlierClips: false,
      detached: false,
    };
    animators.set(animator, rt);
    worldState(world).animators.add(rt);
  },
  activate(animator) {
    const rt = animators.get(animator);
    if (!rt) return;
    rt.active = true;
    rt.epoch++;
    playDefaultClip(rt);
    void activateAnimator(rt);
  },
  deactivate(animator) {
    const rt = animators.get(animator);
    if (!rt) return;
    rt.active = false;
    rt.epoch++;
    unbindAnimator(rt);
  },
  detach(animator) {
    const rt = animators.get(animator);
    if (!rt) return;
    rt.active = false;
    rt.epoch++;
    unbindAnimator(rt);
    rt.detached = true;
    releaseClips(rt);
    animators.delete(animator);
    worldState(rt.world).animators.delete(rt);
  },
};

/**
 * @internal An editor preview drives `animator` (`on`) or lets it go. In edit mode, on makes its implicit-graph instance
 * (nothing played) and off destroys it: its plays end `stopped` and the pose goes back to rest. Outside edit mode the
 * Animator runs as usual and this changes nothing.
 */
export function setAnimatorPreview(animator: Animator, on: boolean): void {
  const rt = animators.get(animator);
  if (!rt || rt.previewing === on) return;
  rt.previewing = on;
  if (!inEditMode(rt)) return;
  rt.epoch++;
  if (on) {
    if (rt.active && !rt.instance) void activateAnimator(rt);
  } else unbindAnimator(rt);
}

// ------------------------------------------------------------------------------------------------ BoneAttachment

/** @internal A BoneAttachment's lifecycle: join and leave its World's post-propagation follow list. */
export const boneAttachmentHooks: LifecycleHooks<BoneAttachment> = {
  activate(attachment) {
    joinFollowList(attachment);
  },
  deactivate(attachment) {
    leaveFollowList(attachment);
  },
  detach(attachment) {
    leaveFollowList(attachment);
  },
};
