/**
 * Internal (ADR 0351 §2, A1): encoding settings read and written — a sidecar's `encoding` block (`myco.import@1`,
 * `importSettings.ts` calls these) and `audio.json`'s `encoding` section (`project/format.ts` calls these).
 *
 * Parses are lenient (ADR 0306): unknown keys, bad values and unknown platforms are skipped with one problem line each,
 * numbers out of range are clamped with one; parses never throw. Profile names that match no profile are kept (so a
 * write gives them back) and reported here; the resolver falls back past them with a problem of its own.
 * Writers give back what the parse read: `parse(write(x))` equals `x`, keys in a fixed order.
 *
 * Pure; no plugin, no DOM.
 */
import type { ImportPlatform } from "../../scene/importSettings";
import { ENCODING_LIMITS, ENCODING_PLATFORMS } from "./defaults";
import {
  ENCODING_CODECS, ENCODING_KEYS, LOAD_MODES, SAMPLE_RATES,
  type AudioBudget, type EncodingConfig, type EncodingProfile, type EncodingRule, type EncodingSettings, type PlatformLayered, type SidecarEncoding,
} from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPlatform = (v: string): v is ImportPlatform => (ENCODING_PLATFORMS as readonly string[]).includes(v);
const quoted = (xs: readonly unknown[]) => xs.map((x) => JSON.stringify(x)).join(", ");

/** A number clamped to `[min, max]`, or undefined (with a problem) when it isn't a number. */
function clamped(raw: unknown, where: string, [min, max]: readonly [number, number], problems: string[], whole = false): number | undefined {
  if (!isNum(raw)) {
    problems.push(`${where}: must be a number from ${min} to ${max}; ignored.`);
    return undefined;
  }
  const v = whole ? Math.round(raw) : raw;
  const c = Math.min(max, Math.max(min, v));
  if (c !== v) problems.push(`${where}: ${raw} is outside ${min}..${max}; using ${c}.`);
  return c;
}

/** One layer's keys from `raw` (every key optional). `extra` keys are the caller's (skipped here without a problem). */
function parseKeys(raw: Record<string, unknown>, where: string, problems: string[], extra: readonly string[]): EncodingSettings {
  const out: EncodingSettings = {};
  for (const [key, v] of Object.entries(raw)) {
    const at = `${where}.${key}`;
    switch (key) {
      case "codec":
        if ((ENCODING_CODECS as readonly unknown[]).includes(v)) out.codec = v as EncodingSettings["codec"];
        else problems.push(`${at}: must be one of ${quoted(ENCODING_CODECS)}; ignored.`);
        break;
      case "quality": {
        const q = clamped(v, at, ENCODING_LIMITS.quality, problems);
        if (q !== undefined) out.quality = q;
        break;
      }
      case "sampleRate":
        if (v === "source" || (SAMPLE_RATES as readonly unknown[]).includes(v)) out.sampleRate = v as EncodingSettings["sampleRate"];
        else problems.push(`${at}: must be "source" or one of ${SAMPLE_RATES.join(", ")}; ignored.`);
        break;
      case "channels":
        if (v === "source" || v === "mono") out.channels = v;
        else problems.push(`${at}: must be "source" or "mono"; ignored.`);
        break;
      case "load":
        if ((LOAD_MODES as readonly unknown[]).includes(v)) out.load = v as EncodingSettings["load"];
        else problems.push(`${at}: must be one of ${quoted(LOAD_MODES)}; ignored.`);
        break;
      case "prefetchMs": {
        const ms = clamped(v, at, ENCODING_LIMITS.prefetchMs, problems, true);
        if (ms !== undefined) out.prefetchMs = ms;
        break;
      }
      default:
        if (!extra.includes(key)) problems.push(`${at}: unknown key; ignored.`);
    }
  }
  return out;
}

