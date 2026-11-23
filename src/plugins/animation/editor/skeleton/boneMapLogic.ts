// The bone map editor's model (ADR 0373 "Skeleton and retarget tools"; T54): a model sidecar's `animation.boneMap`
// (profile role → bone name) and `profile`, edited as the pure edits of the refused-or-next result (ADR 0307, 0313). The
// view (`BoneMapEditor.tsx`) applies each result through `applyEdit` onto the Import Settings draft, so the shell's Apply
// and Revert write them with every other import setting, as one change.
//
// - **Rows:** one per role of the profile (the built-in Humanoid or a `*.skelprofile.json`): the bone it maps to, whether
//   the role is required, its mirror partner, and how well the bone's name matches the role's (a token match, 0..1; the
//   core's own guess scores don't leave `guess_bone_map`'s host call, so this is a second opinion shown beside it).
// - **Auto-guess:** the animation core's `guess_bone_map`, through the engine's installed guesser (`boneMapGuesser`), fills
//   the roles that have no bone; "Clear" first makes it a full redo.
// - **Mirror:** copies the mapped bones of one side to the other side's roles by swapping the side in the bone's name
//   (`LeftArm` → `RightArm`, `arm_L` → `arm_R`, `L_arm` → `R_arm`), where the skeleton has that bone.
// - **Guessed maps are persisted by saving:** a model imported with no `boneMap` shows the core's guess (`ModelData`'s
//   `boneMapSource: "guessed"`, which lives in memory); the first edit, or "Keep guessed map", writes the whole map into
//   the draft, and Apply puts it in the sidecar.
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { boneMapGuesser } from "../../../../engine/animation/import/boneMapGuess";
import { ANIMATION_IMPORT_LIMITS, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import type { ImportedSkeleton } from "../../../../engine/animation/import/skeleton";
import { encodeSkeleton } from "../../../../engine/animation/import/skeletonBinary";
import type { SkeletonProfile } from "../../../../engine/animation/skeletonProfile";

/** A role → bone name map. */
export type BoneMap = Readonly<Record<string, string>>;

/** One row of the bone map table. */
export interface BoneMapRow {
  readonly role: string;
  /** The bone the role maps to, or null. */
  readonly bone: string | null;
  readonly required: boolean;
  /** The role's mirror partner, or null for a centre role. */
  readonly mirror: string | null;
  /** `mapped`; `unmapped` (no bone); `missing`: names a bone the skeleton doesn't have. */
  readonly status: "mapped" | "unmapped" | "missing";
  /** How well the bone's name matches the role's, 0..1; null without a bone. */
  readonly match: number | null;
}

const replace = (a: ModelAnimationSettings, patch: Partial<ModelAnimationSettings>): ModelAnimationSettings => ({ ...a, ...patch });
const without = (map: BoneMap, role: string): Record<string, string> => Object.fromEntries(Object.entries(map).filter(([r]) => r !== role));

// --- name matching -----------------------------------------------------------------------------------------------------

/** Words a bone name uses for a part, as the role's word (`thigh` → `upper leg`). */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  pelvis: ["hips"], hip: ["hips"], thigh: ["upper", "leg"], calf: ["lower", "leg"], shin: ["lower", "leg"], forearm: ["lower", "arm"], fore: ["lower"],
  clavicle: ["shoulder"], collar: ["shoulder"], toe: ["toes"], ball: ["toes"], l: ["left"], r: ["right"], lt: ["left"], rt: ["right"],
  mid: ["middle"], pinky: ["little"], proximal: ["proximal"], dist: ["distal"],
};

/** Lower-case words of a role or bone name: camelCase and separators split, rig prefixes (`mixamorig:`) dropped, aliases expanded. */
function words(name: string): string[] {
  const afterPrefix = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  const split = afterPrefix.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
  return split.flatMap((w) => ALIASES[w] ?? [w]).filter((w) => !/^\d+$/.test(w));
}

