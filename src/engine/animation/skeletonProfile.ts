/**
 * Skeleton profiles (ADR 0371 "Assets", 0372 "Retargeting"): parse and write `*.skelprofile.json`, format
 * `myco.skelprofile@1`, and encode one into the core's `MYCOPROF` bytes (`anim-retarget`'s `encode.rs`), so the
 * runtime passes a custom profile to `profile_decode`. The model mirrors `anim-retarget`'s `Profile`.
 *
 * ```jsonc
 * {
 *   "format": "myco.skelprofile@1",
 *   "name": "Quadruped",                      // default ""
 *   "roles": [                                // 1..1024, unique names (1..255 UTF-8 bytes)
 *     { "name": "Hips", "required": true },
 *     { "name": "LeftFrontLeg", "mirror": "RightFrontLeg",   // the left/right counterpart (default: itself, a centre role)
 *       "flip": "x",                          // mirror correction: none, x, y, z, or auto (default: derived from the rest pose)
 *       "range": { "swingY": 60, "swingZ": 30, "twistMin": -20, "twistMax": 20 } },   // joint range, degrees (default: free)
 *     { "name": "RightFrontLeg", "mirror": "LeftFrontLeg" }
 *   ],
 *   "chains": [                               // 0..1024, run in this order (twists last)
 *     { "name": "FrontLegs", "kind": "leg", "roles": ["LeftFrontLeg", "RightFrontLeg"], "ik": false }
 *   ],
 *   "root": "Root",                           // the root-motion role (default none)
 *   "hips": "Hips"                            // the retarget root (default none); not the same role as root
 * }
 * ```
 *
 * The parse makes every `Profile::validate` rule hold (each fix one problem): the mirror map is an involution (a role
 * whose counterpart doesn't point back becomes a centre role), ranges are in range (swings 0..180, twists -180..180,
 * min ≤ max), chain roles exist and are distinct, IK chains have three roles, root and hips differ. A profile with no
 * roles is kept with a problem, and the encoder refuses it.
 *
 * Pure; no plugin, no DOM. Internal: not public API.
 */
import { compact, isFiniteNumber, isRecord, jsonText, LenientReader, limited, readRoot, utf8Length, withPath, type FormatParse, type JsonRecord } from "./shared";

/** @internal The format name. */
export const SKELETON_PROFILE_FORMAT = "myco.skelprofile@1";
/** @internal The file ending. */
export const SKELETON_PROFILE_SUFFIX = ".skelprofile.json";

/** @internal Limits of a profile, declared once (ADR 0306): `anim-retarget`'s `MAX_ROLES`, `MAX_CHAINS`, `MAX_NAME`. */
export const SKELETON_PROFILE_LIMITS = Object.freeze({ roles: 1024, chains: 1024, nameBytes: 255 });

/** @internal Chain kinds, in `ChainKind` id order. */
export const CHAIN_KINDS = ["spine", "arm", "leg", "finger", "head", "twist", "custom"] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];
/** @internal Mirror flips: `Flip` ids 0..3, then `auto` (the encoding's `0xFF`). */
export const FLIPS = ["none", "x", "y", "z", "auto"] as const;
export type Flip = (typeof FLIPS)[number];

/** @internal A joint range, degrees (`anim-format`'s `JointRange`). */
export interface JointRange {
  readonly swingY: number;
  readonly swingZ: number;
  readonly twistMin: number;
  readonly twistMax: number;
}
export interface ProfileRole {
  readonly name: string;
  /** The counterpart role's name (the role's own for a centre role). */
  readonly mirror: string;
  readonly flip: Flip;
  readonly range: JointRange | null;
  readonly required: boolean;
}
export interface ProfileChain {
  readonly name: string;
  readonly kind: ChainKind;
  /** Role names, start to end, distinct. */
  readonly roles: readonly string[];
  readonly ik: boolean;
}
/** @internal A skeleton profile. */
export interface SkeletonProfile {
  readonly format: typeof SKELETON_PROFILE_FORMAT;
  readonly name: string;
  readonly roles: readonly ProfileRole[];
  readonly chains: readonly ProfileChain[];
  readonly root: string | null;
  readonly hips: string | null;
}

