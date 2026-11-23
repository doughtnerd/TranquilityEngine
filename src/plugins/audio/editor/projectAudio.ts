// The open project's audio settings as the audio Inspector sections and gizmos read them: `EditorProject.settings`'
// `audio`, which is `audio.json`'s runtime view (ADR 0344, `projectWithAudio`), through `audioSection`'s parse (memoised
// per value and frozen, ADR 0175). Read-only: the Audio Studio edits `audio.json`.
import { audioSection } from "../../../engine/audio/audioSection";
import type { AudioSettings } from "../../../engine/audio/settings";

/** The parsed `audio` of a project's settings (the defaults when it has none). */
export const projectAudio = (settings: unknown): AudioSettings => audioSection((settings as { audio?: unknown } | null | undefined)?.audio).settings;
