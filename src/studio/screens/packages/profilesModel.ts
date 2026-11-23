// The Packages screen's Profiles and rules tab (ADR 0351 §2, §6, §8): `audio.json`'s `encoding` section edited — profiles
// (Wwise's Conversion Settings ShareSets) with their keys for every platform or one, the default profile, the folder rules
// (first match wins) with a preview of which files each catches, and the budgets per platform. Every edit returns
// `{ next } | { refused }` over `audio.json`'s value; the screen applies it as one undo step of the document. A profile
// rename also rewrites the rules and the default here, and sidecars that name it through `profileRenameEdit`. Pure.
import { defaultEncodingConfig, isEmptyEncodingConfig } from "../../../engine/audio/encoding/format";
import { ENCODING_LIMITS, ENCODING_PLATFORMS } from "../../../engine/audio/encoding/defaults";
import { compileGlob } from "../../../engine/audio/encoding/pathGlob";
import { withEncodingKey } from "../../../engine/audio/encoding/resolve";
import { ENCODING_KEYS, type AudioBudget, type EncodingConfig, type EncodingKey, type EncodingProfile, type EncodingSettings } from "../../../engine/audio/encoding/types";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { ProjectFileEdit } from "../../../editor/projectFileEdits";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { AUDIO_FILE } from "../../../export/audio";
import { isRecord } from "../../jsonObjects";

export const configOfDoc = (p: Pick<AudioProject, "encoding">): EncodingConfig => p.encoding ?? defaultEncodingConfig();

const withConfig = (p: AudioProject, config: EncodingConfig): AudioProject => {
  const next = { ...p };
  if (isEmptyEncodingConfig(config)) delete next.encoding;
  else next.encoding = config;
  return next;
};

/** Why `name` can't name a profile (given the others), or null. The parse's own rules (`encoding/format.ts`). */
export function whyNotProfileName(name: string, others: readonly string[]): string | null {
  if (name.trim() === "") return "a profile name can't be empty";
  if (name !== name.trim()) return "a profile name can't start or end with a space";
  if (name === "__proto__") return 'a profile can\'t be named "__proto__"';
  if (others.includes(name)) return `there's already a profile named "${name}"`;
  return null;
}

/** A name for a new profile: `base`, else `base 2`… */
export function freshProfileName(config: EncodingConfig, base = "Profile"): string {
  if (!Object.hasOwn(config.profiles, base)) return base;
  for (let n = 2; ; n++) if (!Object.hasOwn(config.profiles, `${base} ${n}`)) return `${base} ${n}`;
}

export function addProfile(p: AudioProject, name = freshProfileName(configOfDoc(p))): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (Object.keys(c.profiles).length >= ENCODING_LIMITS.profiles) return { refused: `a project has at most ${ENCODING_LIMITS.profiles} profiles` };
  const why = whyNotProfileName(name, Object.keys(c.profiles));
  if (why) return { refused: why };
  return { next: withConfig(p, { ...c, profiles: { ...c.profiles, [name]: {} } }) };
}

/** Rename a profile in place (its order kept), with the rules and the default that name it. */
export function renameProfile(p: AudioProject, from: string, to: string): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (!Object.hasOwn(c.profiles, from)) return { refused: `there's no profile named "${from}"` };
  if (from === to) return { next: p };
  const why = whyNotProfileName(to, Object.keys(c.profiles).filter((n) => n !== from));
  if (why) return { refused: why };
  const profiles = Object.fromEntries(Object.entries(c.profiles).map(([n, v]) => [n === from ? to : n, v]));
  return {
    next: withConfig(p, {
      ...c,
      profiles,
      default: c.default === from ? to : c.default,
      rules: c.rules.map((r) => (r.profile === from ? { ...r, profile: to } : r)),
    }),
  };
}