/** @internal A new profile: one centre role. */
export const emptySkeletonProfile = (): SkeletonProfile => ({
  format: SKELETON_PROFILE_FORMAT, name: "", roles: [{ name: "Root", mirror: "Root", flip: "auto", range: null, required: false }], chains: [], root: null, hips: null,
});

function readRange(r: LenientReader, raw: unknown, where: string): JointRange | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    r.problem(where, "must be { swingY, swingZ, twistMin, twistMax }; the joint is free.");
    return null;
  }
  const swingY = r.num(raw.swingY, `${where}.swingY`, 180, 0, 180);
  const swingZ = r.num(raw.swingZ, `${where}.swingZ`, 180, 0, 180);
  let twistMin = r.num(raw.twistMin, `${where}.twistMin`, -180, -180, 180);
  let twistMax = r.num(raw.twistMax, `${where}.twistMax`, 180, -180, 180);
  if (twistMin > twistMax) {
    r.problem(where, "twistMin was above twistMax; swapped.");
    [twistMin, twistMax] = [twistMax, twistMin];
  }
  return { swingY, swingZ, twistMin, twistMax };
}

function readNameField(r: LenientReader, raw: unknown, where: string, what: string): string | null {
  if (typeof raw !== "string" || raw === "") {
    r.problem(where, `a ${what} must have a name; dropped.`);
    return null;
  }
  if (utf8Length(raw) > SKELETON_PROFILE_LIMITS.nameBytes) {
    r.problem(where, `longer than ${SKELETON_PROFILE_LIMITS.nameBytes} bytes; the ${what} is dropped.`);
    return null;
  }
  return raw;
}

/** @internal A `*.skelprofile.json` value, leniently: never throws; problem lines start with `path` when given. */
export function parseSkeletonProfile(raw: unknown, path?: string): FormatParse<SkeletonProfile> {
  const problems: string[] = [];
  const o = readRoot(raw, SKELETON_PROFILE_FORMAT, "a skeleton profile", problems);
  const r = new LenientReader(problems);
  let name = r.str(o.name, "name", "");
  if (utf8Length(name) > SKELETON_PROFILE_LIMITS.nameBytes) {
    r.problem("name", `longer than ${SKELETON_PROFILE_LIMITS.nameBytes} bytes; using "".`);
    name = "";
  }

  type Draft = { name: string; mirror: string; flip: Flip; range: JointRange | null; required: boolean };
  const roles: Draft[] = [];
  const mirrorRaw: unknown[] = [];
  limited(r, o.roles, "roles", SKELETON_PROFILE_LIMITS.roles, "roles").forEach((x, i) => {
    const at = `roles[${i}]`;
    if (!isRecord(x)) return r.problem(at, "a role must be an object; dropped.");
    const n = readNameField(r, x.name, `${at}.name`, "role");
    if (n === null) return;
    if (roles.some((d) => d.name === n)) return r.problem(`${at}.name`, `role "${n}" is already defined; dropped.`);
    roles.push({ name: n, mirror: n, flip: r.pick(x.flip, `${at}.flip`, FLIPS, "auto"), range: readRange(r, x.range, `${at}.range`), required: r.bool(x.required, `${at}.required`, false) });
    mirrorRaw.push(x.mirror);
  });
  if (roles.length === 0) r.problem("roles", "a profile needs at least one role.");
  const index = new Map(roles.map((d, i) => [d.name, i]));
  roles.forEach((d, i) => {
    const m = mirrorRaw[i];
    if (m === undefined) return;
    if (typeof m !== "string" || !index.has(m)) r.problem(`roles[${i}].mirror`, `${JSON.stringify(m)} isn't a role; "${d.name}" is a centre role.`);
    else d.mirror = m;
  });
  // The involution rule: a role whose counterpart doesn't name it back becomes a centre role. One pass suffices: a role
  // that pointed at one fixed here already failed the rule itself.
  roles.forEach((d) => {
    const partner = roles[index.get(d.mirror)!];
    if (partner.mirror !== d.name) {
      r.problem(`roles`, `"${d.name}" mirrors "${d.mirror}", which mirrors "${partner.mirror}"; "${d.name}" is a centre role.`);
      d.mirror = d.name;
    }
  });

  const chains: ProfileChain[] = [];
  limited(r, o.chains, "chains", SKELETON_PROFILE_LIMITS.chains, "chains").forEach((x, i) => {
    const at = `chains[${i}]`;
    if (!isRecord(x)) return r.problem(at, "a chain must be an object; dropped.");
    const n = readNameField(r, x.name, `${at}.name`, "chain");
    if (n === null) return;
    if (chains.some((c) => c.name === n)) return r.problem(`${at}.name`, `chain "${n}" is already defined; dropped.`);
    if (x.kind === undefined) r.problem(`${at}.kind`, `missing; using "custom".`);
    const kind = r.pick(x.kind, `${at}.kind`, CHAIN_KINDS, "custom");
    const list: string[] = [];
    r.list(x.roles, `${at}.roles`).forEach((role, k) => {
      if (typeof role !== "string" || !index.has(role)) r.problem(`${at}.roles[${k}]`, `${JSON.stringify(role)} isn't a role; dropped.`);
      else if (list.includes(role)) r.problem(`${at}.roles[${k}]`, `"${role}" is already in the chain; dropped.`);
      else list.push(role);
    });
    if (list.length === 0) return r.problem(at, "a chain needs at least one role; dropped.");
    let ik = r.bool(x.ik, `${at}.ik`, false);
    if (ik && list.length < 3) {
      r.problem(`${at}.ik`, "an IK chain needs three roles; IK is off.");
      ik = false;
    }
    chains.push({ name: n, kind, roles: list, ik });
  });

  const roleRef = (raw: unknown, where: string): string | null => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || !index.has(raw)) {
      r.problem(where, `${JSON.stringify(raw)} isn't a role; none.`);
      return null;
    }
    return raw;
  };
  const root = roleRef(o.root, "root");
  let hips = roleRef(o.hips, "hips");
  if (root !== null && root === hips) {
    r.problem("hips", "root and hips can't be the same role; hips is none.");
    hips = null;
  }
  return { value: { format: SKELETON_PROFILE_FORMAT, name, roles, chains, root, hips }, problems: withPath(problems, path) };
}

