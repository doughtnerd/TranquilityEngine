// The project whose audio the Studio's audio screens show (ADR 0410): the open project; or, in a takes folder (no
// project, ADR 0408), the build's audio downloaded and mounted for the open take or the connected build, read-only.
// Playlists, the Mixer and the Take Inspector read this instead of `currentProject`. Null in a takes folder with no
// build audio mounted.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { isTakesFolder, type EditorProject } from "../../editor/projects";
import { currentProject } from "../../editor/state";

/** The mounted build audio as a read-only project (`buildAudioSets.ts` sets it), or null. */
export const mountedAudioProject = signal<EditorProject | null>(null);

/** The project the audio screens show. */
export const audioProject: ReadonlySignal<EditorProject | null> = computed(() => {
  const p = currentProject.value;
  return isTakesFolder(p) ? mountedAudioProject.value : p;
});
