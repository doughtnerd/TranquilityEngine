/**
 * What a new sequence clip starts with when an editor (the Studio's sequence view, the scene editor) adds one (decision
 * log D20). These are authoring defaults, decided where the clip is made; the file's own default stays what the parse
 * fills (`sync: false`):
 *
 * - the parse reads one file and can't see the sample a clip names (its sidecar is another file), so it can't default
 *   by the sample's kind;
 * - a default that depended on another file would change the meaning of a saved sequence whenever the sample's kind
 *   changed, so the editor writes the value it chose into the clip instead.
 *
 * Pure; no plugin, no DOM.
 */
import type { SampleEdits } from "../sample/types";

/**
 * Whether a new clip of a sample with `edits` is a sync clip: true for music (a sample whose `kind` is `"music"` is
 * locked to the playhead by default, the DAW and FMOD practice for musical stems), false otherwise and when the edits
 * aren't known.
 */
export function defaultClipSync(edits: Pick<SampleEdits, "kind"> | null | undefined): boolean {
  return edits?.kind === "music";
}
