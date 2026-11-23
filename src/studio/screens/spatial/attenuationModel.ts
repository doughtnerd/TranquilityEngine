// "Edit attenuation…" (ADR 0347: attenuation curves live on playlists): who owns the attenuation an emitter is heard with,
// and the shared curve editor's distance dialog over it. An emitter plays a playlist; the playlist's `spatial.attenuation`
// is a preset path (`*.attenuation.json`, the preset document is edited), an inline object (the playlist document is
// edited) or absent (the screen offers "Create preset" or "Inline"). A sample, or a playlist that plays flat (no spatial
// block), has none to edit. The dialog's lanes are the format's four curves: volume (dB), low-pass (Hz, log), reverb send
// (dB) and spread (degrees), with Min and Max (keys between them stretch, ADR 0346).
//
// Pure: no DOM, no signals.
import type { CurveEditorResult, CurveEditorSpec, CurveLane } from "../../../editor/ui/curves/curveEditorModel";
import { ATTENUATION_CURVES, ATTENUATION_FLOOR_DB, ATTENUATION_PRESETS, applyAttenuationPreset, defaultAttenuation } from "../../../engine/audio/attenuation/format";
import type { Attenuation, AttenuationCurves, AttenuationPreset } from "../../../engine/audio/attenuation/types";
import { ATTENUATION_SUFFIX } from "../../../engine/audio/attenuation/types";
import type { PlaylistAsset, PlaylistSpatial } from "../../../engine/audio/playlist/types";
import { evalCurve, type Curve } from "../../../engine/core/curve";

/** Whose attenuation an emitter's sound uses. */
export type AttenuationOwner =
  /** No sound picked. */
  | { readonly kind: "silent" }
  /** A sample (or anything not a playlist): attenuation lives on playlists. */
  | { readonly kind: "notPlaylist"; readonly sound: string }
  /** A playlist that isn't in the project or can't be read. */
  | { readonly kind: "missing"; readonly playlist: string }
  /** A playlist that plays flat (no spatial block). */
  | { readonly kind: "flat"; readonly playlist: string }
  /** A spatial playlist with no attenuation: the engine default (inverse law). */
  | { readonly kind: "none"; readonly playlist: string }
  | { readonly kind: "inline"; readonly playlist: string; readonly attenuation: Attenuation }
  | { readonly kind: "preset"; readonly playlist: string; readonly preset: string; readonly attenuation: Attenuation | null };

export const isPlaylist = (path: string): boolean => path.toLowerCase().endsWith(".playlist.json");
export const isAttenuationPreset = (path: string): boolean => path.toLowerCase().endsWith(ATTENUATION_SUFFIX);

/**
 * Who owns `sound`'s attenuation. `playlist` reads a playlist file (null when missing); `preset` reads an attenuation
 * preset (null when missing or unreadable).
 */
export function attenuationOwner(sound: string, playlist: (path: string) => PlaylistAsset | null, preset: (path: string) => Attenuation | null): AttenuationOwner {
  if (sound === "") return { kind: "silent" };
  if (!isPlaylist(sound)) return { kind: "notPlaylist", sound };
  const p = playlist(sound);
  if (!p) return { kind: "missing", playlist: sound };
  if (!p.spatial) return { kind: "flat", playlist: sound };
  const a = p.spatial.attenuation;
  if (a === null) return { kind: "none", playlist: sound };
  if (typeof a === "string") return { kind: "preset", playlist: sound, preset: a, attenuation: preset(a) };
  return { kind: "inline", playlist: sound, attenuation: a };
}

/** The attenuation the owner holds, or null when there's none to show. */
export const ownedAttenuation = (o: AttenuationOwner): Attenuation | null => (o.kind === "inline" ? o.attenuation : o.kind === "preset" ? o.attenuation : null);

const CURVE_NAMES: Readonly<Record<keyof AttenuationCurves, string>> = { volume: "Volume", lowpass: "Low-pass", reverbSend: "Reverb send", spread: "Spread" };

/** The Inspector's one-line summary: "Min 2.0 m · Max 40.0 m · ∿ Volume, Low-pass". */
export function attenuationSummary(a: Attenuation): string {
  const curves = ATTENUATION_CURVES.filter((c) => (a.curves[c]?.length ?? 0) > 0).map((c) => CURVE_NAMES[c]);
  return `Min ${a.minDistance.toFixed(1)} m · Max ${a.maxDistance.toFixed(1)} m${curves.length ? ` · ∿ ${curves.join(", ")}` : " · flat"}`;
}

/** The owner in words, under the summary. */
export function ownerText(o: AttenuationOwner): string {
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  switch (o.kind) {
    case "silent":
      return "Pick a sound to hear it with its playlist's attenuation.";
    case "notPlaylist":
      return `${name(o.sound)} is a sample: attenuation lives on playlists. Play it through a playlist to shape it.`;
    case "missing":
      return `${name(o.playlist)} isn't in the project.`;
    case "flat":
      return `${name(o.playlist)} plays flat (2D). Make it 3D to hear it in place.`;
    case "none":
      return `${name(o.playlist)} uses the engine's default (inverse law).`;
    case "inline":
      return `Inline in ${name(o.playlist)}.`;
    case "preset":
      return o.attenuation ? `Preset ${name(o.preset)}, shared by the playlists that name it.` : `Preset ${name(o.preset)} is missing.`;
  }
}