/** How well `bone`'s name matches `role`'s, 0..1 (the share of their words in common). */
export function boneNameMatch(role: string, bone: string): number {
  const a = new Set(words(role));
  const b = new Set(words(bone));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** `name` with its side swapped to `to` (`LeftArm` → `RightArm`, `arm_L` → `arm_R`); null when it names no side. */
export function sideSwapped(name: string, to: "Left" | "Right"): string | null {
  const word = /Left|Right|left|right|LEFT|RIGHT/;
  const m = word.exec(name);
  const lower = to === "Left" ? "left" : "right";
  if (m) {
    const w = m[0];
    const isLeft = w.toLowerCase() === "left";
    if ((to === "Left") === isLeft) return name; // already that side
    const swapped = w === w.toUpperCase() ? lower.toUpperCase() : w[0] === w[0].toUpperCase() ? to : lower;
    return name.slice(0, m.index) + swapped + name.slice(m.index + w.length);
  }
  const letter = /(^|[^A-Za-z])([LRlr])(?=[^A-Za-z]|$)/.exec(name);
  if (!letter) return null;
  const isLeft = letter[2].toLowerCase() === "l";
  if ((to === "Left") === isLeft) return name;
  const swapped = letter[2] === letter[2].toUpperCase() ? (to === "Left" ? "L" : "R") : to === "Left" ? "l" : "r";
  const at = letter.index + letter[1].length;
  return name.slice(0, at) + swapped + name.slice(at + 1);
}

// --- the table ---------------------------------------------------------------------------------------------------------

/** The table's rows for `profile`'s roles over `map`, for a skeleton with `bones` (names). */
export function boneMapRows(profile: SkeletonProfile, map: BoneMap, bones: readonly string[]): BoneMapRow[] {
  const known = new Set(bones);
  return profile.roles.map((r) => {
    const bone = map[r.name] ?? null;
    return {
      role: r.name,
      bone,
      required: r.required,
      mirror: r.mirror !== r.name ? r.mirror : null,
      status: bone === null ? "unmapped" : known.has(bone) ? "mapped" : "missing",
      match: bone === null ? null : boneNameMatch(r.name, bone),
    };
  });
}

/** The required roles of `profile` that have no bone in the skeleton, in the profile's order. */
export function missingRequired(profile: SkeletonProfile, map: BoneMap, bones: readonly string[]): string[] {
  const known = new Set(bones);
  return profile.roles.filter((r) => r.required && !(map[r.name] !== undefined && known.has(map[r.name]))).map((r) => r.name);
}

/** The map's entries that name a role the profile lacks or a bone the skeleton lacks (a stale map after a profile or rig change). */
export function staleEntries(profile: SkeletonProfile, map: BoneMap, bones: readonly string[]): string[] {
  const roles = new Set(profile.roles.map((r) => r.name));
  const known = new Set(bones);
  return Object.entries(map).filter(([role, bone]) => !roles.has(role) || !known.has(bone)).map(([role]) => role);
}

// --- edits -------------------------------------------------------------------------------------------------------------

/** Map `role` to `bone` (null: unmap it). Refused for a role the profile lacks, a bone the skeleton lacks, or a bone another role has. */
export function setBone(a: ModelAnimationSettings, profile: SkeletonProfile, bones: readonly string[], role: string, bone: string | null): EditResult<ModelAnimationSettings> {
  if (!profile.roles.some((r) => r.name === role)) return refuse(`"${role}" isn't a role of ${profile.name || "the profile"}.`);
  if (bone === null || bone === "") return a.boneMap[role] === undefined ? accept(a) : accept(replace(a, { boneMap: without(a.boneMap, role) }));
  if (!bones.includes(bone)) return refuse(`the skeleton has no bone "${bone}".`);
  const other = Object.entries(a.boneMap).find(([r, b]) => b === bone && r !== role);
  if (other) return refuse(`"${bone}" is already the ${other[0]}; unmap that role first.`);
  if (a.boneMap[role] === bone) return accept(a);
  if (Object.keys(a.boneMap).length >= ANIMATION_IMPORT_LIMITS.boneMap && a.boneMap[role] === undefined) return refuse(`a bone map has at most ${ANIMATION_IMPORT_LIMITS.boneMap} entries.`);
  return accept(replace(a, { boneMap: { ...a.boneMap, [role]: bone } }));
}

/** Unmap every role. */
export function clearBoneMap(a: ModelAnimationSettings): EditResult<ModelAnimationSettings> {
  return Object.keys(a.boneMap).length === 0 ? refuse("the bone map is already empty.") : accept(replace(a, { boneMap: {} }));
}

/** Use `map` as the bone map as it stands (a guessed map the model imported with, kept so saving writes it). */
export function keepBoneMap(a: ModelAnimationSettings, map: BoneMap): EditResult<ModelAnimationSettings> {
  return Object.keys(map).length === 0 ? refuse("there is no bone map to keep.") : accept(replace(a, { boneMap: { ...map } }));
}

/**
 * Fill the roles with no bone from `guessed` (the core's guess; roles the profile lacks and bones the skeleton lacks or
 * another role has are skipped). Refused when it guessed nothing, or nothing it guessed fits a free role.
 */
export function applyGuess(a: ModelAnimationSettings, profile: SkeletonProfile, bones: readonly string[], guessed: BoneMap | null): EditResult<ModelAnimationSettings> {
  if (guessed === null) return refuse("the animation core couldn't guess a bone map here (it needs a browser with SIMD, and the Animation plugin on).");
  const roles = new Set(profile.roles.map((r) => r.name));
  const known = new Set(bones);
  const used = new Set(Object.values(a.boneMap));
  const next: Record<string, string> = { ...a.boneMap };
  let added = 0;
  for (const [role, bone] of Object.entries(guessed)) {
    if (next[role] !== undefined || !roles.has(role) || !known.has(bone) || used.has(bone)) continue;
    next[role] = bone;
    used.add(bone);
    added++;
  }
  return added === 0 ? refuse(Object.keys(guessed).length === 0 ? "the core found no bones that fit the profile's roles." : "nothing the core guessed fits a role without a bone.") : accept(replace(a, { boneMap: next }));
}

/** Which side a role is on: by a Left/Right word or L/R letter in its name, else the first of the pair in the profile's order is the left. */
function roleSide(name: string, index: number, partnerIndex: number): "Left" | "Right" {
  if (/left/i.test(name) || /(^|[^A-Za-z])L(?=[^A-Za-z]|$)/.test(name)) return "Left";
  if (/right/i.test(name) || /(^|[^A-Za-z])R(?=[^A-Za-z]|$)/.test(name)) return "Right";
  return index < partnerIndex ? "Left" : "Right";
}

/**
 * Copy one side's bones to the other side: for each role of `from` (`Left` roles for "left-to-right") whose mirror partner
 * has no bone, the partner gets the bone with the side swapped in its name, when the skeleton has it and no role has it
 * yet. Refused when nothing copies, saying why.
 */
export function mirrorBoneMap(a: ModelAnimationSettings, profile: SkeletonProfile, bones: readonly string[], direction: "left-to-right" | "right-to-left"): EditResult<ModelAnimationSettings> {
  const to = direction === "left-to-right" ? "Right" : "Left";
  const source = direction === "left-to-right" ? "Left" : "Right";
  const known = new Set(bones);
  const used = new Set(Object.values(a.boneMap));
  const next: Record<string, string> = { ...a.boneMap };
  let pairs = 0;
  let mapped = 0;
  profile.roles.forEach((role, i) => {
    if (role.mirror === role.name || roleSide(role.name, i, profile.roles.findIndex((r) => r.name === role.mirror)) !== source) return;
    pairs++;
    const bone = a.boneMap[role.name];
    if (bone === undefined) return;
    mapped++;
    if (next[role.mirror] !== undefined) return;
    const partner = sideSwapped(bone, to);
    if (partner === null || partner === bone || !known.has(partner) || used.has(partner)) return;
    next[role.mirror] = partner;
    used.add(partner);
  });
  if (pairs === 0) return refuse(`${profile.name || "the profile"} has no ${source.toLowerCase()} roles with a mirror partner.`);
  if (mapped === 0) return refuse(`no ${source.toLowerCase()} role has a bone to copy.`);
  if (Object.keys(next).length === Object.keys(a.boneMap).length) return refuse(`no ${to.toLowerCase()} role without a bone has a matching bone (a name with its side swapped) in the skeleton.`);
  return accept(replace(a, { boneMap: next }));
}

/**
 * Use another profile (`ref`: a `*.skelprofile.json` reference, or null for the built-in Humanoid), whose roles are
 * `next`. Entries for roles the new profile lacks are dropped. Refused for a profile with no roles.
 */
export function setProfile(a: ModelAnimationSettings, ref: string | null, next: SkeletonProfile): EditResult<ModelAnimationSettings> {
  if (next.roles.length === 0) return refuse("that profile has no roles.");
  if ((a.profile ?? null) === ref) return accept(a);
  const roles = new Set(next.roles.map((r) => r.name));
  return accept(replace(a, { profile: ref, boneMap: Object.fromEntries(Object.entries(a.boneMap).filter(([role]) => roles.has(role))) }));
}

// --- the guess ---------------------------------------------------------------------------------------------------------

/**
 * The core's guess for `skeleton` under `profile` (null: the Humanoid), through the engine's installed guesser; null when
 * there is none (the Animation plugin is off) or the core can't run here. Never rejects.
 */
export async function guessFor(skeleton: ImportedSkeleton, profile: SkeletonProfile | null, guesser = boneMapGuesser()): Promise<BoneMap | null> {
  if (!guesser) return null;
  return guesser(encodeSkeleton(skeleton), skeleton.bones.map((b) => b.name), profile).catch(() => null);
}
