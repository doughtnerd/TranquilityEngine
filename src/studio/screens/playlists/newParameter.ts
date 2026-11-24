// "+ New parameter…" on the Playlists screen (UI pass J4.1, J5.1, J6.5): every parameter select here (a Blend axis, a
// Switch's parameter, a loop's binding, an automation lane's or a voice curve's "Driven by", the Parameters panel) can
// make a new global game parameter in `audio.json`, through the same document and host as this screen's Global
// parameters panel, as one undo step, and then pick it. The dialog is the Mixer's `NewGlobalParameterHost`, which the
// screen mounts once.
import { audioProject } from "../../shell/audioProject";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { AUDIO_PROJECT_FILE } from "../../../engine/audio/project/types";
import type { NewParameterKind } from "../../components/newParameterModel";
import { documentParametersHost } from "../mixer/globalParametersHost";
import { openMixDocument } from "../mixer/mixerDocument";
import { newGlobalParameter } from "../mixer/newGlobalParameter";

/** Ask for a new global parameter (`kind`: only that kind); its definition once added, null when cancelled or read-only. */
export function newPlaylistParameter(kind?: NewParameterKind): Promise<ParameterDef | null> {
  const project = audioProject.peek();
  const doc = project?.canSave ? openMixDocument(project) : null;
  if (!doc || doc.readOnly) return Promise.resolve(null);
  return newGlobalParameter(documentParametersHost(doc, AUDIO_PROJECT_FILE), kind);
}
