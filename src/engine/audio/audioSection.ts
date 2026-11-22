/**
 * Internal (ADR 0175, building on 0097 and 0151): the settings draft's `audio` section, parsed once and written back in
 * one place. Since ADR 0330 the section is `audio.json`'s runtime view (`project/format.ts`), which the editor's project
 * section saves back into `audio.json` (decision D2); its shape here is unchanged.
 *
 * - **Parse once.** `audioSection(raw)` is `parseAudioSettings(raw)` — settings, problems and warnings together —
 *   memoised on the identity of `raw` (the draft's `audio` object: a draft edit that leaves the section alone keeps it, an
 *   audio edit makes a new one). The result is deep-frozen, because every caller holding the same draft shares it: build
 *   a changed copy (`{ ...a, voices }`), never write into it. Not for runtime use with `AudioParseOptions` (the Engine
 *   parses with the physics layers itself).
 * - **Write back.** `withLiveKeys(d, next)` writes the keys a live op edits (`LIVE_KEYS`) over the draft's section and
 *   keeps every other key as authored (what `applyOpToDraft` does). `withSettings(d, next)` writes the whole section, with
 *   `occlusion.materials` pruned to the rows that differ from the built-ins (the parse re-adds those, so a later retune
 *   of a built-in reaches projects that never edited it).
 * - **The live keys.** `LIVE_KEYS` is the one list of what a live op edits; every other key that differs between two
 *   sections has no live path (`diffOps`' `restartRequired`).
 *
 * Pure; no plugin, no DOM. The project-settings section machinery (ADR 0151) is unchanged: this is what its audio callers
 * hold instead of re-parsing.
 */
import { BUILTIN_MATERIALS, type OccluderMaterial } from "./occlusionMaterials";
import { parseAudioSettings, type AudioSettings } from "./settings";

/** The parsed `audio` section: what `parseAudioSettings` gives, shared and frozen. */
export interface AudioSection {
  readonly settings: AudioSettings;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/** Anything with an `audio` section (the editor's `SettingsDraft`, a project file). Generic so the engine imports nothing of the editor. */
export interface AudioDraft { audio?: unknown }

/** The `audio` keys a live op edits; every other key that differs is `restartRequired` in `diffOps`. */
export const LIVE_KEYS = ["buses", "snapshots", "ducking", "automation", "loudnessTargets", "loudnessResetOnPlay"] as const;

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const cache = new WeakMap<object, AudioSection>();
let absent: AudioSection | null = null;

/** The section `raw` (a draft's `audio`) parses to, memoised on `raw`'s identity. Frozen: copy to change. */
export function audioSection(raw: unknown): AudioSection {
  if (raw === undefined) return (absent ??= deepFreeze(parseAudioSettings(undefined)));
  if (typeof raw !== "object" || raw === null) return deepFreeze(parseAudioSettings(raw));
  let s = cache.get(raw);
  if (!s) {
    s = deepFreeze(parseAudioSettings(raw));
    cache.set(raw, s);
  }
  return s;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `d` with the live keys of `next` written over its section (absent in `next`: removed); every other key stays as authored. */
export function withLiveKeys<D extends AudioDraft>(d: D, next: AudioSettings): D {
  const audio: Record<string, unknown> = isObj(d.audio) ? { ...d.audio } : {};
  for (const key of LIVE_KEYS) {
    if (next[key] === undefined) delete audio[key];
    else audio[key] = next[key];
  }
  return { ...d, audio };
}

/** Whether two material rows have the same name and numbers. */
export const sameMaterial = (a: OccluderMaterial, b: OccluderMaterial): boolean =>
  a.name === b.name && a.transmissionDb === b.transmissionDb && a.cutoffHz === b.cutoffHz && a.wetOcclusion === b.wetOcclusion && a.attackMs === b.attackMs && a.releaseMs === b.releaseMs;

/** `d` with its whole section replaced by `next`, `occlusion.materials` keeping only the rows that differ from the built-ins. */
export function withSettings<D extends AudioDraft>(d: D, next: AudioSettings): D {
  const materials = next.occlusion.materials.filter((m) => { const b = BUILTIN_MATERIALS.find((x) => x.name === m.name); return !b || !sameMaterial(m, b); });
  return { ...d, audio: { ...next, occlusion: { ...next.occlusion, materials } } };
}