/** What in `audio.json` names a profile: the default and the rules (for a delete's refusal). */
export function profileUsers(config: EncodingConfig, name: string): string[] {
  const out: string[] = [];
  if (config.default === name) out.push("the default");
  config.rules.forEach((r) => r.profile === name && out.push(`rule ${r.path}`));
  return out;
}

export function deleteProfile(p: AudioProject, name: string): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (!Object.hasOwn(c.profiles, name)) return { refused: `there's no profile named "${name}"` };
  const users = profileUsers(c, name);
  if (users.length > 0) return { refused: `${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it; change ${users.length === 1 ? "that" : "those"} first` };
  const profiles = { ...c.profiles };
  delete profiles[name];
  return { next: withConfig(p, { ...c, profiles }) };
}

export function setDefaultProfile(p: AudioProject, name: string | null): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (name !== null && !Object.hasOwn(c.profiles, name)) return { refused: `there's no profile named "${name}"` };
  if (c.default === name) return { next: p };
  return { next: withConfig(p, { ...c, default: name }) };
}

/** Set (or with undefined, clear) one key of profile `name`, for every platform (null) or one. */
export function setProfileKey<K extends EncodingKey>(p: AudioProject, name: string, platform: ImportPlatform | null, key: K, value: EncodingSettings[K] | undefined): EditResult<AudioProject> {
  const c = configOfDoc(p);
  const profile = c.profiles[name];
  if (!Object.hasOwn(c.profiles, name) || !profile) return { refused: `there's no profile named "${name}"` };
  let v = value;
  if (key === "quality" && v !== undefined) v = (Math.round(Math.min(1, Math.max(0, v as number)) * 100) / 100) as EncodingSettings[K];
  if (key === "prefetchMs" && v !== undefined) v = Math.round(Math.min(2000, Math.max(0, v as number))) as EncodingSettings[K];
  const next = (withEncodingKey(profile, platform, key, v) ?? {}) as EncodingProfile;
  return { next: withConfig(p, { ...c, profiles: { ...c.profiles, [name]: next } }) };
}

/** One key of a profile as the tab shows it on a platform: its own value there, its base value, or inherited. */
export interface ProfileKeyRow {
  readonly key: EncodingKey;
  /** The value the profile gives on the platform (its platform value, else its base), or undefined: it leaves it to the next layer. */
  readonly value: EncodingSettings[EncodingKey] | undefined;
  /** Set for this platform (not only for every platform). */
  readonly platformValue: boolean;
}

export function profileKeyRows(profile: EncodingProfile, platform: ImportPlatform): ProfileKeyRow[] {
  return ENCODING_KEYS.map((key) => {
    const own = profile.platforms?.[platform]?.[key];
    return { key, value: own ?? profile[key], platformValue: own !== undefined };
  });
}

// --- rules ------------------------------------------------------------------------------------------------------------

const withRules = (p: AudioProject, c: EncodingConfig, rules: EncodingConfig["rules"]) => withConfig(p, { ...c, rules });

export function addRule(p: AudioProject, path: string, profile: string): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (c.rules.length >= ENCODING_LIMITS.rules) return { refused: `a project has at most ${ENCODING_LIMITS.rules} rules` };
  if (path.trim() === "") return { refused: "a rule needs a path or glob" };
  if (!Object.hasOwn(c.profiles, profile)) return { refused: `there's no profile named "${profile}"` };
  return { next: withRules(p, c, [...c.rules, { path: path.trim(), profile }]) };
}

export function updateRule(p: AudioProject, index: number, patch: { path?: string; profile?: string }): EditResult<AudioProject> {
  const c = configOfDoc(p);
  const r = c.rules[index];
  if (!r) return { refused: "there's no such rule" };
  if (patch.path !== undefined && patch.path.trim() === "") return { refused: "a rule needs a path or glob" };
  if (patch.profile !== undefined && !Object.hasOwn(c.profiles, patch.profile)) return { refused: `there's no profile named "${patch.profile}"` };
  const next = { path: patch.path?.trim() ?? r.path, profile: patch.profile ?? r.profile };
  if (next.path === r.path && next.profile === r.profile) return { next: p };
  return { next: withRules(p, c, c.rules.map((x, i) => (i === index ? next : x))) };
}

