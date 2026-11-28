/**
 * Per-player input profiles (ADR 0337, 0339): the player's changes to the bindings (controls
 * replaced, mappings added, mappings removed) and accessibility settings, applied by the
 * evaluator. Saved with settings (ADR 0024) as `input.<profile>.json`, in format 2.
 *
 * Applying a profile to a context: its mappings minus `removals`, plus `additions` (an added
 * mapping's index is the context's mapping count plus its position among the additions), then
 * `overrides`. Overrides and removals name the action of the mapping they change; one whose
 * mapping no longer targets that action (the game reordered the context) is dropped, with one
 * warning per profile and context.
 */
import type { World } from "../core/World";
import type { InputContextSpec, MappingSpec } from "./contextTypes";
import { withParts } from "./mappingShape";

/** Accessibility settings, per player (Rewired's input behaviours). Action names may be `"set.Id:action"` or bare. */
export interface InputAccessibility {
  /** Button actions that toggle on each press instead of being held. */
  holdToToggle?: string[];
  /** Vector or axis actions whose Y (or value) is flipped: look inversion. */
  invertY?: string[];
  /** Multipliers by action (look sensitivity). */
  sensitivity?: Record<string, number>;
  /** Replaces the stick dead zone (default 0.15) on every mapping that reads a stick or stick axis. */
  deadzone?: number;
  /**
   * Repeat rate: a button action kept triggered (held, past any hold trigger) performs again
   * `delay` seconds after it first performed, then every `interval` seconds while it stays
   * triggered: each repeat sets `performed` for that frame (and tick) and appends a `performed`
   * `ActionEvent`, as a key repeat does, so menus step through items while a direction is held.
   * `actions` limits it to those button actions (bare or `"set.Id:action"` names); without it,
   * every button action repeats. `delay` must be at least 0 and `interval` above 0. At most one
   * repeat per frame.
   */
  repeat?: { delay: number; interval: number; actions?: string[] };
}

/** A mapping the player took out of a context: its index among the context's own mappings, and the action it was for. */
export interface InputProfileRemoval {
  index: number;
  action: string;
}

/** What `input.<profile>.json` holds (format 2; format 1 files are upgraded on load). */
export interface InputProfileData {
  format: 2;
  /** Control replacements: `"<context>/<mapping index>/<action>/<part>"` → control path. Parts: control, up, down, left, right, negative, positive, modifier0… */
  overrides: Record<string, string>;
  /** Mappings the player added, by context, in the context assets' mapping shape. */
  additions: Record<string, MappingSpec[]>;
  /** Mappings the player removed from a context's own mappings, by context. */
  removals: Record<string, InputProfileRemoval[]>;
  accessibility: InputAccessibility;
}

export interface PlayerProfile extends InputProfileData {
  /** Bumped on every change, so compiled tables rebuild. */
  version: number;
  /** Format 1 overrides (`"<context>/<index>/<part>"`) not yet given their action: upgraded as each context is next compiled. */
  legacy: Record<string, string>;
  /** Contexts already warned about stale entries. */
  warned: Set<string>;
}

const perWorld = new WeakMap<World, Map<number, PlayerProfile>>();

/** @internal Player `index`'s profile in `world` (created empty on first use). */
export function profileOf(world: World, index: number): PlayerProfile {
  let m = perWorld.get(world);
  if (!m) perWorld.set(world, (m = new Map()));
  let p = m.get(index);
  if (!p) m.set(index, (p = emptyProfile()));
  return p;
}

/** A profile with no changes. */
function emptyProfile(): PlayerProfile {
  return { format: 2, overrides: {}, additions: {}, removals: {}, accessibility: {}, version: 0, legacy: {}, warned: new Set() };
}

/** The key of one control of one mapping in `overrides`. */
function overrideKey(context: string, mapping: number, action: string, part: string): string {
  return `${context}/${mapping}/${action}/${part}`;
}

/** An override key's fields, read from the right (a context's name may hold a slash); null if it isn't one. */
function parseKey(key: string): { context: string; index: number; action: string; part: string } | null {
  const parts = key.split("/");
  if (parts.length < 4) return null;
  const part = parts.pop()!;
  const action = parts.pop()!;
  const index = Number(parts.pop());
  if (!Number.isInteger(index) || index < 0 || !action || !part) return null;
  return { context: parts.join("/"), index, action, part };
}

