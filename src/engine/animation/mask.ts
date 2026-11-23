/**
 * Avatar masks (ADR 0371 "Assets", 0372 "layered blend by mask"): parse and write `*.mask.json`, format `myco.mask@1`.
 * A mask is a bone set with weights, or a set of profile roles (so one mask fits every skeleton mapped to the profile).
 *
 * ```jsonc
 * {
 *   "format": "myco.mask@1",
 *   "profile": "asset:rigs/humanoid.skelprofile.json",  // default none; needed by role entries ("" or absent: the built-in Humanoid)
 *   "entries": [
 *     { "bone": "Spine2", "weight": 1 },                 // weight 0..1 (default 1)
 *     { "role": "LeftUpperArm", "weight": 0.5, "recursive": false }   // recursive (default true): the bone's descendants too
 *   ]
 * }
 * ```
 *
 * - Each entry names exactly one of `bone` or `role`; a bone or role appears once (a repeat is dropped with a problem).
 * - A deeper entry overrides what a recursive ancestor gave (Unreal's per-branch blend masks); bones no entry reaches
 *   have weight 0.
 * - Limits (`MASK_LIMITS`), declared once.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { compact, isRecord, jsonText, LenientReader, limited, readRef, readRoot, referencePaths, withPath, type FormatParse, type JsonRecord } from "./shared";

/** @internal The format name. */
export const MASK_FORMAT = "myco.mask@1";
/** @internal The file ending. */
export const MASK_SUFFIX = ".mask.json";

/** @internal Limits of a mask, declared once (ADR 0306). */
export const MASK_LIMITS = Object.freeze({
  /** Entries of one mask (a skeleton's bones are u16 indices). */
  entries: 4096,
});

/** @internal One mask entry: a bone or a profile role, with its weight. */
export type MaskEntry = { readonly bone: string; readonly role?: undefined; readonly weight: number; readonly recursive: boolean } | { readonly role: string; readonly bone?: undefined; readonly weight: number; readonly recursive: boolean };

/** @internal A mask. */
export interface AvatarMask {
  readonly format: typeof MASK_FORMAT;
  /** The skeleton profile role entries name, or null (the built-in Humanoid). */
  readonly profile: string | null;
  readonly entries: readonly MaskEntry[];
}

/** @internal A new, empty mask (weight 0 everywhere). */
export const emptyMask = (): AvatarMask => ({ format: MASK_FORMAT, profile: null, entries: [] });

/** @internal A `*.mask.json` value, leniently: never throws; problem lines start with `path` when given. */
export function parseMask(raw: unknown, path?: string): FormatParse<AvatarMask> {
  const problems: string[] = [];
  const o = readRoot(raw, MASK_FORMAT, "a mask", problems);
  const r = new LenientReader(problems);
  const seen = new Set<string>();
  const entries: MaskEntry[] = [];
  limited(r, o.entries, "entries", MASK_LIMITS.entries, "entries").forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!isRecord(e)) return r.problem(at, "an entry must be an object; dropped.");
    const bone = typeof e.bone === "string" && e.bone !== "" ? e.bone : null;
    const role = typeof e.role === "string" && e.role !== "" ? e.role : null;
    if ((bone === null) === (role === null)) return r.problem(at, "an entry names exactly one of bone or role; dropped.");
    const key = bone !== null ? `b:${bone}` : `r:${role}`;
    if (seen.has(key)) return r.problem(at, `${bone !== null ? `bone "${bone}"` : `role "${role}"`} is already in the mask; dropped.`);
    seen.add(key);
    const weight = r.num(e.weight, `${at}.weight`, 1, 0, 1);
    const recursive = r.bool(e.recursive, `${at}.recursive`, true);
    entries.push(bone !== null ? { bone, weight, recursive } : { role: role!, weight, recursive });
  });
  return { value: { format: MASK_FORMAT, profile: readRef(r, o.profile, "profile"), entries }, problems: withPath(problems, path) };
}

/** @internal A mask as canonical JSON (defaults left out). */
export const maskToJson = (m: AvatarMask): JsonRecord =>
  compact({
    format: MASK_FORMAT,
    profile: m.profile ?? undefined,
    entries: m.entries.map((e) => compact({ bone: e.bone, role: e.role, weight: e.weight === 1 ? undefined : e.weight, recursive: e.recursive ? undefined : false })),
  });

/** @internal A mask's file text. */
export const formatMask = (m: AvatarMask): string => jsonText(maskToJson(m));

/** @internal The project files a mask names (its profile). */
export const maskReferences = (m: AvatarMask): string[] => referencePaths([m.profile]);
