// The Take screen's services over the real page (ADR 0348 "The Take screen"): opening a take file into the Studio's
// replay (`shell/replay.ts`, which keeps it open across screens), the timeline read from it, the selection, the take's
// notes as an asset document (the engine's undo tree; `<take>.notes.json`, a Studio-registered kind with no file
// ending, as the samples sidecar is), what is special about takes for the Takes tree's file actions (`takeFileKind`:
// the notes go with their take, the open take follows a move and closes on a delete; `runFileActions.ts` does the rest)
// and "Profile this replay". The panels call these; the models are elsewhere.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { emptyTakeNotes, formatTakeNotes, parseTakeNotes, takeNotesPath } from "../../../engine/audio/take/notes";
import type { Take } from "../../../engine/audio/take/reader";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { isLabelled } from "../../../engine/audio/parameters";
import { openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { assetKinds } from "../../../editor/sdk/contributions";
import { currentProject, docVersion, status } from "../../../editor/state";
import { studioScreenFor } from "../../../editor/studioAssets";
import { captureErrorMessage } from "../../../plugins/audio/editor/mix/openSaveFlow";
import { CAPTURE_FLAG_TAKE, CaptureError, readCaptureHeader } from "../../../plugins/audio/runtime/capture/format";
import { isTakesFolder } from "../../../editor/projects";
import { mountBuildAudioFor, unmountBuildAudio } from "../../runtime/buildAudioSets";
import { openTakeFile } from "../../../plugins/audio/runtime/capture/takeFile";
import { replayStore } from "../../shell/replay";
import { audioProject } from "../../shell/audioProject";
import { openRoute } from "../../shell/studioServices";
import { openMixDocument } from "../mixer/mixerDocument";
import { profilerRecorder, profilerStore, refuseWhileLive, stopFollowingBuild } from "../profiler/profilerScreen";
import type { NotesEdit } from "./notesEdits";
import type { RunFileKind } from "../profiler/runFileActions";
import { TAKES_FOLDER, takeDeletion, whyNotTakeFile } from "./takeFiles";
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
  /** ADR 0409: a recording with no take data (a Profiler capture): the Profiler shows it. */
  | { readonly kind: "noTake"; readonly path: string }
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
  /** The Takes tree's selected folder (where Open take file… and New folder go), null for none. */
  readonly folder = signal<string | null>(null);
  /** The game parameter under the pointer, on a lane or an Inspector card: both outline it (the prototype's hover link). */
  readonly hovered = signal<string | null>(null);
  /** The lane the Inspector shows with nothing selected: the last instance's path picked (else the first lane). */
  readonly focusPath = signal<string | null>(null);
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
      // The replay already holds it; the Profiler may show another recording since (one recording for both screens).
      void profilerStore().openPath(path);
      return;
    }
    const s = this.state.peek();
    if (s.kind === "opening" && s.path === path) return;
    const run = ++this.run;
    this.state.value = { kind: "opening", path };
    try {
      // One recording for both screens (ADR 0408): the Profiler opens its profile too, so switching tabs keeps it.
      void profilerStore().openPath(path);
      const bytes = new Uint8Array(await readProjectFile(path));
      if ((readCaptureHeader(bytes).flags & CAPTURE_FLAG_TAKE) === 0) {
        if (run !== this.run) return;
        if (replayStore().open.peek()) replayStore().close();
        this.selected.value = null;
        this.state.value = { kind: "noTake", path };
        return;
      }
      const { take } = await openTakeFile(bytes);
      if (run !== this.run) return;
      replayStore().openTake(path, take);
      this.selected.value = null;
      this.state.value = { kind: "open", path };
      // ADR 0410: in a takes folder, the build audio downloaded for this take's project and mix, so it replays with sound.
      if (isTakesFolder(currentProject.peek())) void mountBuildAudioFor(take.meta);
    } catch (e) {
      if (run !== this.run) return;
      // The screen now names the failed take: the take open before it closes, so the tree, the timeline and the player
      // bar never show one take beside another's error (journeys walk 2, J10.2).
      if (replayStore().open.peek()) replayStore().close();
      this.selected.value = null;
      this.state.value = { kind: "failed", path, message: messageOf(e) };
    }
  }

  /**
   * Follow the route's asset: open the take it names (`openPath`), or, when it names none (or one that isn't a take
   * in the project), drop a failure, which belonged to the take the route named before.
   */
  follow(asset: string | undefined, isTake: boolean): void {
    if (asset && isTake) {
      void this.openPath(asset);
      return;
    }
    const s = this.state.peek();
    if (s.kind === "failed" || s.kind === "opening" || s.kind === "noTake") {
      this.run++;
      this.state.value = replayStore().open.peek() ? { kind: "open", path: replayStore().open.peek()!.path } : { kind: "none" };
    }
  }

  /** The take the screen shows or tries to: the failed or opening one, else the open replay's (the Takes tree selects it). */
  shownPath(): string | null {
    const s = this.state.value;
    if (s.kind === "failed" || s.kind === "opening" || s.kind === "noTake") return s.path;
    return replayStore().open.value?.path ?? null;
  }

  /** Close the open take. */
  close(): void {
    unmountBuildAudio();
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
   * "Show profile": the engine's profile the take recorded beside its requests (a take holds both, ADR 0348), on the
   * Profiler at the playhead. The two screens share one review position (`reviewLink.ts`).
   */
  showProfile(): void {
    const open = replayStore().open.peek();
    if (!open) return;
    stopFollowingBuild();
    openRoute({ screen: "profiler", asset: open.path });
  }

  /**
   * "Profile this replay": the Profiler records the Studio's runtime while the take replays (ADR 0348), from the take's
   * start, so the replay capture's clock is the take's and the two screens share one review position (`reviewLink.ts`).
   */
  profileReplay(): void {
    // The build's live feed would replace the recording on the Profiler's timeline (ADR 0408).
    stopFollowingBuild();
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

/** The playlist at `path` as the project has it now (an open document's edits included), or null when it isn't one. */
export function takePlaylist(path: string): PlaylistAsset | null {
  // ADR 0410: in a takes folder, the build's downloaded audio (read-only).
  const project = audioProject.value;
  void docVersion.value;
  if (!project || !isPlaylistPath(path) || !project.files.includes(path)) return null;
  try {
    return readAsset<PlaylistAsset>(project, path, "playlist").value;
  } catch {
    return null;
  }
}

/** The project's global parameter definitions (`audio.json`). */
export function globalParameters(): readonly ParameterDef[] {
  return openMixDocument()?.value.value.parameters ?? [];
}

/**
 * Open a recording on the Take screen (the route says which, so a reload or a hand-off opens the same one); the Profiler
 * opens it too (ADR 0408: one recording for both screens). While a game is connected both screens show it live, so a
 * saved recording waits until it disconnects.
 */
export const openTake = (path: string): void => {
  if (refuseWhileLive(path)) return;
  openRoute({ screen: "take", asset: path });
};

/** Open the asset behind an instance on its screen ("fix it at the source"): a playlist on Playlists, a sample on Samples. */
export const openSource = (path: string): void => openRoute({ screen: studioScreenFor(path) ?? "playlists", asset: path });


/** Takes for the Takes tree's actions: a take's notes go with it; the open take follows a move and closes on a delete. */
export const takeFileKind: RunFileKind = {
  noun: "take",
  defaultFolder: TAKES_FOLDER,
  whyNotFile: whyNotTakeFile,
  companions: takeDeletion,
  openPath: () => replayStore().open.peek()?.path ?? null,
  open: openTake,
  moved(from, to) {
    replayStore().moved(from, to);
    const s = takeScreen().state.peek();
    if (s.kind !== "none" && s.path === from) openTake(to);
  },
  closed: () => takeScreen().close(),
};
