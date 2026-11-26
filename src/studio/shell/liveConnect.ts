// Connecting opens the Studio live (ADR 0408): when a build connects with no project open, the Studio opens the takes
// folder as a takes workspace on the Profiler; with a project open it does the same only after Connect to Game… or a
// connect hand-off (a build connecting by itself doesn't pull the user off their screen). Either way the Profiler follows
// the build's live capture at once.
import { effect } from "@preact/signals";
import { currentProject, status } from "../../editor/state";
import { errorStatus } from "../../editor/messages";
import { studioBuild } from "../debugLink/studioLink";
import { followBuildWhenShown } from "../screens/profiler/profilerScreen";
import { chooseTakesFolder, defaultTakesFolder, takesFolderChoice } from "../takesFolder";
import type { FileSystem } from "../../engine/platform/FileSystem";
import type { RouteRequest } from "./route";

export interface LiveConnectHost {
  /** Open a folder of takes as a takes workspace (`StudioProjects.openTakes`), on `fs` when given. */
  openTakes(root: string, fs?: FileSystem): Promise<void>;
  openRoute(request: RouteRequest): void;
}

/** The browser live session's takes folder (in memory), as the header names it. */
const LIVE_SESSION = "C:/Live session";

let asked = false;
let liveHost: LiveConnectHost | null = null;

/**
 * Change… on the Take screen of a takes folder workspace: choose another takes folder and open it in place, on Take.
 * Nothing happens when the dialog is cancelled.
 */
export async function changeTakesFolder(fs: FileSystem): Promise<void> {
  const picked = await chooseTakesFolder(fs);
  if (!picked || !liveHost) return;
  try {
    await liveHost.openTakes(picked);
    liveHost.openRoute({ screen: "take" });
  } catch (err) {
    status.value = errorStatus(`Couldn't open the takes folder ${picked}`, err);
  }
}

/** The user asked to connect (Connect to Game…, the launcher's hand-off): the next build that connects opens live. */
export function goLiveOnConnect(): void {
  asked = true;
}

/** Open the Studio live on the connected build: the takes workspace when no project is open, the Profiler following. */
export async function goLive(host: LiveConnectHost): Promise<void> {
  if (await openLiveSession(host)) followBuildWhenShown();
}

/**
 * The live session without a build yet (the launcher's Connect to Game…, so the app opens rather than its start
 * screen): the takes workspace when no project is open, on the Profiler. Resolves false when it couldn't open.
 */
export async function openLiveSession(host: LiveConnectHost): Promise<boolean> {
  if (!currentProject.peek()) {
    const folder = takesFolderChoice.peek() ?? (await defaultTakesFolder());
    try {
      if (folder) await host.openTakes(folder);
      // A browser page has no takes folder: its live session keeps its takes in memory, and Save asks where each goes.
      else await host.openTakes(LIVE_SESSION, new (await import("../../editor/memoryFs")).MemoryFileSystem());
    } catch (err) {
      status.value = errorStatus(`Couldn't open the takes folder ${folder ?? "for the live session"}`, err);
      return false;
    }
  }
  host.openRoute({ screen: "profiler" });
  return true;
}

/** Watch the link: each newly connected build opens live as the header says. Returns the stop. */
export function installLiveConnect(host: LiveConnectHost): () => void {
  liveHost = host;
  let last = studioBuild.peek()?.peer ?? null;
  return effect(() => {
    const build = studioBuild.value;
    const peer = build?.peer ?? null;
    if (peer === last) return;
    last = peer;
    if (!build) return;
    const wanted = asked || !currentProject.peek();
    asked = false;
    if (wanted) void goLive(host);
  });
}
