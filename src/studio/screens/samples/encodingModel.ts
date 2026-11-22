// The Samples Inspector's Encoding section (ADR 0337 §6): one row per encoding key for the chosen platform, showing the
// effective value and where it came from (`originLabel`), whether this file overrides it there, and the edits: override a
// key for one platform or for every platform, reset it (the nearest override of this file that supplies it), and choose
// the file's profile. Edits return `{ next } | { refused }` over the sidecar's settings and apply as one undo step of
// the sidecar document. Also the profile and folder-rule matches, and the per-platform readouts (shipped size and memory:
// exact once converted, else estimated). Pure.
//
// The Studio writes only `load` (ADR 0337 "Deprecates"); an override of `load` for every platform also sets the legacy
// `stream` flag to match, because the editor's Play and the Studio play sources by that flag, and a reset clears it.
import { ENCODING_PLATFORMS } from "../../../engine/audio/encoding/defaults";
import { compileGlob } from "../../../engine/audio/encoding/pathGlob";
import { originLabel, withEncodingKey } from "../../../engine/audio/encoding/resolve";
import {
  ENCODING_CODECS, ENCODING_KEYS, LOAD_MODES, SAMPLE_RATES,
  type EncodingConfig, type EncodingKey, type EncodingResolution, type EncodingSettings, type ResolvedEncoding,
} from "../../../engine/audio/encoding/types";
import type { ImportPlatform, ImportSettings } from "../../../engine/scene/importSettings";
import type { PlannedSound } from "../../../export/audio";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import type { ConvertedSound } from "../../encoding/conversion";
import { estimateShipped, runtimeMemory, type ShippedFigures, type SourceFacts } from "../../encoding/estimate";

export const PLATFORM_LABELS: Readonly<Record<ImportPlatform, string>> = { web: "Web", desktop: "Desktop", android: "Android" };
export const PLATFORM_OPTIONS = ENCODING_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }));

export const KEY_LABELS: Readonly<Record<EncodingKey, string>> = {
  codec: "Codec", quality: "Quality", sampleRate: "Sample rate", channels: "Channels", load: "Load", prefetchMs: "Prefetch",
};

const CODEC_LABELS: Record<string, string> = { auto: "Auto", source: "Source (unchanged)", pcm: "PCM", adpcm: "ADPCM", vorbis: "Vorbis", opus: "Opus" };
const LOAD_LABELS: Record<string, string> = { decode: "Decode on load", compressed: "Compressed", stream: "Stream" };

/** The choices of a key with a fixed list (null for the numbers). */
export function keyChoices(key: EncodingKey): { value: string; label: string }[] | null {
  switch (key) {
    case "codec": return ENCODING_CODECS.map((c) => ({ value: c, label: CODEC_LABELS[c] }));
    case "sampleRate": return [{ value: "source", label: "Source" }, ...SAMPLE_RATES.map((r) => ({ value: String(r), label: `${r / 1000} kHz` }))];
    case "channels": return [{ value: "source", label: "Source" }, { value: "mono", label: "Mono" }];
    case "load": return LOAD_MODES.map((l) => ({ value: l, label: LOAD_LABELS[l] }));
    default: return null;
  }
}

/** A key's value for display ("Vorbis", "0.50", "32 kHz", "250 ms"). */
export function valueText<K extends EncodingKey>(key: K, value: ResolvedEncoding[K]): string {
  switch (key) {
    case "codec": return CODEC_LABELS[value as string] ?? String(value);
    case "quality": return (value as number).toFixed(2);
    case "sampleRate": return value === "source" ? "Source" : `${(value as number) / 1000} kHz`;
    case "channels": return value === "mono" ? "Mono" : "Source";
    case "load": return LOAD_LABELS[value as string] ?? String(value);
    case "prefetchMs": return `${value as number} ms`;
    default: return String(value);
  }
}

