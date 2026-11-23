// The Take screen's services over the real page (ADR 0348 "The Take screen"): opening a take file into the Studio's
// replay (`shell/replay.ts`, which keeps it open across screens), the timeline read from it, the selection, the take's
// notes as an asset document (the engine's undo tree; `<take>.notes.json`, a Studio-registered kind with no file
// ending, as the samples sidecar is), the takes' file actions (import into `takes/`; rename, move and delete through the
// Studio's moves and the engine's delete, the notes going with their take) and "Profile this replay". The panels call
// these; the models are elsewhere.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { emptyTakeNotes, formatTakeNotes, parseTakeNotes, takeNotesPath } from "../../../engine/audio/take/notes";
import type { Take } from "../../../engine/audio/take/reader";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { isLabelled } from "../../../engine/audio/parameters";
import { openAssetDocument, type AssetDocument } from "../../../editor/assetDocuments";
import { deleteAssets } from "../../../editor/assetDelete";
import { importFiles, whyNotImportable } from "../../../editor/assetImportFiles";
import { assetKinds } from "../../../editor/sdk/contributions";
import { currentProject, status } from "../../../editor/state";
import { studioScreenFor } from "../../../editor/studioAssets";
import { captureErrorMessage } from "../../../plugins/audio/editor/mix/openSaveFlow";
import { CaptureError } from "../../../plugins/audio/runtime/capture/format";
import { openTakeFile } from "../../../plugins/audio/runtime/capture/takeFile";
import { moveStudioAssets } from "../../boot/studioAssetMoves";
import { replayStore } from "../../shell/replay";
import { openRoute } from "../../shell/studioServices";
import { openMixDocument } from "../mixer/mixerDocument";
import { profilerRecorder } from "../profiler/profilerScreen";
import type { NotesEdit } from "./notesEdits";
import { TAKES_FOLDER, takeDeletion, takeMoves, whyNotTakeFile } from "./takeFiles";
import { takeTimeline, type TakeTimeline } from "./takeTimeline";

/** The notes document kind (no file ending: opened by path, so `*.json` files keep their own handling). */
export const TAKE_NOTES_KIND = "studio.takeNotes";

let registered = false;
/** Register the notes document format (once per page). */
export function registerTakeNotesKind(): void {
  if (registered) return;
  registered = true;
  assetKinds.register({
    id: TAKE_NOTES_KIND, extensions: [], label: "Take notes", icon: "M5 4h14v16H5z",
    format: {
      parse: (raw, path) => {
        const { value, problems } = parseTakeNotes(raw, path);
        return { value, problems: problems.map((message) => ({ message })) };
      },
      format: formatTakeNotes,
      empty: emptyTakeNotes,
    },
  });
}

export type TakeOpenState =
  | { readonly kind: "none" }
  | { readonly kind: "opening"; readonly path: string }
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "failed"; readonly path: string; readonly message: string };

/** What is selected on the timeline: an instance (its timeline key) or a note. */
export type TakeSelection = { readonly kind: "instance"; readonly key: string } | { readonly kind: "note"; readonly id: string } | null;

const messageOf = (e: unknown): string =>
  e instanceof CaptureError ? captureErrorMessage(e.code, e.message.replace(`${e.code} at ${e.offset}: `, "")) : e instanceof Error ? e.message : String(e);

