// The Studio's open project as the place a bake reads and writes (ADR 0360 §6): the `BakeHost` of G5's `bakeGenerator`
// (`generators/bake.ts`) over an `EditorProject`.
//
// - **Reads** a generator as the editor holds it now: its open asset document's text (edits not yet written included),
//   else the file's.
// - **Writes** the WAV with `writeBinary`; one that overwrites a sample (Rebake) also drops the Samples screen's cached
//   peaks, loudness and PCM for it, so the new sound shows.
// - **Sidecars**: a new one is written as a file; one that exists (Rebake) is edited through its asset document, the one
//   the Samples inspector shows, as an undo step labelled `Bake · <name>`, so the inspector's provenance follows at once
//   and a later edit there doesn't write the old block back.
// - **Replace uses** goes through the editor's `editProjectFiles` (one undo step per file, open documents included).
import { assetFileOwner, openAssetDocument } from "../../../../editor/assetDocuments";
import { editProjectFiles } from "../../../../editor/projectFileEdits";
import type { EditorProject } from "../../../../editor/projects";
import { docVersion } from "../../../../editor/state";
import type { BakeHost } from "../../../../engine/audio/generators/bake";
import { parseImportSettings, type ImportSettings } from "../../../../engine/scene/importSettings";
import { forgetAudio, registerSampleKinds, SIDECAR_KIND } from "../../samples/sampleSession";

const SIDECAR_SUFFIX = ".meta.json";
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** `project` as a bake's host (see the file note). */
export function projectBakeHost(project: EditorProject): BakeHost {
  registerSampleKinds();
  return {
    files: project.files,
    readText: async (path) => (assetFileOwner(project, path)?.text ?? project.textOf(path)) ?? null,
    writeBinary: async (path, bytes) => {
      const existed = project.files.includes(path);
      await project.writeBinary(path, bytes);
      if (existed) forgetAudio(project, path);
      docVersion.value++;
    },
    writeText: async (path, text) => {
      if (path.toLowerCase().endsWith(SIDECAR_SUFFIX) && project.files.includes(path)) {
        const doc = openAssetDocument<ImportSettings>(project, path, SIDECAR_KIND);
        doc.edit(parseImportSettings(JSON.parse(text), path).settings, { label: `Bake · ${nameOf(path.slice(0, -SIDECAR_SUFFIX.length))}` });
        await doc.flush();
      } else {
        await project.writeText(path, text);
      }
      docVersion.value++;
    },
    editProjectFiles: (edit, label) => editProjectFiles(project, edit, label),
  };
}
