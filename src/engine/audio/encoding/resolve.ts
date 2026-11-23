/**
 * Internal (ADR 0351 §2, A1): the effective encoding settings of one file on one platform, and where each value came
 * from (the Studio's inheritance display). Each key resolves on its own; the first layer that sets it wins:
 *
 * 1. the file's sidecar `encoding.platforms.<platform>`, then its `encoding`, then its legacy `stream: true` (read as
 *    `load: "stream"`; ADR 0351 "Deprecates");
 * 2. for a derived sample (`*.sample.json`), the same three of its source's sidecar;
 * 3. the profiles, nearest first, each its `platforms.<platform>` then its base:
 *    a. the profile the sidecar names (`encoding.profile`; a derived sample's own, else its source's),
 *    b. the profile of the first folder rule matching the file's path (a derived sample: else its source's path),
 *    c. `encoding.default`;
 *    a profile named twice is consulted once, at its nearest place;
 * 4. the engine's built-in default for the platform (`defaults.ts`).
 *
 * A name that matches no profile is skipped with a problem, so the file falls back to the next profile. Pure.
 */
import type { ImportPlatform } from "../../scene/importSettings";
import { builtinEncoding } from "./defaults";
import { compileGlob } from "./pathGlob";
import {
  ENCODING_KEYS,
  type EncodingConfig, type EncodingKey, type EncodingOrigin, type EncodingResolution, type EncodingSettings, type ProfileVia,
  type ResolvedEncoding, type SidecarEncoding,
} from "./types";

/** One file's own encoding inputs: its project path and its sidecar's (or derived sample's) `encoding` block. */
export interface EncodingFile {
  path: string;
  encoding: SidecarEncoding | null;
  /** The sidecar's legacy `stream: true`. */
  legacyStream?: boolean;
}

/** What to resolve: the shipped file, and for a derived sample its source. */
export interface EncodingSubject extends EncodingFile {
  source?: EncodingFile | null;
}

interface Layer {
  settings: EncodingSettings;
  origin: EncodingOrigin;
}

/** Folder rules compiled once per config. */
const compiled = new WeakMap<EncodingConfig["rules"], ((path: string) => boolean)[]>();
function ruleMatchers(config: EncodingConfig): ((path: string) => boolean)[] {
  let m = compiled.get(config.rules);
  if (!m) {
    m = config.rules.map((r) => {
      const g = compileGlob(r.path);
      return (p: string) => g.matches(p);
    });
    compiled.set(config.rules, m);
  }
  return m;
}

/** The first rule matching `path`, or null. */
function firstRule(config: EncodingConfig, path: string): { index: number; path: string; profile: string } | null {
  const m = ruleMatchers(config);
  for (let i = 0; i < m.length; i++) if (m[i](path)) return { index: i, path: config.rules[i].path, profile: config.rules[i].profile };
  return null;
}

/** The profiles `subject` consults, nearest first (rule 3 of the header), with problems for names that match none. */
function profileChain(subject: EncodingSubject, config: EncodingConfig, problems: string[]): { name: string; via: ProfileVia }[] {
  const out: { name: string; via: ProfileVia }[] = [];
  const add = (name: string, via: ProfileVia, what: string) => {
    if (!Object.hasOwn(config.profiles, name)) {
      problems.push(`${subject.path}: ${what} names profile "${name}", which doesn't exist; falling back past it.`);
      return;
    }
    if (!out.some((p) => p.name === name)) out.push({ name, via });
  };
  const own = subject.encoding?.profile;
  const fromSource = subject.source?.encoding?.profile;
  if (own !== undefined) add(own, { kind: "sidecar", file: subject.path }, "its sidecar");
  else if (fromSource !== undefined && subject.source) add(fromSource, { kind: "sidecar", file: subject.source.path }, "its source's sidecar");
  const rule = firstRule(config, subject.path) ?? (subject.source ? firstRule(config, subject.source.path) : null);
  if (rule) add(rule.profile, { kind: "rule", index: rule.index, path: rule.path }, `rule ${rule.path}`);
  if (config.default !== null) add(config.default, { kind: "default" }, "encoding.default");
  return out;
}

