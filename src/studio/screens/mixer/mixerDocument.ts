// `audio.json` as the Mixer's document (ADR 0344 "one document, one history"; ADR 0341 "the engine's undo tree"): the
// editor's asset document machinery (`openAssetDocument`) over a format read by the engine's parse and written in the
// editor's layout (`audioProjectText`, the same text the editor's settings adapter writes, decision D2), so the
// Studio's edits are steps of the engine's persistent history tree, the History panel and Ctrl+Z follow it (the
// Mixer's panels carry `data-asset-document`), and outside changes (the editor in another window) are followed.
//
// `audio.json` sits at the project root and has no file-name ending of its own, so the kind is registered without
// extensions and opened by id. A project not migrated yet (its `project.json` still holds the old `audio` section)
// reads that section as its mix (`currentAudioProject`), so the first edit writes `audio.json` without losing it.
import { audioProject } from "../../shell/audioProject";
import { currentAudioProject, audioProjectText } from "../../../editor/audioProjectFile";
import { openAssetDocument, type AssetDocument } from "../../../editor/assetDocuments";
import type { EditorProject } from "../../../editor/projects";
import { assetKinds, type AssetFormat } from "../../../editor/sdk/contributions";
import { parseAudioProject } from "../../../engine/audio/project/format";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../../../engine/audio/project/types";

/** The kind id `audio.json` opens with. */
export const AUDIO_PROJECT_KIND = "audioProject";

/** The mix a project holds when `audio.json` is missing: its old section, else the default. */
const fallback = (): AudioProject => {
  const project = audioProject.peek();
  return project ? currentAudioProject(project) : parseAudioProject(undefined).project;
};

/** `audio.json`'s format: the engine's lenient parse, the editor's text layout. */
export const audioProjectFormat: AssetFormat<AudioProject> = {
  parse: (raw) => {
    if (raw === undefined) return { value: fallback(), problems: [] };
    const read = parseAudioProject(raw);
    return { value: read.project, problems: read.problems.map((message) => ({ message })) };
  },
  format: audioProjectText,
  empty: fallback,
  // A fader drag writes after a short quiet spell, like the editor's sliders.
  writeDelay: 200,
};

/** Register the kind once (the Studio activates only the audio plugin; nothing else registers it). */
export function ensureAudioProjectKind(): void {
  if (assetKinds.get(AUDIO_PROJECT_KIND)) return;
  assetKinds.register({ id: AUDIO_PROJECT_KIND, extensions: [], label: "Audio mix", icon: "M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M11 16v4", format: audioProjectFormat });
}

/** The open project's `audio.json` document, or null with no project. */
export function openMixDocument(project: EditorProject | null = audioProject.value): AssetDocument<AudioProject> | null {
  if (!project) return null;
  ensureAudioProjectKind();
  return openAssetDocument<AudioProject>(project, AUDIO_PROJECT_FILE, AUDIO_PROJECT_KIND);
}