/** Move rule `index` by `delta` places (first match wins, so order matters). */
export function moveRule(p: AudioProject, index: number, delta: number): EditResult<AudioProject> {
  const c = configOfDoc(p);
  const to = index + delta;
  if (!c.rules[index]) return { refused: "there's no such rule" };
  if (to < 0 || to >= c.rules.length) return { refused: delta < 0 ? "it's already the first rule" : "it's already the last rule" };
  const rules = [...c.rules];
  const [r] = rules.splice(index, 1);
  rules.splice(to, 0, r!);
  return { next: withRules(p, c, rules) };
}

export function removeRule(p: AudioProject, index: number): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (!c.rules[index]) return { refused: "there's no such rule" };
  return { next: withRules(p, c, c.rules.filter((_, i) => i !== index)) };
}

/** What one rule catches among the project's audio files. */
export interface RulePreview {
  readonly index: number;
  /** Audio files it applies to (it is their first matching rule), sorted. */
  readonly catches: readonly string[];
  /** Audio files it matches that an earlier rule took. */
  readonly shadowed: number;
}

export function rulePreview(config: EncodingConfig, files: readonly string[]): RulePreview[] {
  const audio = files.filter((f) => AUDIO_FILE.test(f)).sort();
  const taken = new Set<string>();
  return config.rules.map((r, index) => {
    const g = compileGlob(r.path);
    const catches: string[] = [];
    let shadowed = 0;
    for (const f of audio) {
      if (!g.matches(f)) continue;
      if (taken.has(f)) shadowed++;
      else (taken.add(f), catches.push(f));
    }
    return { index, catches, shadowed };
  });
}

// --- budgets ----------------------------------------------------------------------------------------------------------

/** Set (or with null, clear) a platform's budget, MB (a tripwire: warnings, never failures). */
export function setBudget(p: AudioProject, platform: ImportPlatform, key: keyof AudioBudget, mb: number | null): EditResult<AudioProject> {
  const c = configOfDoc(p);
  if (mb !== null && !(Number.isFinite(mb) && mb >= ENCODING_LIMITS.budgetMB[0] && mb <= ENCODING_LIMITS.budgetMB[1])) return { refused: `a budget is a number of MB from ${ENCODING_LIMITS.budgetMB[0]} to ${ENCODING_LIMITS.budgetMB[1]}` };
  const b: AudioBudget = { ...c.budgets[platform] };
  if (mb === null) delete b[key];
  else b[key] = mb;
  const budgets = { ...c.budgets };
  if (Object.keys(b).length > 0) budgets[platform] = b;
  else delete budgets[platform];
  return { next: withConfig(p, { ...c, budgets }) };
}

/** Platforms in their fixed order. */
export const PLATFORMS: readonly ImportPlatform[] = ENCODING_PLATFORMS;

/** The project-wide edit renaming profile `from` to `to` in sidecars' (`*.meta.json`) and derived samples' `encoding.profile`. */
export function profileRenameEdit(from: string, to: string): ProjectFileEdit {
  const rename = (json: unknown): unknown => {
    if (!isRecord(json) || !isRecord(json.encoding) || json.encoding.profile !== from) return json;
    return { ...json, encoding: { ...json.encoding, profile: to } };
  };
  return {
    mentioned: (text) => text.includes('"encoding"') && text.includes(JSON.stringify(from)),
    scene: () => null,
    settings: () => null,
    json: (json, path) => {
      if (!path.endsWith(".meta.json") && !path.toLowerCase().endsWith(".sample.json")) return null;
      const next = rename(json);
      return next === json ? null : next;
    },
  };
}