/** @internal A profile as canonical JSON (defaults left out). */
export const skeletonProfileToJson = (p: SkeletonProfile): JsonRecord =>
  compact({
    format: SKELETON_PROFILE_FORMAT,
    name: p.name || undefined,
    roles: p.roles.map((x) => compact({ name: x.name, mirror: x.mirror === x.name ? undefined : x.mirror, flip: x.flip === "auto" ? undefined : x.flip, range: x.range ? { ...x.range } : undefined, required: x.required || undefined })),
    chains: p.chains.map((c) => compact({ name: c.name, kind: c.kind, roles: [...c.roles], ik: c.ik || undefined })),
    root: p.root ?? undefined,
    hips: p.hips ?? undefined,
  });

/** @internal A profile's file text. */
export const formatSkeletonProfile = (p: SkeletonProfile): string => jsonText(skeletonProfileToJson(p));

// --- the core's encoding ----------------------------------------------------------------------------------------------

/** @internal The encoding's magic (`encode.rs`). */
export const PROFILE_MAGIC = "MYCOPROF";
/** @internal The encoding's layout version. */
export const PROFILE_ENCODING_VERSION = 1;
const NO_ROLE = 0xffff;
const FLIP_AUTO = 0xff;
const ROLE_RANGE = 1;
const ROLE_REQUIRED = 2;
const CHAIN_IK = 1;

const rangeValid = (g: JointRange) =>
  [g.swingY, g.swingZ, g.twistMin, g.twistMax].every(isFiniteNumber) && g.swingY >= 0 && g.swingY <= 180 && g.swingZ >= 0 && g.swingZ <= 180 && g.twistMin >= -180 && g.twistMax <= 180 && g.twistMin <= g.twistMax;

