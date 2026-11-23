// Loudness and ducking for voice-over (ADR 0354 §8): "Normalise language" writes each recorded file's sidecar
// `normalize` from `localisation.loudness` (gain measured as the Samples screen does); "Duck Music under Voice" is
// offered when a line table plays on a bus no ducking rule is triggered by, and adds an ordinary presence rule to
// `audio.json` (one undo step). Nothing new in the mixer. Pure.
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../editor/sdk/editResult";
import { busOf, masterOf } from "../mixer/busTree";
import { addDucking } from "../mixer/mixEdits";
import { allLines, fileIn, type DialogueData } from "./dialogueData";

/** 0354 §8's rule: Music ducked by 6 dB while Voice plays, 80 ms attack, 400 ms release. */
export const VOICE_DUCK = { amountDb: -6, attackMs: 80, releaseMs: 400 } as const;

/** The bus a line table plays on: its `output`, else Voice when it exists, else Master. */
export const tableOutput = (audio: AudioProject, output: string | null): string => output ?? (busOf(audio, "Voice") ? "Voice" : masterOf(audio));

/**
 * The bus "Duck Music under Voice" would duck Music under: the first bus a line table plays on that triggers no ducking
 * rule, when Music exists and isn't it; null when there is nothing to offer.
 */
export function duckOffer(audio: AudioProject, data: Pick<DialogueData, "tables">): string | null {
  if (!busOf(audio, "Music")) return null;
  for (const t of data.tables) {
    const bus = tableOutput(audio, t.table.output);
    if (bus === "Music" || bus === masterOf(audio)) continue;
    if (!audio.ducking.some((d) => d.trigger === bus)) return bus;
  }
  return null;
}

/** Add the voice ducking rule: Music ducked while `trigger` (default Voice) plays. */
export function duckMusicUnder(audio: AudioProject, trigger = "Voice"): EditResult<AudioProject> {
  const r = addDucking(audio, "Music", trigger);
  if ("refused" in r) return r;
  const rules = r.next.ducking;
  return { next: { ...r.next, ducking: rules.map((d, i) => (i === rules.length - 1 ? { ...d, ...VOICE_DUCK } : d)) } };
}

/** The recorded files of `code` (each once), for Normalise language. */
export function languageFiles(data: DialogueData, code: string): string[] {
  const out = new Set<string>();
  for (const ref of allLines(data)) {
    const f = fileIn(data, ref, code);
    if (f !== null) out.add(f);
  }
  return [...out];
}

/** The files of `code` whose sidecar normalisation isn't the project's setting (what Normalise language changes). */
export function unnormalised(data: DialogueData, code: string): string[] {
  const want = data.localisation.loudness;
  return languageFiles(data, code).filter((p) => {
    const n = data.facts(p)?.normalize ?? null;
    return (n?.mode ?? "off") !== want.mode || (want.mode !== "off" && n!.target !== want.target);
  });
}
