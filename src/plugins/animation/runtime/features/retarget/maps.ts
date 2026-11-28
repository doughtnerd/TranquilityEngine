// Retarget maps at run time (ADR 0372 "Retargeting"; T41t, D47, D70). A graph's RETARGET node (`retarget/retarget`)
// names its map with one asset reference (`params.map`), and runs its source graph (`params.source`) on the map's
// source skeleton. **How a graph names a retarget source:**
//
// - The `map` reference names the **source side**: a skeleton (`*.skel`, `*.skel.bin`, `model.glb#Skeleton`) or a
//   skeleton profile (`*.skelprofile.json`).
// - The Animator's `Skeleton.retargetSource` (a skeleton or a profile) overrides the same kind on the source side, so
//   one graph serves characters whose clips come from different rigs (Unity's per-character Avatar).
// - The source skeleton is the retargetSource's skeleton, else the map reference's; without one the node plays nothing
//   (one warning). The source profile is the retargetSource's profile, else the map reference's, else the built-in
//   Humanoid.
// - The **target side** is the Animator's own Skeleton: its skeleton and its `profile` (empty: the Humanoid).
// - Each side's bone map (one bone per profile role): for the Humanoid on a model's skeleton, the model's import
//   `boneMap` (its sidecar's, else the import's guess); otherwise the core's guess (`guess_bone_map`).
// - Profiles are encoded with `encodeSkeletonProfile` and decoded by the core (`profile_decode`); the map is created
//   with chain alignment on (`retarget_map_create`, `MAP_ALIGN`, D47's default). Everything is content-keyed in the
//   core, so characters sharing both sides share one map.
import type { AnimGraph } from "../../../../../engine/animation/animGraph";
import { modelSkeletonOf } from "../../../../../engine/animation/compile/keys";
import { fnv1aHex } from "../../../../../engine/animation/compile/hash";
import { encodeSkeletonProfile, parseSkeletonProfile } from "../../../../../engine/animation/skeletonProfile";
import { loadModel } from "../../../../../engine/scene/models";
import { readSkeletonInfo, type SkeletonInfo } from "../../assetInfo";
import { HUMANOID_ROLES } from "../../core/boneMap";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import { loadSkeletonBytes, resolveSkeleton } from "../clipSources";
import { readJsonAsset } from "../graph/jsonAsset";
import type { MaskRig } from "../graph/masks";
import { normalizeAssetPath } from "../../../../../engine/scene/assetPath";

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** `retarget_map_create` flag: align each chain's rest direction with the source's (`anim-wasm`'s `MAP_ALIGN`, D47). */
const MAP_ALIGN = 1;
const NO_BONE = 0xffff;

const isProfile = (ref: string): boolean => /\.skelprofile\.json$/i.test(normalizeAssetPath(ref));

/** @internal The rig a RETARGET node's map is made for: the target Skeleton and its `retargetSource`. */
export interface RetargetTarget extends MaskRig {
  /** The Skeleton's `retargetSource` ("" for none). */
  readonly retargetSource: string;
}

/** @internal A retarget map bound for a graph: its handle and the source rig its source graph compiles for. */
export interface RetargetBinding {
  readonly map: number;
  readonly source: MaskRig;
}

/** Where a RETARGET node's source side comes from (see the file header); null without a source skeleton. */
function retargetSourceOf(mapRef: string, retargetSource: string): { readonly skeleton: string; readonly profile: string } | null {
  const own = retargetSource ? normalizeAssetPath(retargetSource) : "";
  const map = normalizeAssetPath(mapRef);
  const skeleton = own && !isProfile(own) ? own : map && !isProfile(map) ? map : "";
  const profile = own && isProfile(own) ? own : map && isProfile(map) ? map : "";
  return skeleton ? { skeleton, profile } : null;
}

/** @internal A graph's RETARGET nodes: each one's map and source-graph references (project paths, "" for none). */
export function retargetNodes(graph: AnimGraph): readonly { readonly map: string; readonly source: string }[] {
  return graph.nodes
    .filter((n) => n.family === "retarget" && n.kind === "retarget")
    .map((n) => ({ map: typeof n.params.map === "string" ? normalizeAssetPath(n.params.map) : "", source: typeof n.params.source === "string" ? normalizeAssetPath(n.params.source) : "" }));
}

interface Side {
  readonly skeleton: number;
  readonly profile: number;
  readonly map: Uint16Array;
  readonly info: SkeletonInfo;
}

/** A custom profile's encoded bytes, or null (one warning) when it can't be read. */
async function profileBytes(path: string): Promise<Uint8Array | null> {
  try {
    const parsed = parseSkeletonProfile(await readJsonAsset(path), path);
    for (const p of parsed.problems) warnOnce(`profile-problem:${path}:${p}`, `[myco] animation: ${p}`);
    const encoded = encodeSkeletonProfile(parsed.value);
    if ("bytes" in encoded) return encoded.bytes;
    warnOnce(`profile-encode:${path}`, `[myco] animation: the skeleton profile "${path}" can't be used: ${encoded.problem}`);
  } catch (err) {
    warnOnce(`profile-read:${path}`, `[myco] animation: couldn't read the skeleton profile "${path}": ${String(err)}`);
  }
  return null;
}

/** @internal The Humanoid bone map from a model's import `boneMap` (role → bone name), or null when it maps nothing. */
export async function modelBoneMap(skeletonRef: string, info: SkeletonInfo): Promise<Uint16Array | null> {
  const model = modelSkeletonOf(skeletonRef);
  if (!model) return null;
  try {
    const boneMap = (await loadModel(model)).animation?.boneMap ?? {};
    const out = new Uint16Array(HUMANOID_ROLES.length).fill(NO_BONE);
    let any = false;
    HUMANOID_ROLES.forEach((role, i) => {
      const bone = boneMap[role];
      const b = bone ? info.indexOf(bone) : -1;
      if (b >= 0) {
        out[i] = b;
        any = true;
      }
    });
    return any ? out : null;
  } catch {
    return null;
  }
}

/** One side of a map: its skeleton and profile loaded into `ns` (handles into `held`) and its bone map. */
async function side(ns: AnimationWorldCore, skeletonRef: string, profilePath: string, held: number[]): Promise<Side | null> {
  const [resolved, bytes] = await Promise.all([resolveSkeleton(skeletonRef), loadSkeletonBytes(skeletonRef)]);
  const info = bytes ? readSkeletonInfo(bytes) : null;
  if (!resolved || !bytes || !info || !ns.open) {
    warnOnce(`retarget-skel:${skeletonRef}`, `[myco] animation: couldn't load the skeleton "${skeletonRef}" for retargeting.`);
    return null;
  }
  const skeleton = "path" in resolved ? await ns.acquireFile(resolved.path, "skeleton") : ns.acquire(resolved.key, "skeleton", { kind: "skeleton", bytes: resolved.bytes });
  if (!skeleton) return null;
  held.push(skeleton);
  let profile = 0;
  let encoded: Uint8Array | null = null;
  if (profilePath) {
    encoded = await profileBytes(profilePath);
    if (!encoded || !ns.open) return null;
    const bytesOf = encoded;
    profile = ns.acquire(`profile:${fnv1aHex(bytesOf)}:${bytesOf.length}`, "profile", { kind: "profile", bytes: bytesOf });
    if (!profile) {
      warnOnce(`profile-refused:${profilePath}`, `[myco] animation: the core refused the skeleton profile "${profilePath}" (status ${ns.core.lastStatus()}).`);
      return null;
    }
    held.push(profile);
  }
  const map = (!profilePath ? await modelBoneMap(skeletonRef, info) : null) ?? ns.core.guessBoneMap(bytes, encoded);
  if (!map) {
    warnOnce(`retarget-map:${skeletonRef}:${profilePath}`, `[myco] animation: couldn't map the bones of "${skeletonRef}" to ${profilePath ? `the profile "${profilePath}"` : "the Humanoid profile"}.`);
    return null;
  }
  return { skeleton, profile, map, info };
}

/**
 * @internal The retarget map a RETARGET node naming `mapRef` gets on `target` (see the file header), loaded into `ns`
 * with every handle it took added to `held`; null (one warning) when a side can't be made.
 */
export async function acquireRetargetMap(ns: AnimationWorldCore, mapRef: string, target: RetargetTarget, held: number[]): Promise<RetargetBinding | null> {
  const source = retargetSourceOf(mapRef, target.retargetSource);
  if (!source) {
    warnOnce(`retarget-nosource:${mapRef}:${target.path}`, `[myco] animation: the retarget node's map "${mapRef}" names no source skeleton, and the Skeleton "${target.path}" has no retargetSource skeleton; it plays nothing.`);
    return null;
  }
  const [src, tgt] = await Promise.all([side(ns, source.skeleton, source.profile, held), side(ns, target.path, target.profile ? normalizeAssetPath(target.profile) : "", held)]);
  if (!src || !tgt || !ns.open) return null;
  const key = `retarget:${src.skeleton}:${src.profile}:${Array.from(src.map).join(",")}|${tgt.skeleton}:${tgt.profile}:${Array.from(tgt.map).join(",")}`;
  const map = ns.acquire(key, "retargetMap", {
    kind: "retargetMap",
    source: { skeleton: src.skeleton, profile: src.profile, map: src.map },
    target: { skeleton: tgt.skeleton, profile: tgt.profile, map: tgt.map },
    flags: MAP_ALIGN,
  });
  if (!map) {
    warnOnce(`retarget-refused:${key}`, `[myco] animation: the core refused the retarget map from "${source.skeleton}" to "${target.path}" (status ${ns.core.lastStatus()}).`);
    return null;
  }
  held.push(map);
  return { map, source: { path: source.skeleton, info: src.info, profile: source.profile } };
}