/** A format 1 key: `"<context>/<index>/<part>"`. */
function parseLegacyKey(key: string): { context: string; index: number; part: string } | null {
  const parts = key.split("/");
  if (parts.length < 3) return null;
  const part = parts.pop()!;
  const index = Number(parts.pop());
  if (!Number.isInteger(index) || index < 0 || !part) return null;
  return { context: parts.join("/"), index, part };
}

/** One mapping of a context with a profile applied. */
export interface ProfileMapping {
  /** The mapping, its controls replaced by the profile's overrides. */
  readonly spec: MappingSpec;
  /** Its index: in the context's own mappings, or after them for an added one. */
  readonly index: number;
  /** Its position among the context's additions, or -1 for one of the context's own. */
  readonly addition: number;
}

/**
 * @internal A context's mappings with a profile applied: its own minus the removals, plus the
 * additions, with the overrides' controls. Format 1 overrides for the context are given their
 * action first. Overrides and removals whose mapping no longer targets their action are dropped
 * from the profile, with one warning per profile and context. `sameAction` says whether two
 * action names name the same action.
 */
export function profileMappings(spec: InputContextSpec, profile: PlayerProfile, sameAction: (a: string, b: string) => boolean): ProfileMapping[] {
  const ctx = spec.name;
  const own = spec.mappings;
  upgradeLegacy(ctx, own, profile);
  const all: ProfileMapping[] = [...own.map((m, index) => ({ spec: m, index, addition: -1 })), ...(profile.additions[ctx] ?? []).map((m, k) => ({ spec: m, index: own.length + k, addition: k }))];
  const stale: string[] = [];
  const removed = new Set<number>();
  const removals = profile.removals[ctx];
  if (removals) {
    const kept = removals.filter((r) => {
      const ok = r.index < own.length && sameAction(own[r.index].action, r.action);
      if (ok) removed.add(r.index);
      else stale.push(r.action);
      return ok;
    });
    if (kept.length === 0) delete profile.removals[ctx];
    else if (kept.length !== removals.length) profile.removals[ctx] = kept;
  }
  const replaced = new Map<number, Record<string, string>>();
  for (const [key, path] of Object.entries(profile.overrides)) {
    const k = parseKey(key);
    if (!k || k.context !== ctx) continue;
    const m = all[k.index];
    if (!m || !sameAction(m.spec.action, k.action)) {
      stale.push(k.action);
      delete profile.overrides[key];
      continue;
    }
    let parts = replaced.get(k.index);
    if (!parts) replaced.set(k.index, (parts = {}));
    parts[k.part] = path;
  }
  if (stale.length && !profile.warned.has(ctx)) {
    profile.warned.add(ctx);
    const name = stale[0].slice(stale[0].lastIndexOf(":") + 1);
    console.warn(`[myco] Saved binding for "${name}" in "${ctx}" no longer matches the context; it was reset.`);
  }
  return all.filter((m) => !removed.has(m.index)).map((m) => (replaced.has(m.index) ? { ...m, spec: withParts(m.spec, replaced.get(m.index)!) } : m));
}

/** Give a context's format 1 overrides the action of the mapping now at their index (those past its end are dropped). */
function upgradeLegacy(ctx: string, own: readonly MappingSpec[], profile: PlayerProfile): void {
  for (const [key, path] of Object.entries(profile.legacy)) {
    const k = parseLegacyKey(key);
    if (!k || k.context !== ctx) continue;
    delete profile.legacy[key];
    if (k.index < own.length) profile.overrides[overrideKey(ctx, k.index, own[k.index].action, k.part)] = path;
  }
}

/** Which mapping of a context a change is for: its index, its position among the additions (-1: the context's own) and its action as the mapping names it. */
export interface MappingRef {
  readonly index: number;
  readonly addition: number;
  readonly action: string;
}

/** @internal Replace controls of a mapping: an added mapping is changed in place, one of the context's own gets overrides. */
export function setControls(profile: PlayerProfile, ctx: string, m: MappingRef, parts: Readonly<Record<string, string>>): void {
  const added = profile.additions[ctx];
  if (m.addition >= 0 && added?.[m.addition]) added[m.addition] = withParts(added[m.addition], parts);
  else for (const [part, path] of Object.entries(parts)) profile.overrides[overrideKey(ctx, m.index, m.action, part)] = path;
  profile.version++;
}