/** A layer with its `platforms` (the keys of `parseKeys`, plus `platforms`; `extra` keys are the caller's). */
function parseLayered(raw: Record<string, unknown>, where: string, problems: string[], extra: readonly string[] = []): PlatformLayered {
  const out: PlatformLayered = parseKeys(raw, where, problems, ["platforms", ...extra]);
  if (raw.platforms === undefined) return out;
  if (!isRecord(raw.platforms)) {
    problems.push(`${where}.platforms: must be an object keyed by platform; ignored.`);
    return out;
  }
  const platforms: PlatformLayered["platforms"] = {};
  for (const [name, v] of Object.entries(raw.platforms)) {
    const at = `${where}.platforms.${name}`;
    if (!isPlatform(name)) {
      problems.push(`${at}: unknown platform (expected ${ENCODING_PLATFORMS.join(", ")}); skipped.`);
      continue;
    }
    if (!isRecord(v)) {
      problems.push(`${at}: must be an object; skipped.`);
      continue;
    }
    const nested = Object.keys(v).filter((k) => k === "platforms" || k === "profile");
    for (const k of nested) problems.push(`${at}.${k}: can't differ per platform; ignored.`);
    const layer = parseKeys(v, at, problems, nested);
    if (Object.keys(layer).length > 0) platforms[name] = layer;
  }
  if (Object.keys(platforms).length > 0) out.platforms = platforms;
  return out;
}

/** A sidecar's `encoding` block, or null when absent or empty. */
export function parseSidecarEncoding(raw: unknown, where: string, problems: string[]): SidecarEncoding | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    problems.push(`${where}: must be an object; ignored.`);
    return null;
  }
  const out: SidecarEncoding = parseLayered(raw, where, problems, ["profile"]);
  if (raw.profile !== undefined) {
    if (typeof raw.profile === "string" && raw.profile.trim() !== "") out.profile = raw.profile;
    else problems.push(`${where}.profile: must be a profile name; ignored.`);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The empty `encoding` section: no profiles, rules or budgets (every file takes the built-in defaults). */
export function defaultEncodingConfig(): EncodingConfig {
  return { default: null, profiles: {}, rules: [], budgets: {} };
}

/** `audio.json`'s `encoding` section; absent is the empty section. */
export function parseEncodingConfig(raw: unknown, problems: string[], where = "encoding"): EncodingConfig {
  const out = defaultEncodingConfig();
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    problems.push(`${where}: must be an object; using no encoding settings.`);
    return out;
  }
  for (const key of Object.keys(raw)) if (!["default", "profiles", "rules", "budgets"].includes(key)) problems.push(`${where}.${key}: unknown key; ignored.`);

  if (raw.profiles !== undefined) {
    if (!isRecord(raw.profiles)) problems.push(`${where}.profiles: must be an object of profiles by name; ignored.`);
    else {
      for (const [name, v] of Object.entries(raw.profiles)) {
        const at = `${where}.profiles.${name}`;
        if (name.trim() === "" || name !== name.trim() || name === "__proto__") {
          problems.push(`${at}: a profile name can't be empty, start or end with a space, or be "__proto__"; dropped.`);
          continue;
        }
        if (Object.keys(out.profiles).length >= ENCODING_LIMITS.profiles) {
          problems.push(`${at}: at most ${ENCODING_LIMITS.profiles} profiles; dropped.`);
          continue;
        }
        if (!isRecord(v)) {
          problems.push(`${at}: must be an object; dropped.`);
          continue;
        }
        out.profiles[name] = parseLayered(v, at, problems);
      }
    }
  }
  const known = (name: string) => Object.hasOwn(out.profiles, name);

  if (raw.default !== undefined && raw.default !== null) {
    if (typeof raw.default !== "string" || raw.default.trim() === "") problems.push(`${where}.default: must be a profile name or null; using none.`);
    else {
      out.default = raw.default;
      if (!known(raw.default)) problems.push(`${where}.default: no profile is named "${raw.default}"; files fall back to the built-in defaults.`);
    }
  }

  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) problems.push(`${where}.rules: must be a list; ignored.`);
    else {
      raw.rules.forEach((r, i) => {
        const at = `${where}.rules[${i}]`;
        if (out.rules.length >= ENCODING_LIMITS.rules) return void problems.push(`${at}: at most ${ENCODING_LIMITS.rules} rules; dropped.`);
        if (!isRecord(r) || typeof r.path !== "string" || r.path.trim() === "" || typeof r.profile !== "string" || r.profile.trim() === "") {
          return void problems.push(`${at}: needs a "path" glob and a "profile" name; dropped.`);
        }
        for (const key of Object.keys(r)) if (key !== "path" && key !== "profile") problems.push(`${at}.${key}: unknown key; ignored.`);
        if (!known(r.profile)) problems.push(`${at}: no profile is named "${r.profile}"; files it catches fall back past it.`);
        out.rules.push({ path: r.path, profile: r.profile });
      });
    }
  }

  if (raw.budgets !== undefined) {
    if (!isRecord(raw.budgets)) problems.push(`${where}.budgets: must be an object keyed by platform; ignored.`);
    else {
      for (const [name, v] of Object.entries(raw.budgets)) {
        const at = `${where}.budgets.${name}`;
        if (!isPlatform(name)) {
          problems.push(`${at}: unknown platform (expected ${ENCODING_PLATFORMS.join(", ")}); skipped.`);
          continue;
        }
        if (!isRecord(v)) {
          problems.push(`${at}: must be an object like { "downloadMB": 40, "memoryMB": 64 }; skipped.`);
          continue;
        }
        const budget: AudioBudget = {};
        for (const [key, n] of Object.entries(v)) {
          if (key !== "downloadMB" && key !== "memoryMB") {
            problems.push(`${at}.${key}: unknown key; ignored.`);
            continue;
          }
          const mb = clamped(n, `${at}.${key}`, ENCODING_LIMITS.budgetMB, problems);
          if (mb !== undefined) budget[key] = mb;
        }
        if (Object.keys(budget).length > 0) out.budgets[name] = budget;
      }
    }
  }
  return out;
}

