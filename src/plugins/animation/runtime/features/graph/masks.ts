// Avatar masks in the core (ADR 0371, 0372): a `*.mask.json` file resolved to per-bone weights for one skeleton
// (`maskWeights.ts`) and loaded with `load_mask`, for graph layers and slots (`asset.ts` binds them) and for the implicit
// graph's `crossfade(clip, d, { mask })` (`../playback.ts`, a `SET_LAYER` command). Role entries map through the mask's
// profile, else the Skeleton's, else the built-in Humanoid, by the core's bone-map guess (the import's guesser,
// `engine/animation/import/boneMapGuess.ts`). Masks are content-keyed in the core: two files (or two skeletons) giving
// the same weights share one asset.
import { boneMapGuesser } from "../../../../../engine/animation/import/boneMapGuess";
import { parseMask } from "../../../../../engine/animation/mask";
import { parseSkeletonProfile, type SkeletonProfile } from "../../../../../engine/animation/skeletonProfile";
import { Assets, fetchAssetBytes } from "../../../../../engine/scene/Assets";
import type { SkeletonInfo } from "../../assetInfo";
import type { AnimationWorldCore } from "../../core/AnimationWorldCore";
import { readJsonAsset } from "./jsonAsset";
import { resolveMaskWeights } from "./maskWeights";
import { normalizeAssetPath } from "../../../../../engine/scene/assetPath";

/** @internal The skeleton a mask is resolved for: its asset path, bones and the Skeleton component's profile. */
export interface MaskRig {
  readonly path: string;
  readonly info: SkeletonInfo;
  /** The Skeleton's profile asset ("" for the import's, i.e. the built-in Humanoid here). */
  readonly profile: string;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

const readJson = readJsonAsset;

/** Role name → bone index for `rig` under `profilePath` (null: the built-in Humanoid); empty when nothing maps. */
async function roleBones(rig: MaskRig, profilePath: string | null): Promise<Map<string, number>> {
  const guess = boneMapGuesser();
  const out = new Map<string, number>();
  if (!guess) return out;
  let profile: SkeletonProfile | null = null;
  if (profilePath) {
    try {
      const parsed = parseSkeletonProfile(await readJson(profilePath), profilePath);
      profile = parsed.value;
    } catch (err) {
      warnOnce(`profile:${profilePath}`, `[myco] animation: couldn't read the skeleton profile "${profilePath}" for a mask: ${String(err)}`);
      return out;
    }
  }
  let skeletonBytes: Uint8Array;
  try {
    skeletonBytes = await fetchAssetBytes(Assets.url(rig.path));
  } catch {
    return out;
  }
  const map = await guess(skeletonBytes, rig.info.names, profile);
  for (const [role, bone] of Object.entries(map ?? {})) {
    const i = rig.info.indexOf(bone);
    if (i >= 0) out.set(role, i);
  }
  return out;
}

/** @internal The weights of mask `path` for `rig`, or null (one warning) when it can't be read. */
export async function maskWeightsFor(path: string, rig: MaskRig): Promise<Float32Array | null> {
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (err) {
    warnOnce(`mask:${path}`, `[myco] animation: couldn't read the mask "${path}": ${String(err)}`);
    return null;
  }
  const parsed = parseMask(raw, path);
  for (const p of parsed.problems) warnOnce(`maskp:${path}:${p}`, `[myco] animation: ${p}`);
  const mask = parsed.value;
  const needsRoles = mask.entries.some((e) => e.role !== undefined);
  const roles = needsRoles ? await roleBones(rig, mask.profile ? normalizeAssetPath(mask.profile) : rig.profile ? normalizeAssetPath(rig.profile) : null) : new Map<string, number>();
  const { weights, missing } = resolveMaskWeights(mask.entries, rig.info, (role) => roles.get(role) ?? -1);
  if (missing.length) warnOnce(`maskm:${path}:${rig.path}`, `[myco] animation: the mask "${path}" names ${missing.join(", ")}, which the skeleton "${rig.path}" doesn't have; skipped.`);
  return weights;
}

/** @internal One reference to mask `path` resolved for `rig`, loaded into the core: its handle, or 0 (one warning). */
export async function acquireMask(ns: AnimationWorldCore, path: string, rig: MaskRig): Promise<number> {
  const weights = await maskWeightsFor(path, rig);
  if (!weights || !ns.open) return 0;
  const handle = ns.acquire(`weights\u0000${Array.from(weights).join(",")}`, "mask", { kind: "mask", weights });
  if (!handle) warnOnce(`maskc:${path}`, `[myco] animation: the core refused the mask "${path}" (status ${ns.core.lastStatus()}).`);
  return handle;
}
