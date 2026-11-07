// Dropping files from the OS onto the Assets panel (ADR 0085). In the browser the panel gets
// ordinary HTML5 drag events; in the desktop editor Tauri swallows them and sends its own
// drag-drop event with absolute paths and a physical-pixel position. Either way the files go into
// the folder under the pointer (a folder tile, a breadcrumb or the tree), else the one showing.
import { signal } from "@preact/signals";
import { isTauri } from "../engine/platform/FileSystem";
import { filesOfDrop, filesOfPaths, importFiles, whyNotImportable } from "./assetImportFiles";
import { folderPath } from "./assetSelection";
import { currentProject, status } from "./state";

/** True while files are dragged over the Assets panel from outside. */
export const osDragOver = signal(false);
/** The folder (project path, "" for the root) the pointer is over while dragging, if it is over one. */
export const osDragFolder = signal<string | null>(null);

/** The folder a drop at this point lands in: the folder element under it, else the one showing. */
export function dropFolderAt(el: Element | null): string {
  const target = el?.closest<HTMLElement>("[data-drop-folder]");
  return target ? (target.dataset.dropFolder ?? "") : folderPath.value;
}

const inPanel = (el: Element | null) => !!el?.closest(".asset-browser");
const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");

function reset(): void {
  osDragOver.value = false;
  osDragFolder.value = null;
}

/** Listen for drops onto the Assets panel. Returns a function that stops listening. */
export function installOsDrop(): () => void {
  const stops: (() => void)[] = [];

  const onOver = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    const el = e.target as Element | null;
    if (!inPanel(el)) return reset();
    e.preventDefault();
    const refuse = whyNotImportable(currentProject.peek());
    if (e.dataTransfer) e.dataTransfer.dropEffect = refuse ? "none" : "copy";
    osDragOver.value = true;
    osDragFolder.value = el?.closest("[data-drop-folder]") ? dropFolderAt(el) : null;
  };
  const onLeave = (e: DragEvent) => {
    if (!e.relatedTarget || !inPanel(e.relatedTarget as Element)) reset();
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer) || !inPanel(e.target as Element | null)) return;
    e.preventDefault();
    const folder = dropFolderAt(e.target as Element | null);
    reset();
    const project = currentProject.peek();
    const refuse = whyNotImportable(project);
    if (refuse || !project) {
      status.value = { kind: "error", text: `Can't import files: ${refuse}.` };
      return;
    }
    // The items are read synchronously by filesOfDrop; the files are read as each is written.
    void filesOfDrop(e.dataTransfer!).then((files) => importFiles(project, folder, files));
  };
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  stops.push(() => {
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
  });

  if (isTauri()) {
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        const at = "position" in p ? document.elementFromPoint(p.position.x / window.devicePixelRatio, p.position.y / window.devicePixelRatio) : null;
        if (p.type === "leave" || (p.type !== "drop" && !inPanel(at))) return reset();
        if (!inPanel(at)) return reset();
        if (p.type === "enter" || p.type === "over") {
          osDragOver.value = true;
          osDragFolder.value = at?.closest("[data-drop-folder]") ? dropFolderAt(at) : null;
          return;
        }
        const folder = dropFolderAt(at);
        reset();
        const project = currentProject.peek();
        const refuse = whyNotImportable(project);
        if (refuse || !project?.fileSystem) {
          status.value = { kind: "error", text: `Can't import files: ${refuse ?? "no file system"}.` };
          return;
        }
        const fs = project.fileSystem;
        void filesOfPaths(fs, p.paths).then((files) => importFiles(project, folder, files));
      });
      if (cancelled) stop();
      else stops.push(stop);
    });
    stops.push(() => (cancelled = true));
  }
  return () => {
    reset();
    for (const stop of stops) stop();
  };
}
