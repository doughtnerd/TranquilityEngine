// Import samples (ADR 0342 "Import", the prototype's picker and review): pick files or a folder (the desktop's folder
// dialog through the platform FileSystem; in the browser the file and directory inputs), read each WAV's chunks, then
// review: the metadata kinds found with a toggle each, Load (the `stream` flag), Into folder and Keep structure. Import
// copies the files with the editor's import rules (`importFiles`: never overwrites, a taken name gets " (1)") and
// writes each sidecar's `sample` block from its chunks, less the kinds turned off.
import { useEffect, useRef, useState } from "preact/hooks";
import { isTauri } from "../../../engine/platform/FileSystem";
import { readWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { defaultImportSettings, formatImportSettings, isSidecarPath, sidecarPath } from "../../../engine/scene/importSettings";
import { baseName, filesOfPaths, importFiles, type IncomingFile } from "../../../editor/assetImportFiles";
import { projectFileSystem } from "../../../editor/projectFs";
import type { EditorProject } from "../../../editor/projects";
import { currentProject, docVersion, status } from "../../../editor/state";
import { toasts } from "../../shell/studioServices";
import { KitDialog } from "../../../editor/ui/KitDialog";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { Checkbox } from "../../components/Checkbox";
import { Icon } from "../../components/Icon";
import { FolderCombo } from "./FolderCombo";
import type { SampleDetection } from "../../../engine/audio/sample/detect/detect";
import { destinationFolder, detectionFor, importedMessage, isAudioPath, isWavPath, kindOn, kindsFound, METADATA_KINDS, sampleBlockFor, type KindToggles, type MetadataKind, type PickedFile } from "./importPlan";
import { detectInBackground } from "./sampleDetect";
import { audioFolders } from "./sampleLibrary";
import { decodeAudio } from "./sampleSession";
import { dialog, openSample } from "./samplesState";

interface Picked extends PickedFile {
  readonly read: () => Promise<Uint8Array>;
}

export interface ImportReviewProps {
  readonly files: readonly PickedFile[];
  readonly folders: readonly string[];
  readonly toggles: KindToggles;
  readonly into: string;
  readonly keep: boolean;
  readonly stream: boolean;
  readonly busy?: boolean;
  /** While importing: what is happening ("Detecting tempo and root of door.wav…"). */
  readonly progress?: string;
  onToggle(kind: MetadataKind | "all" | "none", on: boolean): void;
  onInto(folder: string): void;
  onKeep(keep: boolean): void;
  onStream(stream: boolean): void;
  onImport(): void;
  onCancel(): void;
}

/** The review step (pure view over its props): what the files carry, row by row, the settings, Into folder. */
export function ImportReview(props: ImportReviewProps) {
  const found = kindsFound(props.files);
  const on = found.filter((k) => kindOn(props.toggles, k.kind.id)).length;
  const hasStructure = props.files.some((f) => f.rel.includes("/"));
  const n = props.files.length;
  const allOn = found.every((k) => kindOn(props.toggles, k.kind.id));
  return (
    <KitDialog
      title="Import audio"
      titleExtra={<span class="smp-badge">{n} file{n === 1 ? "" : "s"}</span>}
      width={620}
      class="smp-dialog"
      onClose={props.onCancel}
      summary={props.busy && props.progress ? <span role="status">{props.progress}</span> : found.length ? <span role="status">{on} of {found.length} kind{found.length === 1 ? "" : "s"} of metadata will be imported</span> : "No metadata found: the files import as plain samples"}
      buttons={
        <>
          <button onClick={props.onCancel}>Cancel</button>
          <button class="primary" disabled={props.busy || n === 0} title={n === 0 ? "Tick folders or files to import" : undefined} onClick={props.onImport}>
            {props.busy ? "Importing…" : `Import ${n}`}
          </button>
        </>
      }
    >
      <div class="smp-drop" title={props.files.map((f) => f.rel).join("\n")}>
        <Icon name="import" size={14} />
        {n === 1 ? props.files[0].rel : `${n} audio files selected`}
      </div>
      {found.length > 0 && (
        <>
          <div class="smp-kinds-bar">
            <span class="smp-cap">Found in {n === 1 ? "this file" : "these files"}</span>
            <InfoTip text="These come from the WAV's own chunks (written by Reaper, Sound Forge, a sampler editor…). Imported items keep a link to the file." label="About the file's metadata" />
            <span class="smp-flex" />
            <button type="button" class="smp-sm2" onClick={() => props.onToggle(allOn ? "none" : "all", !allOn)}>{allOn ? "Import none" : "Import all"}</button>
          </div>
          <div class="smp-kinds">
            {found.map((k) => {
              const ticked = kindOn(props.toggles, k.kind.id);
              return (
                <label key={k.kind.id} class={`smp-mrow2${ticked ? "" : " off"}`} title={k.kind.id === "detect" ? "Analyse the audio for a tempo and root note where the file says none (confident results only; marked Detected)" : undefined}>
                  <input type="checkbox" checked={ticked} aria-label={k.kind.title} onChange={(e) => props.onToggle(k.kind.id, (e.currentTarget as HTMLInputElement).checked)} />
                  <span class="smp-ellipsis">
                    <b>{k.kind.title}</b> <span class="smp-muted">{k.files} file{k.files === 1 ? "" : "s"}{k.items > k.files ? ` · ${k.items} items` : ""}</span>
                  </span>
                  <span class="smp-mono smp-faint smp-ellipsis">{k.kind.chunks}</span>
                  <span class="smp-faint" aria-hidden="true">→</span>
                  <span class="smp-ellipsis">{k.kind.becomes}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
      <span class="smp-cap">Import settings</span>
      <div class="fld">
        <span>Load</span>
        <select value={props.stream ? "stream" : "decode"} onChange={(e) => props.onStream((e.currentTarget as HTMLSelectElement).value === "stream")} aria-label="Load" title="Decode on load for short sounds; stream long music">
          <option value="decode">Decode on load</option>
          <option value="stream">Stream (long music)</option>
        </select>
      </div>
      {/* Format and Sample rate are per-platform encoding settings (ADR 0351; decisions.md): the Inspector's Encoding section. */}
      <div class="fld">
        <span>Into folder</span>
        <FolderCombo label="Into folder" value={props.into} folders={props.folders} onChange={props.onInto} />
      </div>
      <div class="fld">
        <span />
        <Checkbox checked={props.keep && hasStructure} disabled={!hasStructure} title={hasStructure ? "Recreate the folders from disk inside the target folder" : "The picked files have no folders to keep"} label="Keep the source folder structure" onChange={props.onKeep} />
      </div>
    </KitDialog>
  );
}

async function readPicked(incoming: readonly IncomingFile[]): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const f of incoming) {
    if (!isAudioPath(f.path)) continue;
    let bytes: Uint8Array | null = null;
    const read = async () => (bytes ??= await f.read());
    let meta = null;
    if (isWavPath(f.path)) {
      try {
        meta = readWavMetadata(await read());
      } catch {
        meta = null;
      }
    }
    out.push({ rel: f.path, meta, read });
  }
  return out;
}

const fromInput = (list: FileList | null): IncomingFile[] =>
  Array.from(list ?? [], (file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, read: async () => new Uint8Array(await file.arrayBuffer()) }));

/** "Detect what's missing" for one file: its audio decoded and analysed on the workers (null when it can't be read). */
async function detectFor(project: EditorProject, f: Picked, toggles: KindToggles): Promise<SampleDetection | null> {
  const what = detectionFor(f.meta, toggles);
  if (what.length === 0) return null;
  try {
    // The decoder may take the buffer it is given: it gets a copy.
    const pcm = await decodeAudio(project, (await f.read()).slice(), f.rel);
    return await detectInBackground(pcm, what);
  } catch {
    return null;
  }
}

/**
 * Copy the picked files and write their sidecars; returns the imported audio paths. With "Detect what's missing" on,
 * a file without tempo or root is analysed first (`onProgress` hears which file). Each file's sidecar is written
 * before its audio: the audio's write is announced to `Assets.onChanged`, and the changed-on-disk review
 * (`sampleDisk.ts`) must find the sidecar's file snapshots already there, or it reads the file's own cues and loops
 * as new. The status line then counts every file imported.
 */
export async function runImport(project: EditorProject, files: readonly Picked[], toggles: KindToggles, into: string, keep: boolean, stream: boolean, onProgress?: (text: string) => void): Promise<string[]> {
  const imported: string[] = [];
  const failed: string[] = [];
  const settingsFailed: string[] = [];
  for (const f of files) {
    const folder = destinationFolder(into, f.rel, keep);
    const name = baseName(f.rel);
    if (detectionFor(f.meta, toggles).length) onProgress?.(`Detecting tempo and root of ${name}…`);
    const sample = sampleBlockFor(f.meta, toggles, await detectFor(project, f, toggles));
    const sidecar: IncomingFile[] = sample || stream ? [{ path: sidecarPath(name), read: async () => new TextEncoder().encode(formatImportSettings({ ...defaultImportSettings(), stream, sample })) }] : [];
    const result = await importFiles(project, folder, [...sidecar, { path: name, read: f.read }]);
    const path = result.imported.find((p) => !isSidecarPath(p));
    if (!path) {
      failed.push(name);
      continue;
    }
    imported.push(path);
    if (sidecar.length && !result.imported.includes(sidecarPath(path))) settingsFailed.push(`${path} (${result.failed[0]?.error ?? "unknown error"})`);
  }
  docVersion.value++;
  if (settingsFailed.length) status.value = { kind: "error", text: `Imported ${settingsFailed.join(", ")} but couldn't write the settings.` };
  else if (imported.length && !failed.length) status.value = { kind: "info", text: `${importedMessage(imported.length, into)}.` };
  else if (failed.length) status.value = { kind: "error", text: `${imported.length ? `${importedMessage(imported.length, into)}; ` : ""}couldn't import ${failed.join(", ")}.` };
  return imported;
}

/** The Import dialog: the picker, or straight to the review with `dropped` files (audio dropped on the Samples panel). */
export function ImportDialog(props: { dropped?: readonly IncomingFile[]; into?: string }) {
  const project = currentProject.value;
  const [files, setFiles] = useState<Picked[] | null>(null);
  const [toggles, setToggles] = useState<KindToggles>({});
  const [into, setInto] = useState(props.into ?? "");
  const [keep, setKeep] = useState(true);
  const [stream, setStream] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const close = () => (dialog.value = null);
  // Files dropped on the Samples panel go straight to the review.
  useEffect(() => {
    if (!props.dropped) return;
    void readPicked(props.dropped).then((picked) => (picked.length ? setFiles(picked) : (toasts.show({ text: "No audio files there (WAV, OGG, MP3, FLAC or M4A)." }), close())));
  }, [props.dropped]);
  if (!project) return null;
  const take = async (incoming: IncomingFile[]) => {
    const picked = await readPicked(incoming);
    if (picked.length === 0) return void toasts.show({ text: "No audio files there (WAV, OGG, MP3, FLAC or M4A)." });
    // A picked folder's own name is the first part of each path: keep it, as the prototype does ("Footsteps/…").
    setFiles(picked);
  };
  const pickFolder = async () => {
    const fs = isTauri() ? await projectFileSystem() : null;
    if (fs) {
      const folder = await fs.pickFolder("Import a folder of samples");
      if (folder) await take(await filesOfPaths(fs, [folder]));
    } else folderInput.current?.click();
  };
  if (!files) {
    return (
      <KitDialog title="Import samples" width={460} class="smp-dialog" onClose={close} buttons={<button onClick={close}>Cancel</button>}>
        <p class="smp-muted" title="The files are copied into the project; the originals aren't changed">Pick audio files, or a folder of them (its folders are kept), or drop them on the Samples panel.</p>
        <div class="smp-actions">
          <button class="primary" autoFocus onClick={() => filesInput.current?.click()}>Choose files…</button>
          <button onClick={() => void pickFolder()}>Choose a folder…</button>
        </div>
        <input ref={filesInput} type="file" multiple accept=".wav,.wave,.ogg,.mp3,.flac,.m4a,audio/*" hidden onChange={(e) => void take(fromInput((e.currentTarget as HTMLInputElement).files))} />
        <input ref={folderInput} type="file" hidden {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => void take(fromInput((e.currentTarget as HTMLInputElement).files))} />
      </KitDialog>
    );
  }
  return (
    <ImportReview
      files={files}
      folders={audioFolders(project.folders, project.files)}
      toggles={toggles}
      into={into}
      keep={keep}
      stream={stream}
      busy={busy}
      progress={progress}
      onToggle={(k, on) => setToggles(k === "all" || k === "none" ? Object.fromEntries(METADATA_KINDS.map((x) => [x.id, k === "all"])) : { ...toggles, [k]: on })}
      onInto={setInto}
      onKeep={setKeep}
      onStream={setStream}
      onCancel={close}
      onImport={async () => {
        setBusy(true);
        const done = await runImport(project, files, toggles, into, keep, stream, setProgress);
        setBusy(false);
        setProgress("");
        close();
        if (done.length) {
          toasts.show({ text: importedMessage(done.length, into) });
          openSample(done[0]);
        }
      }}
    />
  );
}
