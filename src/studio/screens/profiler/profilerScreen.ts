// The Profiler screen's services over the real page (ADR 0334): its one store and recorder, made on first use over the
// open project, the capture Worker and the Studio's audio runtime (`audioHost().audio.capture`, the public API, and the
// recorder's live ring through the `LiveHost` seam the editor's Profiler panel uses), and the captures' file actions
// through the engine's asset operations (import, delete) and the Studio's moves (rename, move: studioAssetMoves.ts, which
// leave the editor the references it owns while it has the project open). The panels call these; the models are elsewhere.
import { importFiles, whyNotImportable } from "../../../editor/assetImportFiles";
import { deleteAssets } from "../../../editor/assetDelete";
import { currentProject, status } from "../../../editor/state";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { captureFileBytes, captureLiveHost } from "../../../plugins/audio/runtime/capture/capture";
import { moveStudioAssets, renameStudioAsset } from "../../boot/studioAssetMoves";
import { audioHost, openRoute } from "../../shell/studioServices";
import { CaptureRecorder } from "./captureRecorder";
import { CAPTURES_FOLDER, whyNotCaptureFile } from "./captureTree";
import { ProfilerStore } from "./profilerStore";

let store: ProfilerStore | null = null;
let recorder: CaptureRecorder | null = null;

/** A project file's bytes (its asset URL fetched: a blob URL for a folder project, a served file for a sample). */
async function readProjectFile(path: string): Promise<ArrayBuffer> {
  const project = currentProject.peek();
  const url = project?.assets.get(path);
  if (typeof url !== "string") throw new Error(`${path} isn't in the project.`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't read ${path} (${res.status})`);
  return res.arrayBuffer();
}

/** The screen's store. */
export function profilerStore(): ProfilerStore {
  return (store ??= new ProfilerStore({ open: (bytes) => CaptureSource.openFile(bytes), readFile: readProjectFile }));
}

/** Write capture bytes into the project's captures folder (never over a file); resolves with the path written. */
async function writeCapture(path: string, bytes: Uint8Array): Promise<string> {
  const project = currentProject.peek();
  const refused = whyNotImportable(project);
  if (refused || !project) throw new Error(refused ?? "no project is open");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const r = await importFiles(project, CAPTURES_FOLDER, [{ path: name, read: async () => bytes }]);
  if (r.imported.length === 0) throw new Error(r.failed[0]?.error ?? `couldn't write ${path}`);
  return r.imported[0]!;
}

/** The screen's recorder of the Studio's runtime. */
export function profilerRecorder(): CaptureRecorder {
  return (recorder ??= new CaptureRecorder({
    capture: audioHost().audio.capture,
    liveHost: captureLiveHost,
    store: {
      openLive: (source, title) => profilerStore().openLive(source, title),
      refreshLive: () => profilerStore().refreshLive(),
      close: () => profilerStore().close(),
      // The saved capture opens through the route, as a click in Captures does.
      openPath: (path) => {
        openCapture(path);
        return profilerStore().openPath(path);
      },
    },
    files: () => currentProject.peek()?.files ?? [],
    // The take's file, as `Audio.capture.save` would write it, written into the project on every platform (D13).
    fileBytes: captureFileBytes,
    write: writeCapture,
  }));
}

/** Open a capture on the Profiler (the route says which, so a reload or a hand-off opens the same one). */
export const openCapture = (path: string): void => openRoute({ screen: "profiler", asset: path });

/** Open capture file…: copy chosen files into the project's captures folder, then open the first. */
export async function importCaptures(files: readonly File[]): Promise<void> {
  const project = currentProject.peek();
  const refused = whyNotImportable(project);
  if (refused || !project) {
    status.value = { kind: "info", text: `Can't import captures: ${refused ?? "no project is open"}.` };
    return;
  }
  const wrong = files.map((f) => whyNotCaptureFile(f.name)).find((r) => r !== null);
  if (wrong) {
    status.value = { kind: "info", text: wrong };
    return;
  }
  const r = await importFiles(project, CAPTURES_FOLDER, files.map((f) => ({ path: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) })));
  if (r.imported[0]) openCapture(r.imported[0]);
}

/** Rename a capture file in its folder; the open one follows. */
export async function renameCapture(path: string, name: string): Promise<void> {
  const to = `${path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : ""}${name}`;
  if (await renameStudioAsset(path, name)) followMove(path, to);
}

/** Move a capture file to `folder`; the open one follows. */
export async function moveCapture(path: string, folder: string): Promise<void> {
  const to = `${folder ? `${folder}/` : ""}${path.slice(path.lastIndexOf("/") + 1)}`;
  if (await moveStudioAssets([[path, to]])) followMove(path, to);
}

/** Delete a capture file (the engine's delete asks first); the open one closes. */
export async function deleteCapture(path: string): Promise<void> {
  if (!(await deleteAssets([path]))) return;
  const s = profilerStore().state.peek();
  if ((s.kind === "open" || s.kind === "failed") && s.path === path) profilerStore().close();
}

function followMove(from: string, to: string): void {
  const s = profilerStore().state.peek();
  if (s.kind === "open" && s.path === from) openCapture(to);
}