/** A file's own layers: its platform's overrides, its base, its legacy `stream`. */
function fileLayers(file: EncodingFile, platform: ImportPlatform): Layer[] {
  const out: Layer[] = [];
  const p = file.encoding?.platforms?.[platform];
  if (p) out.push({ settings: p, origin: { level: "sidecar", file: file.path, platform } });
  if (file.encoding) out.push({ settings: file.encoding, origin: { level: "sidecar", file: file.path, platform: null } });
  if (file.legacyStream) out.push({ settings: { load: "stream" }, origin: { level: "sidecar", file: file.path, platform: null, legacy: "stream" } });
  return out;
}

/** The effective settings of `subject` on `platform` under `config`, with each value's origin (see the header). */
export function resolveEncoding(subject: EncodingSubject, platform: ImportPlatform, config: EncodingConfig): EncodingResolution {
  const problems: string[] = [];
  const layers: Layer[] = fileLayers(subject, platform);
  if (subject.source) layers.push(...fileLayers(subject.source, platform));
  const profiles = profileChain(subject, config, problems);
  for (const { name, via } of profiles) {
    const profile = config.profiles[name];
    const p = profile.platforms?.[platform];
    if (p) layers.push({ settings: p, origin: { level: "profile", profile: name, platform, via } });
    layers.push({ settings: profile, origin: { level: "profile", profile: name, platform: null, via } });
  }
  const builtin = builtinEncoding(platform);
  const settings = { ...builtin } as Record<EncodingKey, unknown>;
  const origins = {} as Record<EncodingKey, EncodingOrigin>;
  for (const key of ENCODING_KEYS) {
    const hit = layers.find((l) => l.settings[key] !== undefined);
    settings[key] = hit ? hit.settings[key] : builtin[key];
    origins[key] = hit ? hit.origin : { level: "builtin", platform };
  }
  return { settings: settings as ResolvedEncoding, origins, profiles, problems };
}

const PLATFORM_LABELS: Record<ImportPlatform, string> = { web: "Web", desktop: "Desktop", android: "Android" };
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A short label for where a value came from, for the Studio: "this file", "this file · Android", "source
 * step.wav", "Music profile (rule audio/music/**)", "Default profile (default) · Android", "built-in (Web)".
 * `subjectPath` tells the file's own sidecar from its source's.
 */
export function originLabel(origin: EncodingOrigin, subjectPath: string): string {
  const on = (p: ImportPlatform | null) => (p ? ` · ${PLATFORM_LABELS[p]}` : "");
  switch (origin.level) {
    case "sidecar": {
      const who = origin.file === subjectPath ? "this file" : `source ${baseName(origin.file)}`;
      return origin.legacy ? `${who} (stream: true)` : `${who}${on(origin.platform)}`;
    }
    case "profile": {
      const via = origin.via.kind === "rule" ? ` (rule ${origin.via.path})` : origin.via.kind === "default" ? " (default)" : "";
      return `${origin.profile} profile${via}${on(origin.platform)}`;
    }
    case "builtin":
      return `built-in (${PLATFORM_LABELS[origin.platform]})`;
  }
}

/**
 * `encoding` with one key overridden (or cleared, `value` undefined) for every platform (`platform` null) or one.
 * Emptied platform objects and an emptied block are dropped (null: the sidecar writes no `encoding`). Doesn't change
 * `encoding`.
 */
export function withEncodingKey<K extends EncodingKey>(encoding: SidecarEncoding | null, platform: ImportPlatform | null, key: K, value: EncodingSettings[K] | undefined): SidecarEncoding | null {
  const next: SidecarEncoding = { ...encoding, platforms: { ...encoding?.platforms } };
  if (platform === null) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  } else {
    const layer: EncodingSettings = { ...next.platforms?.[platform] };
    if (value === undefined) delete layer[key];
    else layer[key] = value;
    if (Object.keys(layer).length > 0) next.platforms![platform] = layer;
    else delete next.platforms![platform];
  }
  if (Object.keys(next.platforms ?? {}).length === 0) delete next.platforms;
  return Object.keys(next).length > 0 ? next : null;
}
