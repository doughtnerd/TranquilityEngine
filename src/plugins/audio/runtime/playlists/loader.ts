/**
 * Loading playlists (ADR 0329) and the attenuation presets they name (ADR 0333) through the engine's asset system, as
 * the event runtime loads `*.audioevent.json` (`loadAudioEvent`): `Assets.json` gives the raw value, the parse runs once
 * per raw object (an edited asset is a new object, so a hot reload re-parses and the next trigger plays the new
 * version), and each problem is reported once.
 *
 * Linked playlists resolve by path; `linkedPlaylist` refuses a link that would make a playlist contain itself.
 */
import { Assets } from "../../../../engine/scene/Assets";
import { parseAttenuationAsset } from "../../../../engine/audio/attenuation/format";
import type { Attenuation } from "../../../../engine/audio/attenuation/types";
import { parsePlaylist } from "../../../../engine/audio/playlist/format";
import type { PlaylistAsset } from "../../../../engine/audio/playlist/types";
import { warnOnce } from "../core/handle";

const playlists = new WeakMap<object, PlaylistAsset>();
const attenuations = new WeakMap<object, Attenuation>();

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
