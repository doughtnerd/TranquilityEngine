// Where the Global parameters panel edits: the Mixer's session (its commit keeps the session's rules: Compare's lock,
// the status bar), or, on the Playlists screen, `audio.json`'s own document (the same document the Mixer opens,
// `openMixDocument`), applied through `applyEdit`. A rename also moves the parameter's test value and renames it in
// the files outside `audio.json`.
import type { AssetDocument } from "../../../editor/assetDocuments";
import type { AudioProject } from "../../../engine/audio/project/types";
import { applyEdit } from "../../../plugins/audio/editor/editResult";
import type { GlobalParametersHost } from "./GlobalParametersPanel";
import type { MixerSession } from "./mixerScreen";

/** Test values with `from`'s value under `to` (unchanged when `from` has none). */
export function renameTestValue<V>(values: Readonly<Record<string, V>>, from: string, to: string): Readonly<Record<string, V>> {
  if (!(from in values)) return values;
  const next: Record<string, V> = {};
  for (const [k, v] of Object.entries(values)) if (k !== from) next[k] = v;
  next[to] = values[from]!;
  return next;
}

/** The panel over the Mixer's session; `renameOutside` renames the parameter in playlists and events. */
export function sessionParametersHost(session: MixerSession, renameOutside?: (from: string, to: string) => void): GlobalParametersHost {
  return {
    project: session.project,
    readOnly: session.readOnly,
    path: session.deps.path,
    commit: (result, label) => session.commit(result, label),
    renamed(from, to) {
      session.testValues.value = renameTestValue(session.testValues.peek(), from, to);
      renameOutside?.(from, to);
    },
  };
}

/** The panel over `audio.json`'s document (the Playlists screen); `renamed` moves test values and renames outside. */
export function documentParametersHost(doc: AssetDocument<AudioProject>, path: string, renamed?: (from: string, to: string) => void): GlobalParametersHost {
  return {
    project: doc.value,
    readOnly: doc.readOnly,
    path,
    commit: (result, label) => applyEdit(result, label, (next) => doc.edit(next, { label }), doc.value.peek()),
    renamed,
  };
}