/** A choice's string (`keyChoices`) as the key's value, or undefined when it isn't one. */
export function parseChoice(key: EncodingKey, raw: string): EncodingSettings[EncodingKey] | undefined {
  if (key === "sampleRate") return raw === "source" ? "source" : (SAMPLE_RATES as readonly number[]).includes(Number(raw)) ? (Number(raw) as EncodingSettings["sampleRate"]) : undefined;
  const choices = keyChoices(key);
  return choices?.some((c) => c.value === raw) ? (raw as EncodingSettings[EncodingKey]) : undefined;
}

/** One row of the section. */
export interface EncodingRow {
  readonly key: EncodingKey;
  readonly label: string;
  readonly value: ResolvedEncoding[EncodingKey];
  readonly text: string;
  /** Where the value came from ("Music profile (rule audio/music/**)", "this file · Android", "built-in (Web)"). */
  readonly from: string;
  /** This file sets the value (for this platform or every platform), so Reset can take it away. */
  readonly overridden: boolean;
  /** The override is this platform's own (not every platform's). */
  readonly platformOverride: boolean;
}

/** The rows for `resolution` (one file on one platform); `path` is the file the sidecar belongs to. */
export function encodingRows(resolution: EncodingResolution, path: string): EncodingRow[] {
  return ENCODING_KEYS.map((key) => {
    const origin = resolution.origins[key];
    const own = origin.level === "sidecar" && origin.file === path;
    return {
      key,
      label: KEY_LABELS[key],
      value: resolution.settings[key],
      text: valueText(key, resolution.settings[key]),
      from: originLabel(origin, path),
      overridden: own,
      platformOverride: own && origin.platform !== null,
    };
  });
}

/** Why `value` can't be set for `key` on this file, or null. */
function whyNot(key: EncodingKey, value: unknown, ambisonic: boolean): string | null {
  if (key === "channels" && value === "mono" && ambisonic) return "an ambisonic file keeps its channels (mono would lose the sound field)";
  if (key === "quality" && !(typeof value === "number" && Number.isFinite(value))) return "the quality must be a number from 0 to 1";
  if (key === "prefetchMs" && !(typeof value === "number" && Number.isFinite(value))) return "the prefetch must be a number of milliseconds";
  return null;
}

/** Clamp the numbers to their limits (0..1, 0..2000 ms whole). */
function normalised(key: EncodingKey, value: EncodingSettings[EncodingKey]): EncodingSettings[EncodingKey] {
  if (key === "quality") return Math.round(Math.min(1, Math.max(0, value as number)) * 100) / 100;
  if (key === "prefetchMs") return Math.round(Math.min(2000, Math.max(0, value as number)));
  return value;
}

/**
 * Override `key` with `value` on this file, for `platform` or for every platform (null). An override of `load` for every
 * platform also sets the legacy `stream` flag to match (the sources' playback follows it).
 */
export function overrideKey<K extends EncodingKey>(settings: ImportSettings, platform: ImportPlatform | null, key: K, value: EncodingSettings[K]): EditResult<ImportSettings> {
  const why = whyNot(key, value, settings.ambisonic !== null);
  if (why) return { refused: why };
  const v = normalised(key, value) as EncodingSettings[K];
  const encoding = withEncodingKey(settings.encoding ?? null, platform, key, v);
  const next: ImportSettings = { ...settings, encoding };
  if (key === "load" && platform === null) next.stream = v === "stream";
  return { next };
}

/**
 * Reset `key` on `platform`: take away this file's override that supplies it there (the platform's own first, else the
 * one for every platform; for `load`, the legacy `stream: true` last). Refused when the file sets nothing for it.
 */
