// The Profiler screen's services over the real page (ADR 0348): its one store and recorder, made on first use over the
// open project, the capture Worker and the Studio's audio runtime (`audioHost().audio.capture`, the public API, and the
// recorder's live ring through the `LiveHost` seam the editor's Profiler panel uses), and the captures' file actions
// (`captureLibrary`: the Studio asset library given what is special about captures, ADR 0433).
// The panels call these; the models are elsewhere.
import { signal } from "@preact/signals";
import { buildSession } from "../../runtime/buildSession";
import { importFiles, whyNotImportable } from "../../../editor/assetImportFiles";
import { currentProject, status } from "../../../editor/state";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { captureFileBytes, captureLiveHost, setCaptureReplayOf } from "../../../plugins/audio/runtime/capture/capture";
import { replayStore } from "../../shell/replay";
import { audioHost, openRoute } from "../../shell/studioServices";
import { CaptureRecorder } from "./captureRecorder";
import { CAPTURES_FOLDER, recordingExtension, whyNotCaptureFile } from "../run/captureTree";
import { ProfilerStore } from "./profilerStore";
import { linkReview } from "./reviewLink";
import { studioBuild } from "../../debugLink/studioLink";
import { studioLibrary } from "../../library/studioLibrary";

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

/** ADR 0408: follow the connected build as soon as the Profiler has it (connecting opens the Profiler live). */
let followWhenShown = false;

/** Ask the Profiler to follow the connected build's live capture as soon as it shows (now, if it does). */
export function followBuildWhenShown(): void {
  followWhenShown = true;
  startPendingFollow();
}

/** Start the follow asked for, once the connected build's session has its capture follow (`buildSession`, ADR 0417). */
export function startPendingFollow(): void {
  const session = buildSession.peek();
  const follow = session?.open ? session.follow : null;
  if (!followWhenShown || !follow || !studioBuild.peek() || follow.build.peer !== studioBuild.peek()?.peer) return;
  followWhenShown = false;
  void follow.start();
}

/**
 * Stop following the build's live capture, so what the Profiler is asked to show next stays shown (a file, a recording
 * of a replay; ADR 0408). Follow build starts it again.
 */
export function stopFollowingBuild(): void {
  followWhenShown = false;
  const follow = buildSession.peek()?.follow;
  if (follow?.following) follow.stop();
}

/** The screen's store; its cursor and the open take's replay are one review position (`reviewLink.ts`) for the page's life. */
export function profilerStore(): ProfilerStore {
  if (store) return store;
  store = new ProfilerStore({ open: (bytes) => CaptureSource.openFile(bytes), readFile: readProjectFile });
  linkReview(store, replayStore());
  return store;
}

/** Open in Take: the take on the Take screen at the Profiler's position (the review link seeks it once it is open). */
export const openInTake = (path: string): void => {
  if (refuseWhileLive(path)) return;
  openRoute({ screen: "take", asset: path });
};

/**
 * ADR 0408: while a game build is connected, Take and the Profiler always show it live, so a saved recording can't be
 * opened: says so in the status line and answers true. False when nothing is connected.
 */
export function refuseWhileLive(path: string): boolean {
  const build = studioBuild.peek();
  if (!build) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  status.value = { kind: "info", text: `Showing ${build.name} live: disconnect from it to open ${name}.` };
  return true;
}

/** Write capture bytes into the selected Captures folder (else the project's captures folder) (never over a file); resolves with the path written. */
async function writeCapture(path: string, bytes: Uint8Array): Promise<string> {
  const project = currentProject.peek();
  const refused = whyNotImportable(project);
  if (refused || !project) throw new Error(refused ?? "no project is open");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const r = await importFiles(project, captureFolder.peek() ?? CAPTURES_FOLDER, [{ path: name, read: async () => bytes }]);
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
    // ADR 0348: a recording made while a take replays is that take's replay capture, and names it in META.
    replaying: () => {
      const open = replayStore().open.peek();
      return open && open.replay.playing.peek() ? { path: open.path, audioHash: open.take.meta.audioHash } : null;
    },
    nameReplay: setCaptureReplayOf,
  }));
}

/** Open a capture on the Profiler (the route says which, so a reload or a hand-off opens the same one). */
export const openCapture = (path: string): void => {
  if (refuseWhileLive(path)) return;
  openRoute({ screen: "profiler", asset: path });
};

/** The Captures tree's selected folder: where Open capture file…, New folder and a new recording go (null: `recordings/`). */
export const captureFolder = signal<string | null>(null);

/** The Captures tree's file actions: the open capture follows a move and closes on a delete. */
export const captureLibrary = studioLibrary({
  noun: "capture",
  imports: { defaultFolder: CAPTURES_FOLDER, whyNotFile: whyNotCaptureFile },
  extension: recordingExtension,
  openPaths: () => {
    const s = profilerStore().state.peek();
    return (s.kind === "open" || s.kind === "failed" || s.kind === "opening") && s.path ? [s.path] : [];
  },
  open: openCapture,
  follow: (from, to) => followMove(from, to),
  closed: () => profilerStore().close(),
});

function followMove(from: string, to: string): void {
  const s = profilerStore().state.peek();
  if (s.kind === "open" && s.path === from) openCapture(to);
}