/** Why `p` breaks a `Profile::validate` rule, or null. */
function invalid(p: SkeletonProfile): string | null {
  const L = SKELETON_PROFILE_LIMITS;
  if (p.roles.length === 0 || p.roles.length > L.roles) return `a profile has 1..${L.roles} roles (it has ${p.roles.length})`;
  if (p.chains.length > L.chains) return `a profile has at most ${L.chains} chains`;
  if (utf8Length(p.name) > L.nameBytes) return "the profile's name is too long";
  const index = new Map<string, number>();
  for (const role of p.roles) {
    if (role.name === "" || utf8Length(role.name) > L.nameBytes) return `role name "${role.name}" must be 1..${L.nameBytes} bytes`;
    if (index.has(role.name)) return `role "${role.name}" is defined twice`;
    index.set(role.name, index.size);
  }
  for (const role of p.roles) {
    const m = p.roles[index.get(role.mirror) ?? -1];
    if (!m || m.mirror !== role.name) return `the mirror map isn't an involution at "${role.name}"`;
    if (role.range && !rangeValid(role.range)) return `role "${role.name}" has an invalid joint range`;
  }
  const chainNames = new Set<string>();
  for (const c of p.chains) {
    if (c.name === "" || utf8Length(c.name) > L.nameBytes) return `chain name "${c.name}" must be 1..${L.nameBytes} bytes`;
    if (chainNames.has(c.name)) return `chain "${c.name}" is defined twice`;
    chainNames.add(c.name);
    if (c.roles.length === 0) return `chain "${c.name}" is empty`;
    if (c.roles.some((x) => !index.has(x))) return `chain "${c.name}" names a role the profile lacks`;
    if (new Set(c.roles).size !== c.roles.length) return `chain "${c.name}" repeats a role`;
    if (c.ik && c.roles.length < 3) return `IK chain "${c.name}" needs three roles`;
  }
  for (const [what, x] of [["root", p.root], ["hips", p.hips]] as const) if (x !== null && !index.has(x)) return `${what} "${x}" isn't a role`;
  if (p.root !== null && p.root === p.hips) return "root and hips are the same role";
  return null;
}

/**
 * @internal A profile in the core's `MYCOPROF` layout (`anim-retarget/src/encode.rs`), little-endian: magic, u32
 * version, u16 role count, u16 chain count, u16 root and hips roles (`0xFFFF` none), the name (u8 length + UTF-8), then
 * per role its name, u16 mirror, u8 flip (`0xFF` auto), u8 flags (1 range, 2 required) and an optional f32 × 4 range,
 * then per chain its name, u8 kind, u8 flags (1 IK), u16 role count and the u16 roles. A profile that breaks a rule the
 * core checks is refused with the reason, never patched.
 */
export function encodeSkeletonProfile(p: SkeletonProfile): { readonly bytes: Uint8Array } | { readonly problem: string } {
  const why = invalid(p);
  if (why !== null) return { problem: why };
  const enc = new TextEncoder();
  const index = new Map(p.roles.map((x, i) => [x.name, i]));
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const f32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    out.push(...b);
  };
  const name = (s: string) => {
    const b = enc.encode(s);
    u8(b.length);
    out.push(...b);
  };
  for (const c of PROFILE_MAGIC) u8(c.charCodeAt(0));
  u32(PROFILE_ENCODING_VERSION);
  u16(p.roles.length);
  u16(p.chains.length);
  u16(p.root === null ? NO_ROLE : index.get(p.root)!);
  u16(p.hips === null ? NO_ROLE : index.get(p.hips)!);
  name(p.name);
  for (const role of p.roles) {
    name(role.name);
    u16(index.get(role.mirror)!);
    u8(role.flip === "auto" ? FLIP_AUTO : FLIPS.indexOf(role.flip));
    u8((role.range ? ROLE_RANGE : 0) | (role.required ? ROLE_REQUIRED : 0));
    if (role.range) for (const v of [role.range.swingY, role.range.swingZ, role.range.twistMin, role.range.twistMax]) f32(v);
  }
  for (const c of p.chains) {
    name(c.name);
    u8(CHAIN_KINDS.indexOf(c.kind));
    u8(c.ik ? CHAIN_IK : 0);
    u16(c.roles.length);
    for (const x of c.roles) u16(index.get(x)!);
  }
  return { bytes: new Uint8Array(out) };
}
