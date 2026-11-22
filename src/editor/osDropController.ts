// Dropping files from the OS onto the Assets panel (ADR 0085, 0324): one controller decides, for
// a drag at an element, whether it is over the panel, which folder a drop lands in (the folder
// element under the pointer, a folder tile, a breadcrumb or the tree, else the one showing), the
// hover state the panel draws, whether the open project refuses the import, and runs the import.
// Two adapters translate their platform's events into the controller's three phases (over, left,
// dropped): the browser's HTML5 drag events (an element target, a DataTransfer) and the desktop's
// Tauri drag-drop event (a physical-pixel position, absolute paths read through the file system).
import { signal } from "@preact/signals";
import type { FileSystem } from "../engine/platform/FileSystem";
import { filesOfDrop, filesOfPaths, importFiles, whyNotImportable, type ImportResult, type IncomingFile } from "./assetImportFiles";
import { folderPath } from "./assetSelection";
import { currentProject, status } from "./state";

/** What the Assets panel draws while files are dragged over it from outside. */
export interface OsDragState {
  /** The folder (project path, "" for the root) the pointer is over, if it is over one and the drop would be accepted. */
  folder: string | null;
  /** Why the open project refuses the drop, or null. */
  refused: string | null;
}

/** The drag over the Assets panel from outside, or null when there is none. */
export const osDrag = signal<OsDragState | null>(null);

/** What a drop did: it was not on the panel, the project refused it, or the files are being imported. */
export type DropOutcome = { kind: "outside" } | { kind: "refused"; reason: string } | { kind: "importing"; folder: string; done: Promise<ImportResult> };

/** The three phases of an OS drag, at the element under the pointer. */
export interface OsDropController {
  /** Files are dragged over `at`. Updates `osDrag`; says what a drop there would do. */
  over(at: Element | null): "outside" | "accepted" | "refused";
  /** The drag left for `to` (null: out of the window, or cancelled); moving within the panel keeps it. */
  left(to: Element | null): void;
  /**
   * Files were dropped on `at`. When the drop is accepted, `read` is called before this returns (a
   * browser's DataTransfer items are gone after the event) with the project's file system, and the
   * files it gives are imported.
   */
  dropped(at: Element | null, read: (fs: FileSystem) => Promise<IncomingFile[]>): DropOutcome;
}

const inPanel = (el: Element | null) => !!el?.closest?.(".asset-browser");
const folderElement = (el: Element | null) => el?.closest?.<HTMLElement>("[data-drop-folder]") ?? null;

export function createOsDropController(): OsDropController {
  const reset = () => (osDrag.value = null);
  return {
    over(at) {
      if (!inPanel(at)) {
        reset();
        return "outside";
      }
      const refused = whyNotImportable(currentProject.peek());
      const folder = refused ? null : (folderElement(at)?.dataset.dropFolder ?? null);
      const prev = osDrag.peek();
      if (prev?.folder !== folder || prev?.refused !== refused) osDrag.value = { folder, refused };
      return refused ? "refused" : "accepted";
    },
    left(to) {
      if (!inPanel(to)) reset();
    },
    dropped(at, read) {
      reset();
      if (!inPanel(at)) return { kind: "outside" };
      const project = currentProject.peek();
      const reason = whyNotImportable(project);
      const fs = project?.fileSystem;
      if (reason !== null || !project || !fs) {
        const why = reason ?? "no project is open";
        status.value = { kind: "error", text: `Can't import files: ${why}.` };
        return { kind: "refused", reason: why };
      }
      const folder = folderElement(at)?.dataset.dropFolder ?? folderPath.peek();
      const done = read(fs).then((files) => importFiles(project, folder, files));
      return { kind: "importing", folder, done };
    },
  };
}

// --- Drop sources --------------------------------------------------------------------------------

const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");

/** Feed a window's HTML5 drag events of files to the controller. Returns a function that stops listening. */
export function listenBrowserDrops(win: Pick<Window, "addEventListener" | "removeEventListener">, drop: OsDropController): () => void {
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    const result = drop.over(e.target as Element | null);
    if (result === "outside") return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = result === "refused" ? "none" : "copy";
  };
  const onLeave = (e: DragEvent) => drop.left(e.relatedTarget as Element | null);
  const onDrop = (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt || !hasFiles(dt)) return;
    // Not the browser's navigation to the file, even when refused.
    if (drop.dropped(e.target as Element | null, () => filesOfDrop(dt)).kind !== "outside") e.preventDefault();
  };
  win.addEventListener("dragover", onOver as EventListener);
  win.addEventListener("dragleave", onLeave as EventListener);
  win.addEventListener("drop", onDrop as EventListener);
  return () => {
    win.removeEventListener("dragover", onOver as EventListener);
    win.removeEventListener("dragleave", onLeave as EventListener);
    win.removeEventListener("drop", onDrop as EventListener);
  };
}

/** The desktop's drag-drop event (Tauri's webview `DragDropEvent`): the position is in physical pixels. */
export type DesktopDragEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/** Where desktop drag-drop events come from (Tauri's current webview). */
export interface DesktopDropSource {
  onDragDropEvent(handler: (event: { payload: DesktopDragEvent }) => void): Promise<() => void>;
}

/** What the desktop adapter reads of the page: the element at a point in CSS pixels, and CSS pixels per physical pixel. */
export interface DropView {
  elementFromPoint(x: number, y: number): Element | null;
  readonly devicePixelRatio: number;
}

/** Feed a desktop drag-drop source to the controller. Returns a function that stops listening (also before the source has started). */
export function listenDesktopDrops(source: DesktopDropSource, view: DropView, drop: OsDropController): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  void source
    .onDragDropEvent(({ payload: p }) => {
      if (p.type === "leave") return drop.left(null);
      const r = view.devicePixelRatio;
      const at = view.elementFromPoint(p.position.x / r, p.position.y / r);
      if (p.type === "drop") drop.dropped(at, (fs) => filesOfPaths(fs, p.paths));
      else drop.over(at);
    })
    .then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    });
  return () => {
    stopped = true;
    stop?.();
  };
}