/** A project file's bytes (its asset URL fetched). */
async function readProjectFile(path: string): Promise<ArrayBuffer> {
  const url = currentProject.peek()?.assets.get(path);
  if (typeof url !== "string") throw new Error(`${path} isn't in the project.`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't read ${path} (${res.status})`);
  return res.arrayBuffer();
}

/** A labelled global parameter's labels, from `audio.json` (instance parameters are read as numbers). */
function labelsOf(name: string, path: string | null): readonly string[] | null {
  if (path !== null) return null;
  const def = openMixDocument()?.value.peek().parameters.find((p) => p.name === name);
  return def && isLabelled(def) ? def.labels : null;
}

class TakeScreen {
  readonly state = signal<TakeOpenState>({ kind: "none" });
  readonly selected = signal<TakeSelection>(null);
  private run = 0;

  /** The open take (the replay store's). */
  readonly take: ReadonlySignal<Take | null> = computed(() => replayStore().open.value?.take ?? null);

  readonly timeline: ReadonlySignal<TakeTimeline | null> = computed(() => {
    const take = this.take.value;
    return take ? takeTimeline(take, labelsOf) : null;
  });

  /** The open take's notes document (null with no take or no project). */
  readonly notes: ReadonlySignal<AssetDocument<TakeNotes> | null> = computed(() => {
    const open = replayStore().open.value;
    const project = currentProject.value;
    if (!open || !project) return null;
    registerTakeNotesKind();
    return openAssetDocument<TakeNotes>(project, takeNotesPath(open.path), TAKE_NOTES_KIND);
  });

  /** Open take file `path` for replay (a no-op when it is the open one). A failure says why. */
  async openPath(path: string): Promise<void> {
    const open = replayStore().open.peek();
    if (open?.path === path) {
      this.state.value = { kind: "open", path };
      return;
    }
    const s = this.state.peek();
    if (s.kind === "opening" && s.path === path) return;
    const run = ++this.run;
    this.state.value = { kind: "opening", path };
    try {
      const bytes = new Uint8Array(await readProjectFile(path));
      const { take } = await openTakeFile(bytes);
      if (run !== this.run) return;
      replayStore().openTake(path, take);
      this.selected.value = null;
      this.state.value = { kind: "open", path };
    } catch (e) {
      if (run === this.run) this.state.value = { kind: "failed", path, message: messageOf(e) };
    }
  }

  /** Close the open take. */
  close(): void {
    this.run++;
    replayStore().close();
    this.selected.value = null;
    this.state.value = { kind: "none" };
  }

  /** Apply a notes edit as one undo step (a refusal goes to the status bar); `coalesce` merges a drag into one step. */
  commitNotes(edit: NotesEdit, options?: { coalesce?: boolean; select?: boolean }): boolean {
    const doc = this.notes.peek();
    if (!doc) return false;
    if ("refused" in edit) {
      status.value = { kind: "info", text: `Can't do that: ${edit.refused}.` };
      return false;
    }
    doc.edit(edit.next, { label: edit.label, coalesce: options?.coalesce });
    if (options?.select) this.selected.value = { kind: "note", id: edit.id };
    return true;
  }

  /**
   * "Profile this replay": the Profiler records the Studio's runtime while the take replays (ADR 0348), from the take's
   * start, so the replay capture's clock is the take's and the two screens share one review position (`reviewLink.ts`).
   */
  profileReplay(): void {
    const open = replayStore().open.peek();
    if (open) {
      open.replay.seek(0);
      if (!open.replay.playing.peek()) open.replay.play();
    }
    openRoute({ screen: "profiler" });
    void profilerRecorder().start();
  }
}

let screen: TakeScreen | null = null;

/** The screen's store. */
export function takeScreen(): TakeScreen {
  return (screen ??= new TakeScreen());
}

/** Open a take on the Take screen (the route says which, so a reload or a hand-off opens the same one). */
export const openTake = (path: string): void => openRoute({ screen: "take", asset: path });

/** Open the asset behind an instance on its screen ("fix it at the source"): a playlist on Playlists, a sample on Samples. */
export const openSource = (path: string): void => openRoute({ screen: studioScreenFor(path) ?? "playlists", asset: path });

/** Open take file…: copy chosen files into the project's takes folder, then open the first. */
export async function importTakes(files: readonly File[]): Promise<void> {
  const project = currentProject.peek();
  const refused = whyNotImportable(project);
  if (refused || !project) {
    status.value = { kind: "info", text: `Can't import takes: ${refused ?? "no project is open"}.` };
    return;
  }
  const wrong = files.map((f) => whyNotTakeFile(f.name)).find((r) => r !== null);
  if (wrong) {
    status.value = { kind: "info", text: wrong };
    return;
  }
  const r = await importFiles(project, TAKES_FOLDER, files.map((f) => ({ path: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) })));
  if (r.imported[0]) openTake(r.imported[0]);
  else if (r.failed[0]) status.value = { kind: "info", text: `Couldn't import ${r.failed[0].path}: ${r.failed[0].error}` };
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Rename a take (its notes follow); the open one stays open. */
export async function renameTake(path: string, name: string): Promise<void> {
  const folder = folderOf(path);
  await moveTakeTo(path, `${folder ? `${folder}/` : ""}${name}`, "Renamed");
}

/** Move a take to `folder` (its notes follow); the open one stays open. */
export async function moveTake(path: string, folder: string): Promise<void> {
  await moveTakeTo(path, `${folder ? `${folder}/` : ""}${nameOf(path)}`, "Moved");
}

async function moveTakeTo(from: string, to: string, verb: string): Promise<void> {
  if (from === to) return;
  const files = currentProject.peek()?.files ?? [];
  if (!(await moveStudioAssets(takeMoves(files, from, to), verb))) return;
  replayStore().moved(from, to);
  const s = takeScreen().state.peek();
  if (s.kind !== "none" && s.path === from) openTake(to);
}

/** Delete a take and its notes (the engine's delete asks first); the open one closes. */
export async function deleteTake(path: string): Promise<void> {
  const files = currentProject.peek()?.files ?? [];
  if (!(await deleteAssets(takeDeletion(files, path)))) return;
  if (replayStore().open.peek()?.path === path) takeScreen().close();
}