/** @internal Add a mapping to a context; returns its index (the context's own mapping count plus its position among the additions). */
export function addMapping(profile: PlayerProfile, ctx: string, ownCount: number, spec: MappingSpec): number {
  const list = (profile.additions[ctx] ??= []);
  list.push(spec);
  profile.version++;
  return ownCount + list.length - 1;
}

/** @internal Put `spec` in place of an added mapping (same index), dropping overrides of it. */
export function replaceAddition(profile: PlayerProfile, ctx: string, m: MappingRef, spec: MappingSpec): void {
  dropOverrides(profile, ctx, m.index);
  const list = profile.additions[ctx];
  if (list && m.addition >= 0 && m.addition < list.length) list[m.addition] = spec;
  profile.version++;
}

function dropOverrides(profile: PlayerProfile, ctx: string, index: number): void {
  for (const key of Object.keys(profile.overrides)) {
    const k = parseKey(key);
    if (k?.context === ctx && k.index === index) delete profile.overrides[key];
  }
}

/**
 * @internal Take a mapping out of a context: an added one is deleted (the overrides of later
 * additions move down with them), one of the context's own is recorded in `removals`. Either
 * way its overrides go.
 */
export function removeMapping(profile: PlayerProfile, ctx: string, m: MappingRef): void {
  dropOverrides(profile, ctx, m.index);
  if (m.addition >= 0) {
    const list = profile.additions[ctx];
    if (list) {
      list.splice(m.addition, 1);
      if (!list.length) delete profile.additions[ctx];
      const moved: Record<string, string> = {};
      for (const [key, path] of Object.entries(profile.overrides)) {
        const k = parseKey(key);
        if (k?.context !== ctx || k.index <= m.index) continue;
        delete profile.overrides[key];
        moved[overrideKey(ctx, k.index - 1, k.action, k.part)] = path;
      }
      Object.assign(profile.overrides, moved);
    }
  } else (profile.removals[ctx] ??= []).push({ index: m.index, action: m.action });
  profile.version++;
}

/** @internal Drop every binding change (overrides, additions, removals). */
export function clearBindings(profile: PlayerProfile): void {
  profile.overrides = {};
  profile.additions = {};
  profile.removals = {};
  profile.legacy = {};
  profile.warned.clear();
  profile.version++;
}

/** @internal What `saveBindings` writes: format 2, copied. */
export function profileData(profile: PlayerProfile): InputProfileData {
  return {
    format: 2,
    overrides: { ...profile.overrides },
    additions: Object.fromEntries(Object.entries(profile.additions).map(([ctx, list]) => [ctx, list.map((m) => structuredClone(m) as MappingSpec)])),
    removals: Object.fromEntries(Object.entries(profile.removals).map(([ctx, list]) => [ctx, list.map((r) => ({ ...r }))])),
    accessibility: structuredClone(profile.accessibility),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * @internal Read a saved profile into `profile`. Format 1 overrides are kept aside and given
 * their action as each context is next compiled; entries of the wrong shape are skipped.
 */
export function readProfile(profile: PlayerProfile, data: Record<string, unknown>): void {
  const strings = (v: unknown): Record<string, string> => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {});
  const overrides = strings(data.overrides);
  const legacy = data.format === 1 || data.format === undefined;
  profile.overrides = legacy ? {} : overrides;
  profile.legacy = legacy ? overrides : {};
  profile.additions = {};
  profile.removals = {};
  if (!legacy) {
    for (const [ctx, list] of Object.entries(isRecord(data.additions) ? data.additions : {})) {
      const kept = Array.isArray(list) ? list.filter((m): m is MappingSpec => isRecord(m) && typeof m.action === "string").map((m) => structuredClone(m)) : [];
      if (kept.length) profile.additions[ctx] = kept;
    }
    for (const [ctx, list] of Object.entries(isRecord(data.removals) ? data.removals : {})) {
      const kept = Array.isArray(list) ? list.filter((r): r is InputProfileRemoval => isRecord(r) && Number.isInteger(r.index) && (r.index as number) >= 0 && typeof r.action === "string").map((r) => ({ index: r.index, action: r.action })) : [];
      if (kept.length) profile.removals[ctx] = kept;
    }
  }
  profile.accessibility = isRecord(data.accessibility) ? ({ ...data.accessibility } as InputAccessibility) : {};
  profile.warned.clear();
  profile.version++;
}
