/**
 * `audio.json`'s `localisation` section (ADR 0354 §2, 0357 §4): parsed leniently (never throws; one problem line per
 * bad value) and written back minimal. `audio/project/format.ts` reads and writes it as part of the audio project.
 *
 * Pure; no plugin, no DOM.
 */
import { cleanFolder } from "../../localisation/languages";
import { LenientReader, type JsonRecord } from "../lenientRead";
import type { AudioLocalisation } from "./types";

/** Limits of the section, declared once (ADR 0306). */
export const AUDIO_LOCALISATION_LIMITS = Object.freeze({
  roots: 32,
  /** Loudness target: LUFS for loudness, dBFS for peak. */
  target: [-60, 0] as readonly [number, number],
  durationTolerance: [0, 4] as readonly [number, number],
});

export const DEFAULT_CAPTIONS_TABLE = "strings/captions.strings.json";

/** The section a project without one has: no localised roots (nothing changes). */
export const defaultAudioLocalisation = (): AudioLocalisation => ({
  roots: [], loudness: { mode: "loudness", target: -23 }, durationTolerance: 0.25, missing: "subtitleOnly", captions: DEFAULT_CAPTIONS_TABLE,
});

/** The section, leniently. Absent: the defaults. Roots that aren't project folders, repeat or nest in another are dropped. */
export function parseAudioLocalisation(raw: unknown, problems: string[], where = "localisation"): AudioLocalisation {
  const r = new LenientReader(problems);
  const out = defaultAudioLocalisation();
  const o = r.record(raw, where);
  if (!o) return out;
  r.list(o.roots, `${where}.roots`).forEach((v, i) => {
    const w = `${where}.roots[${i}]`;
    const root = typeof v === "string" ? cleanFolder(v) : null;
    if (root === null) return void r.problem(w, `${JSON.stringify(v)} isn't a project folder; dropped.`);
    if (out.roots.length >= AUDIO_LOCALISATION_LIMITS.roots) return void r.problem(w, `at most ${AUDIO_LOCALISATION_LIMITS.roots} roots; dropped.`);
    const clash = out.roots.find((x) => x === root || root.startsWith(`${x}/`) || x.startsWith(`${root}/`));
    if (clash !== undefined) return void r.problem(w, `"${root}" ${clash === root ? "is listed twice" : `overlaps "${clash}"`}; dropped.`);
    out.roots.push(root);
  });
  const loud = r.record(o.loudness, `${where}.loudness`);
  if (loud) {
    out.loudness.mode = r.pick(loud.mode, `${where}.loudness.mode`, ["off", "loudness", "peak"] as const, "loudness");
    out.loudness.target = r.num(loud.target, `${where}.loudness.target`, out.loudness.mode === "peak" ? -1 : -23, ...AUDIO_LOCALISATION_LIMITS.target);
  }
  out.durationTolerance = r.num(o.durationTolerance, `${where}.durationTolerance`, 0.25, ...AUDIO_LOCALISATION_LIMITS.durationTolerance);
  out.missing = r.pick(o.missing, `${where}.missing`, ["subtitleOnly", "silent"] as const, "subtitleOnly");
  const captions = r.str(o.captions, `${where}.captions`, DEFAULT_CAPTIONS_TABLE).trim();
  if (captions === "" || !captions.toLowerCase().endsWith(".strings.json")) r.problem(`${where}.captions`, `must be a .strings.json path; using "${DEFAULT_CAPTIONS_TABLE}".`);
  else out.captions = captions;
  return out;
}

/** The section as JSON with defaults left out; null when it is all defaults (`audio.json` then has no `localisation`). */
export function audioLocalisationToJson(s: AudioLocalisation): JsonRecord | null {
  const d = defaultAudioLocalisation();
  const out: JsonRecord = {};
  if (s.roots.length) out.roots = [...s.roots];
  if (s.loudness.mode !== d.loudness.mode || s.loudness.target !== d.loudness.target) out.loudness = { ...s.loudness };
  if (s.durationTolerance !== d.durationTolerance) out.durationTolerance = s.durationTolerance;
  if (s.missing !== d.missing) out.missing = s.missing;
  if (s.captions !== d.captions) out.captions = s.captions;
  return Object.keys(out).length ? out : null;
}

/**
 * Whether a language's file of `duration` seconds is off the reference's `reference` seconds (0354 §8):
 * `|d − dRef| > max(0.5, tolerance × dRef)`.
 */
export const durationMismatch = (duration: number, reference: number, tolerance: number): boolean =>
  Math.abs(duration - reference) > Math.max(0.5, tolerance * reference);