/**
 * Why "Edit attenuation…" can't open for this owner (the disabled button's tooltip), or null when it can: it opens the
 * curves of an inline or preset attenuation, and offers Create preset / Inline for a spatial playlist with none. The
 * Inspector's button and the plan's emitter toolbar both follow it.
 */
export function whyNotEditAttenuation(o: AttenuationOwner): string | null {
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  switch (o.kind) {
    case "inline":
    case "none":
      return null;
    case "preset":
      return o.attenuation ? null : `The preset ${name(o.preset)} isn't in the project`;
    case "silent":
      return "Pick a sound first: attenuation lives on the playlist it plays";
    case "notPlaylist":
      return `${name(o.sound)} is a sample: attenuation lives on playlists`;
    case "missing":
      return `${name(o.playlist)} isn't in the project`;
    case "flat":
      return `${name(o.playlist)} plays flat (2D): make it 3D first`;
  }
}

/**
 * "Make it 3D" (J9.2): a playlist placed in a test scene that plays flat gets a spatial block right from the Spatial
 * Inspector, as a game's `AudioSource` hears it by default: the engine's default attenuation (inverse law, until Edit
 * attenuation… gives it curves), occluded by walls (ADR 0162: occlusion is opt-out) and Doppler at 1.
 */
export const NEW_SPATIAL: Readonly<PlaylistSpatial> = { attenuation: null, occlusion: true, doppler: 1, spread: null };

/** Whether the Inspector offers "Make it 3D" for this owner: a playlist that plays flat. */
export const canMakeSpatial = (o: AttenuationOwner): boolean => o.kind === "flat";

/** Whether the owner's sound is traced for occlusion: false for a spatial playlist whose block turns it off. */
export function occlusionOn(sound: string, playlist: (path: string) => PlaylistAsset | null): boolean {
  if (!isPlaylist(sound)) return true;
  const p = playlist(sound);
  return !p?.spatial || p.spatial.occlusion;
}

/** Each lane's range, unit and plain value (what a missing curve means). */
const LANES: Readonly<Record<keyof AttenuationCurves, Omit<CurveLane, "id" | "curve" | "name">>> = {
  volume: { unit: "dB", min: ATTENUATION_FLOOR_DB, max: 6, step: 0.5, base: 0, color: 1 },
  lowpass: { unit: "Hz", min: 20, max: 20000, step: 10, scale: "log", base: 20000, color: 2 },
  reverbSend: { unit: "dB", min: ATTENUATION_FLOOR_DB, max: 6, step: 0.5, base: 0, color: 3 },
  spread: { unit: "°", min: 0, max: 360, step: 1, base: 0, color: 4 },
};

/** The curve editor's distance dialog over `a`; `now` is the emitter's distance from the active listener. */
export function attenuationDialog(a: Attenuation, now?: number): CurveEditorSpec {
  const flat = (base: number): Curve => [[0, base], [Math.max(a.maxDistance, 1), base]];
  const lanes: CurveLane[] = ATTENUATION_CURVES.map((id) => {
    const l = LANES[id];
    const curve = a.curves[id];
    return { id, name: CURVE_NAMES[id], ...l, curve: curve && curve.length > 0 ? curve.map((k) => [...k]) as unknown as Curve : flat(l.base) };
  });
  return { kind: "distance", lanes, minDistance: a.minDistance, maxDistance: a.maxDistance, now: now === undefined ? undefined : Math.max(0, now) };
}

/** Whether a curve is flat at `base` everywhere (it says nothing: the format leaves it out). */
function isFlatAt(curve: Curve, base: number): boolean {
  return curve.every((k) => Math.abs(k[1] - base) < 1e-9) && Math.abs(evalCurve(curve, 0) - base) < 1e-9;
}

/**
 * The attenuation Apply writes: Min and Max from the dialog, each lane's keys as the curve, except lanes flat at their
 * plain value and bypassed lanes (the format has no bypass: a bypassed curve is left out, which plays flat).
 */
export function attenuationFromResult(before: Attenuation, result: CurveEditorResult): Attenuation {
  const curves: AttenuationCurves = {};
  for (const lane of result.lanes) {
    const id = lane.id as keyof AttenuationCurves;
    if (!(id in LANES) || lane.bypass) continue;
    const curve = lane.curve as Curve;
    if (curve.length === 0 || isFlatAt(curve, LANES[id].base)) continue;
    curves[id] = curve.map((k) => [...k]) as unknown as Curve;
  }
  return { minDistance: result.minDistance ?? before.minDistance, maxDistance: result.maxDistance ?? before.maxDistance, curves };
}

/** A new attenuation (Create preset / Inline): the default distances with the inverse law's volume curve. */
export const newAttenuation = (preset: AttenuationPreset = "inverse"): Attenuation => applyAttenuationPreset(defaultAttenuation(), preset);

/** The rolloff presets the format offers, with their names. */
export const ROLLOFF_PRESETS: readonly { readonly id: AttenuationPreset; readonly label: string }[] = ATTENUATION_PRESETS.map((id) => ({
  id,
  label: { linear: "Linear", inverse: "Inverse", exponential: "Exponential", inverseSquare: "Inverse square" }[id],
}));

/** Where a new preset for playlist `playlist` goes: `audio/attenuation/<playlist name>` (the ADR's example folder). */
export function presetNameFor(playlist: string): string {
  const file = playlist.slice(playlist.lastIndexOf("/") + 1).replace(/\.playlist\.json$/i, "");
  return file || "Attenuation";
}

export const PRESET_FOLDER = "audio/attenuation";