// --- write ------------------------------------------------------------------------------------------------------------

/** One layer's keys in their fixed order. */
function keysToJson(s: EncodingSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENCODING_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

function layeredToJson(layer: PlatformLayered): Record<string, unknown> {
  const out = keysToJson(layer);
  const platforms: Record<string, unknown> = {};
  for (const p of ENCODING_PLATFORMS) {
    const o = layer.platforms?.[p];
    if (o && Object.keys(keysToJson(o)).length > 0) platforms[p] = keysToJson(o);
  }
  if (Object.keys(platforms).length > 0) out.platforms = platforms;
  return out;
}

/** A sidecar's `encoding` block as written, or null when it holds nothing (the sidecar then has no `encoding`). */
export function sidecarEncodingToJson(e: SidecarEncoding | null): Record<string, unknown> | null {
  if (!e) return null;
  const out = { ...(e.profile !== undefined ? { profile: e.profile } : {}), ...layeredToJson(e) };
  return Object.keys(out).length > 0 ? out : null;
}

/** Whether `config` is the empty section. */
export function isEmptyEncodingConfig(config: EncodingConfig): boolean {
  return config.default === null && Object.keys(config.profiles).length === 0 && config.rules.length === 0 && Object.keys(config.budgets).length === 0;
}

/** `audio.json`'s `encoding` section as written, or null for the empty section (the key is then left out). */
export function encodingConfigToJson(config: EncodingConfig): Record<string, unknown> | null {
  if (isEmptyEncodingConfig(config)) return null;
  const out: Record<string, unknown> = {};
  if (config.default !== null) out.default = config.default;
  if (Object.keys(config.profiles).length > 0) out.profiles = Object.fromEntries(Object.entries(config.profiles).map(([n, p]: [string, EncodingProfile]) => [n, layeredToJson(p)]));
  if (config.rules.length > 0) out.rules = config.rules.map((r: EncodingRule) => ({ path: r.path, profile: r.profile }));
  const budgets: Record<string, unknown> = {};
  for (const p of ENCODING_PLATFORMS) {
    const b = config.budgets[p];
    if (b && Object.keys(b).length > 0) budgets[p] = { ...(b.downloadMB !== undefined ? { downloadMB: b.downloadMB } : {}), ...(b.memoryMB !== undefined ? { memoryMB: b.memoryMB } : {}) };
  }
  if (Object.keys(budgets).length > 0) out.budgets = budgets;
  return out;
}
