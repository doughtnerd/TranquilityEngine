// The Generator editor wired to the Playlists screen (ADR 0360 §9, D63): the open generator, its document (undo and
// redo follow it through `data-asset-document`), the locks, the preview, the audition and the Bake dialog. The
// Playlist panel shows it in its place while a generator is open; the Library shows `GeneratorLibraryPanel`.
import { audioProject } from "../../../shell/audioProject";
import { useEffect } from "preact/hooks";
import { docVersion } from "../../../../editor/state";
import { BakeDialog } from "./BakeDialog";
import { GeneratorEditor } from "./GeneratorEditor";
import { GeneratorLibrary } from "./GeneratorLibrary";
import { libraryGenerators } from "./generatorEntries";
import {
  addGeneratorToOpen, auditionState, bake, bakeDefaults, bakeState, baking, editGenerator, followLiveEdits, followPreview, gate, generatorBody, generatorDoc, generatorTarget, generatorTitle, installGeneratorKeys,
  newEmbeddedGenerator, newGenerator, libraryAddTarget, openGeneratorFile, openLocks, pressGate, preview, previewBusy, previewError, releaseGate, toggleGeneratorLock,
} from "./generatorScreen";

/** The Generator editor for the open generator (null when none is open). */
export function GeneratorPanel() {
  useEffect(() => {
    const stops = [followPreview(), followLiveEdits(), installGeneratorKeys()];
    return () => stops.forEach((s) => s());
  }, []);
  void docVersion.value;
  const t = generatorTarget.value;
  const body = generatorBody.value;
  const doc = generatorDoc.value;
  if (!t || !body || !doc) return null;
  const { title, where } = generatorTitle.value;
  const writable = !!audioProject.value?.canSave && !doc.readOnly;
  const a = auditionState.value;
  const defaults = bakeDefaults.value;
  return (
    <div class="pl-doc gen-doc" data-asset-document={doc.path} tabIndex={-1}>
      <GeneratorEditor
        body={body}
        title={title}
        where={where}
        writable={writable}
        locks={openLocks.value}
        preview={preview.value}
        previewBusy={previewBusy.value}
        previewError={previewError.value}
        audition={{ available: a.available, reason: a.reason, held: gate.value.held }}
        bake={bakeState.value}
        onEdit={(label, edit, drag) => editGenerator(label, edit, drag)}
        onToggleLock={toggleGeneratorLock}
        onGatePress={pressGate}
        onGateRelease={releaseGate}
        onBake={() => (baking.value = "open")}
      />
      {baking.value !== "closed" && t.kind === "file" && defaults && (
        <BakeDialog name={title} initial={defaults} availability={bakeState.value} busy={baking.value === "busy"} onBake={(o) => void bake(t.path, o)} onClose={() => baking.peek() !== "busy" && (baking.value = "closed")} />
      )}
    </div>
  );
}

/** The Library's generators section, searched with the Library's `query`. */
export function GeneratorLibraryPanel(props: { readonly query: string }) {
  void docVersion.value;
  const project = audioProject.value;
  const rows = libraryGenerators(project?.files ?? [], props.query, (p) => project?.assets.get(p));
  const t = generatorTarget.value;
  const addTo = libraryAddTarget.value;
  return (
    <GeneratorLibrary
      rows={rows}
      open={t?.kind === "file" ? t.path : null}
      addTo={addTo}
      writable={!!project?.canSave}
      searching={props.query.trim() !== ""}
      onOpen={openGeneratorFile}
      onAdd={(path) => void addGeneratorToOpen(path)}
      onNew={(kind) => void newGenerator(kind)}
      onNewEmbedded={addTo ? (kind) => void newEmbeddedGenerator(kind) : undefined}
    />
  );
}
