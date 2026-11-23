// Import samples (ADR 0342 "Import", the prototype's picker and review): pick files or a folder (the desktop's folder
// dialog through the platform FileSystem; in the browser the file and directory inputs), read each WAV's chunks, then
// review: the metadata kinds found with a toggle each, Load (the `stream` flag), Into folder and Keep structure. Import
// copies the files with the editor's import rules (`importFiles`: never overwrites, a taken name gets " (1)") and
// writes each sidecar's `sample` block from its chunks, less the kinds turned off.
import { useRef, useState } from "preact/hooks";
import { isTauri } from "../../../engine/platform/FileSystem";
import { readWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { defaultImportSettings, formatImportSettings, isSidecarPath, sidecarPath } from "../../../engine/scene/importSettings";
import { baseName, filesOfPaths, importFiles, type IncomingFile } from "../../../editor/assetImportFiles";
import { projectFileSystem } from "../../../editor/projectFs";
import type { EditorProject } from "../../../editor/projects";
import { currentProject, docVersion, status } from "../../../editor/state";
import { toasts } from "../../shell/studioServices";
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

/** The review step (pure view over its props). */
export function ImportReview(props: ImportReviewProps) {
  const found = kindsFound(props.files);
  const usable = found.filter((k) => k.kind.id !== "detect");
  const on = usable.filter((k) => kindOn(props.toggles, k.kind.id)).length;
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const hasStructure = props.files.some((f) => f.rel.includes("/"));
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="dialog smp-dialog" role="dialog" aria-modal="true" aria-label="Import audio" onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
        <h2>Import audio</h2>
        <p class="smp-muted">
          {props.files.length} file{props.files.length === 1 ? "" : "s"}. These come from the WAVs' own chunks (written by Reaper, Sound Forge, a sampler editor…). Imported items keep a link to the file.
        </p>
        {found.length === 0 ? (
          <p class="smp-muted">No metadata found: the files import as plain samples.</p>
        ) : (
          <>
            <div class="smp-kinds-bar">
              <b>Found in these files</b>
              <button class="smp-link" onClick={() => props.onToggle("all", true)}>Import all</button>
              <button class="smp-link" onClick={() => props.onToggle("none", false)}>Import none</button>
            </div>
            <ul class="smp-kinds">
              {found.map((k) => (
                <li key={k.kind.id}>
                  <label class="smp-check" title={k.kind.id === "detect" ? "Analyse the audio for a tempo and root note where the file says none (confident results only; marked Detected)" : undefined}>
                    <input type="checkbox" checked={kindOn(props.toggles, k.kind.id)} onChange={(e) => props.onToggle(k.kind.id, (e.currentTarget as HTMLInputElement).checked)} />
                    <span>
                      <b>{k.kind.title}</b> <span class="smp-muted">{k.kind.chunks}</span>
                      <br />
                      <span class="smp-muted">→ {k.kind.becomes} · {k.files} file{k.files === 1 ? "" : "s"}{k.items > k.files ? ` · ${k.items} items` : ""}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p class="smp-muted" role="status">{on} of {usable.length} kind{usable.length === 1 ? "" : "s"} of metadata will be imported</p>
          </>
        )}
        <h3 class="smp-insp-section">Import settings</h3>
        <label class="fld">
          <span>Load</span>
          <select value={props.stream ? "stream" : "decode"} onChange={(e) => props.onStream((e.currentTarget as HTMLSelectElement).value === "stream")} aria-label="Load">
            <option value="decode">Decode on load</option>
            <option value="stream">Stream (long music)</option>
          </select>
        </label>
        {/* TODO(ADR 0119): Format and Sample rate are per-platform export settings; the sidecar has no audio export fields yet. */}
        <label class="fld">
          <span>Into folder</span>
          {newFolder === null ? (
            <select value={props.into} aria-label="Into folder" onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              if (v === "\u0000new") setNewFolder("");
              else props.onInto(v);
            }}>
              <option value="">Top level</option>
              {props.folders.filter((f) => !f.startsWith(".") && !f.includes("/.")).map((f) => <option key={f} value={f}>{f.split("/").join(" › ")}</option>)}
              {props.into && !props.folders.includes(props.into) && <option value={props.into}>{props.into.split("/").join(" › ")} (new)</option>}
              <option value={"\u0000new"}>+ New folder…</option>
            </select>
          ) : (
            <input autoFocus value={newFolder} placeholder="audio/sfx" aria-label="New folder path" onInput={(e) => setNewFolder((e.currentTarget as HTMLInputElement).value)}
              onBlur={() => {
                const clean = (newFolder ?? "").split("/").map((p) => p.trim()).filter(Boolean).join("/");
                if (clean) props.onInto(clean);
                setNewFolder(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
          )}
        </label>
        <label class="smp-check">
          <input type="checkbox" checked={props.keep} disabled={!hasStructure} onChange={(e) => props.onKeep((e.currentTarget as HTMLInputElement).checked)} />
          Keep structure (the picked folders inside {props.into ? props.into.split("/").join(" › ") : "the top level"})
        </label>
        {props.busy && props.progress && <p class="smp-muted" role="status">{props.progress}</p>}
        <div class="dialog-buttons">
          <button onClick={props.onCancel}>Cancel</button>
          <button class="primary" disabled={props.busy || props.files.length === 0} onClick={props.onImport}>
            {props.busy ? "Importing…" : `Import ${props.files.length} file${props.files.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
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

export function ImportDialog() {
  const project = currentProject.value;
  const [files, setFiles] = useState<Picked[] | null>(null);
  const [toggles, setToggles] = useState<KindToggles>({});
  const [into, setInto] = useState("");
  const [keep, setKeep] = useState(true);
  const [stream, setStream] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  if (!project) return null;
  const close = () => (dialog.value = null);
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
      <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        <div class="dialog smp-dialog" role="dialog" aria-modal="true" aria-label="Import samples" onKeyDown={(e) => e.key === "Escape" && close()}>
          <h2>Import samples</h2>
          <p class="smp-muted">Pick audio files, or a folder of them (its folders are kept). The files are copied into the project; the originals aren't changed.</p>
          <div class="smp-actions">
            <button class="primary" autoFocus onClick={() => filesInput.current?.click()}>Choose files…</button>
            <button onClick={() => void pickFolder()}>Choose a folder…</button>
          </div>
          <input ref={filesInput} type="file" multiple accept=".wav,.wave,.ogg,.mp3,.flac,.m4a,audio/*" hidden onChange={(e) => void take(fromInput((e.currentTarget as HTMLInputElement).files))} />
          <input ref={folderInput} type="file" hidden {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => void take(fromInput((e.currentTarget as HTMLInputElement).files))} />
          <div class="dialog-buttons">
            <button onClick={close}>Cancel</button>
          </div>
        </div>
      </div>
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