export function resetKey(settings: ImportSettings, platform: ImportPlatform, key: EncodingKey): EditResult<ImportSettings> {
  const own = settings.encoding;
  if (own?.platforms?.[platform]?.[key] !== undefined) return { next: { ...settings, encoding: withEncodingKey(own, platform, key, undefined) } };
  if (own?.[key] !== undefined) {
    const next: ImportSettings = { ...settings, encoding: withEncodingKey(own, null, key, undefined) };
    if (key === "load") next.stream = false;
    return { next };
  }
  if (key === "load" && settings.stream) return { next: { ...settings, stream: false } };
  return { refused: `this file doesn't set ${KEY_LABELS[key].toLowerCase()}; it is inherited` };
}

/** Choose the file's profile (null: none of its own, so a folder rule or the default decides). */
export function setProfile(settings: ImportSettings, profile: string | null, config: EncodingConfig): EditResult<ImportSettings> {
  if (profile !== null && !Object.hasOwn(config.profiles, profile)) return { refused: `there's no profile named "${profile}"` };
  const rest = { ...settings.encoding };
  delete rest.profile;
  const encoding = profile === null ? rest : { ...rest, profile };
  return { next: { ...settings, encoding: Object.keys(encoding).length > 0 ? encoding : null } };
}

/** One profile or rule line of the matches block. */
export interface ProfileMatch {
  readonly text: string;
  /** In force (the nearest consulted) or further down the chain (consulted for keys the nearer ones leave unset). */
  readonly kind: "uses" | "fallback" | "shadowed";
}

/**
 * The profiles and folder rules that touch `path`: the profiles the resolver consults, nearest first (its own choice, the
 * first matching rule, the default), then rules that also match but come after the first (first match wins, so they
 * don't apply).
 */
export function profileMatches(resolution: EncodingResolution, config: EncodingConfig, path: string): ProfileMatch[] {
  const out: ProfileMatch[] = resolution.profiles.map((p, i) => {
    const via = p.via.kind === "sidecar" ? (p.via.file === path ? "chosen for this file" : `chosen for ${p.via.file}`) : p.via.kind === "rule" ? `rule ${p.via.path}` : "the project default";
    return { text: `${p.name} profile · ${via}`, kind: i === 0 ? "uses" : "fallback" };
  });
  let first = true;
  for (const r of config.rules) {
    if (!compileGlob(r.path).matches(path)) continue;
    if (first) {
      first = false;
      continue;
    }
    out.push({ text: `rule ${r.path} (${r.profile}) also matches; an earlier rule wins`, kind: "shadowed" });
  }
  return out;
}

/** One platform's readout. */
export interface PlatformReadout {
  readonly platform: ImportPlatform;
  /** What it ships as (null while its length isn't known yet and it will be converted). */
  readonly figures: ShippedFigures | null;
  readonly sourceBytes: number;
  /** Shipped ÷ source, or null. */
  readonly ratio: number | null;
  readonly load: ResolvedEncoding["load"];
  readonly packages: readonly string[];
  readonly notes: readonly string[];
}

/**
 * The readout of `sound` (its plan for one platform): exact from `converted` when it has been converted with these
 * settings, else estimated from the source's facts.
 */
export function platformReadout(platform: ImportPlatform, sound: PlannedSound, facts: SourceFacts, converted: ConvertedSound | null): PlatformReadout {
  const s = sound.resolution.settings;
  let figures: ShippedFigures | null;
  if (converted) {
    const prefetch = Math.round((s.prefetchMs / 1000) * converted.rate);
    figures = { codec: converted.codec, rate: converted.rate, channels: converted.channels, frames: converted.frames, bytes: converted.bytes.length, memoryBytes: runtimeMemory(s.load, converted.codec, converted.frames, converted.channels, converted.bytes.length, prefetch), exact: true };
  } else figures = estimateShipped(facts, sound.codec, s, sound.ambisonic);
  const notes = [...sound.notes, ...(converted?.notes ?? [])];
  return { platform, figures, sourceBytes: facts.bytes, ratio: figures && facts.bytes > 0 ? figures.bytes / facts.bytes : null, load: s.load, packages: sound.packages, notes };
}
