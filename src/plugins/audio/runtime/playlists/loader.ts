/**
 * Loading playlists (ADR 0329) and the attenuation presets they name (ADR 0333) through the engine's asset system:
 * `Assets.json` gives the raw value, the parse runs once
 * per raw object (an edited asset is a new object, so a hot reload re-parses and the next trigger plays the new
 * version), and each problem is reported once.
 *
 * Linked playlists resolve by path; `linkedPlaylist` refuses a link that would make a playlist contain itself.
 */
import { Assets } from "../../../../engine/scene/Assets";
import { parseAttenuationAsset } from "../../../../engine/audio/attenuation/format";
import type { Attenuation } from "../../../../engine/audio/attenuation/types";
import { parsePlaylist } from "../../../../engine/audio/playlist/format";
import { PLAYLIST_FORMAT, type PlaylistAsset } from "../../../../engine/audio/playlist/types";
import { parseGenerator } from "../../../../engine/audio/generators/format";
import type { GeneratorAsset } from "../../../../engine/audio/generators/types";
import { warnOnce } from "../core/handle";

const playlists = new WeakMap<object, PlaylistAsset>();
const attenuations = new WeakMap<object, Attenuation>();
const generators = new WeakMap<object, GeneratorAsset>();

/** The raw JSON at `path`, or undefined when there is none (a missing asset, or not JSON). */
function rawJson(path: string): object | undefined {
  let raw: unknown;
  try { raw = Assets.json(path); } catch { raw = undefined; }
  return raw !== null && typeof raw === "object" ? raw : undefined;
}

/** The parsed playlist at `path`, or null (one warning) when there is none. Problems are warned once each. */
export function loadPlaylist(path: string): PlaylistAsset | null {
  const raw = rawJson(path);
  if (!raw) {
    warnOnce(`playlist:missing:${path}`, `Audio.play: no playlist asset "${path}".`);
    return null;
  }
  let value = playlists.get(raw);
  if (!value) {
    const r = parsePlaylist(raw, path);
    for (const p of r.problems) warnOnce(`playlist:problem:${p}`, `[myco] ${p}`);
    value = r.playlist;
    playlists.set(raw, value);
  }
  return value;
}

const samplePlaylists = new Map<string, PlaylistAsset>();

/**
 * A sample played through `Audio.play` (or an `AudioSource` with a sample's playlist path): a Clip playlist of that one
 * sample, as the Studio wraps one (ADR 0329). Built once per path; the sample's sidecar is read when it plays.
 */
export function samplePlaylist(path: string): PlaylistAsset {
  let p = samplePlaylists.get(path);
  if (!p) {
    p = parsePlaylist({ format: PLAYLIST_FORMAT, type: "clip", entries: [{ sample: path }] }, path).playlist;
    samplePlaylists.set(path, p);
  }
  return p;
}

const generatorPlaylists = new Map<string, PlaylistAsset>();

/**
 * ADR 0346 §1: a generator played through `Audio.play` (`*.generator.json`): a Clip playlist of that one generator entry,
 * as a sample is wrapped. Built once per path; the generator file is read each time it plays (a hot reload's next trigger
 * plays the new patch).
 */
export function generatorPlaylist(path: string): PlaylistAsset {
  let p = generatorPlaylists.get(path);
  if (!p) {
    p = parsePlaylist({ format: PLAYLIST_FORMAT, type: "clip", entries: [{ generator: path }] }, path).playlist;
    generatorPlaylists.set(path, p);
  }
  return p;
}

/**
 * ADR 0346 §1: the parsed generator at `path` (`*.generator.json`), or null (one warning) when there is none. Parsed once
 * per raw object (an edited asset is a new object); problems are warned once each.
 */
export function loadGenerator(path: string): GeneratorAsset | null {
  const raw = rawJson(path);
  if (!raw) {
    warnOnce(`generator:missing:${path}`, `Audio.play: no generator asset "${path}"; that entry plays nothing.`);
    return null;
  }
  let value = generators.get(raw);
  if (!value) {
    const r = parseGenerator(raw, path);
    for (const p of r.problems) warnOnce(`generator:problem:${p}`, `[myco] ${p}`);
    value = r.generator;
    generators.set(raw, value);
  }
  return value;
}

/** A linked playlist below `chain` (the paths of the linked playlists above it, the root first): null when missing or when it would contain itself. */
export function linkedPlaylist(path: string, chain: readonly string[]): PlaylistAsset | null {
  if (chain.includes(path)) {
    warnOnce(`playlist:cycle:${chain[0]}:${path}`, `[myco] ${chain[0]}: "${path}" would contain itself (${[...chain, path].join(" → ")}); that entry plays nothing.`);
    return null;
  }
  return loadPlaylist(path);
}

/** The attenuation preset at `path` (`*.attenuation.json`), or null (one warning) when there is none. */
export function loadAttenuation(path: string): Attenuation | null {
  const raw = rawJson(path);
  if (!raw) {
    warnOnce(`attenuation:missing:${path}`, `Audio.play: no attenuation preset "${path}"; using the default distances.`);
    return null;
  }
  let value = attenuations.get(raw);
  if (!value) {
    const r = parseAttenuationAsset(raw, path);
    for (const p of r.problems) warnOnce(`attenuation:problem:${p}`, `[myco] ${p}`);
    value = r.attenuation;
    attenuations.set(raw, value);
  }
  return value;
}
