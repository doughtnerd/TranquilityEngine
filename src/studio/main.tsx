// Audio Studio entry (ADR 0341 "One frontend, a new entry"): `studio.html` on the editor's frontend. It boots what
// the editor's story harness boots, made real: the core asset kinds, the audio plugin (its asset kinds, and its
// runtime for the Studio's own Engine), the theme, the start screen over the editor's project opening, the router,
// the audio runtime host and the keymap. `?sample=<id>` opens a sample and `?project=<folder>` a project folder (a path
// on the desktop; in a browser, the folder the editor's tab mounted, found among the recent projects); the hash picks
// the screen (`#/mixer?asset=…`, or the editor's `#/<screen>/<asset>`). In the desktop app the Studio window also
// serves the editor's hand-off (`myco://studio-open`, studioHandoff.ts): Window > Audio Studio and Open in Audio
// Studio open their project, screen and asset here. It never boots the scene editor.
import { render } from "preact";
import { Audio } from "../plugins/audio/runtime";
import { registerCoreAssetKinds } from "../editor/assetKinds.builtin";
import { errorStatus, installMessageLog } from "../editor/messages";
import { installProjectTheme } from "../editor/projectTheme";
import { status } from "../editor/state";
import { isTauri } from "../engine/platform/FileSystem";
import { setStartActions } from "../editor/startActions";
import type { StudioOpenRequest } from "../editor/studioAssets";
import { installTheme } from "../editor/theme";
import "../editor/ui/editor.css";
import "../editor/ui/fonts";
import { activateStudioPlugins } from "./boot/studioPlugins";
import { studioProjects } from "./boot/studioProject";
import { startRequest } from "./boot/startQuery";
import { takeOpenRequest, type RecentTake } from "./start/recentTakes";
import { engineRuntime } from "./runtime/engineRuntime";
import { createStudioAudioHost } from "./runtime/studioAudioHost";
import { startStudioDebugLink, studioBuild } from "./debugLink/studioLink";
import { openStudioConnect } from "./debugLink/StudioDebugLink";
import { installLiveConnect, openLiveSession } from "./shell/liveConnect";
import { OPENING_TIMEOUT_MS, studioOpening } from "./shell/opening";
import type { RouteRequest } from "./shell/route";
import { buildTakeSeams } from "./screens/take/buildTakes";
import { installProjectRecordings, keepBuildTake } from "./shell/projectRecordings";
import { followBuildSessions } from "./runtime/buildSession";
import { installBuildAudioDownloads, installBuildAudioMounts } from "./runtime/buildAudioSets";
import { followBuildWhenShown, profilerStore } from "./screens/profiler/profilerScreen";
import { installCalibration } from "./shell/applyCalibration";
import { installStudioKeys } from "./shell/installKeys";
import { installLongPress } from "./shell/longPress";
import { installLabelScrub } from "./components/labelScrub";
import "./components/formControls.css";
import { createRouter, windowHash } from "./shell/route";
import { StudioApp } from "./shell/StudioApp";
import { provideStudio } from "./shell/studioServices";
import "./studio.css";

async function main(): Promise<void> {
  installMessageLog();
  installTheme(); // before the first render, so it paints in the chosen theme
  installProjectTheme(); // a project's own .myco/theme.json, as in the editor (ADR 0116)
  registerCoreAssetKinds();
  const problems = activateStudioPlugins();
  if (problems.length > 0) status.value = { kind: "error", text: `The audio plugin didn't start: ${problems.join("; ")}` };

  const router = createRouter(windowHash());
  const runtime = createStudioAudioHost({
    starter: engineRuntime,
    audio: Audio,
    every: (ms, fn) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  });
  provideStudio({ router, runtime });
  const projects = studioProjects({ runtime, openRoute: (request) => router.open(request) });
  setStartActions({ open: projects.open, pickProjectLocation: projects.pickLocation });
  installStudioKeys();
  installLongPress(window);
  // The Studio's form controls everywhere on the page, dialogs and popovers included, and every number field's label
  // scrubs (spec §1.3, the owner's prototype).
  document.documentElement.classList.add("studio-forms");
  installLabelScrub(document);
  installCalibration(runtime);
  startStudioDebugLink(); // listens (desktop) and connects out by code; its menu and prompt sit in the status bar

  // The desktop app's Studio window is opened for a request (the launcher's, the editor's): it says "Opening…" until the
  // first one is handled, rather than flashing its start screen (ADR 0408).
  if (isTauri()) {
    studioOpening.value = "Opening…";
    setTimeout(() => (studioOpening.value = null), OPENING_TIMEOUT_MS);
  }
  render(<StudioApp onCloseProject={() => {
    projects.close();
    if (isTauri()) void returnToLauncher();
  }} onOpenTake={(take) => openTake(projects.handOff, take)} />, document.getElementById("app")!);
  // A request with `connect` (the launcher's Connect to Game…, ADR 0380) opens the Connect dialog once it's handled.
  // ADR 0408: a build that connects opens the Studio live (the takes folder with no project, the Profiler following);
  // a request with `follow` has the Profiler follow the connected build.
  installBuildAudioDownloads(); // ADR 0410: a connected build's audio, for replays without the project
  installBuildAudioMounts();
  installProjectRecordings(); // another project closes the last one's open recordings (Profiler, Take)
  // ADR 0417: one session per connected build: its takes (saved where the Studio keeps takes, whichever screen shows),
  // the live take and the Profiler's live capture on every screen, the picture width and Record session's clock (ADR
  // 0408, 0411); the last take it saved stays open once the build leaves (ADR 0412).
  followBuildSessions(studioBuild, (build) => ({ recorder: buildTakeSeams(build), follow: { store: profilerStore() }, keep: keepBuildTake }));
  installLiveConnect({ openTakes: projects.openTakes, openRoute: (request) => router.open(request) });
  const live = { openTakes: projects.openTakes, openRoute: (request: RouteRequest) => router.open(request) };
  const handle = (request: StudioOpenRequest) =>
    projects
      .handOff(request)
      // Connect to Game… opens the app itself: the live session (the takes folder with no project, on the Profiler),
      // with the Connect dialog over it (ADR 0408).
      .then(() => (request.connect ? openLiveSession(live) : undefined))
      .then(() => {
        if (request.follow) followBuildWhenShown();
        if (request.connect) openStudioConnect();
      })
      .finally(() => (studioOpening.value = null));
  if (isTauri()) await serveHandoff(handle);
  await projects.openRequest(startRequest(location.search));
}

/** A take picked on the start screen (ADR 0380): its project, or its folder as a takes workspace (ADR 0408), on the Take screen. Failures are in the status line. */
async function openTake(open: (request: StudioOpenRequest) => Promise<void>, take: RecentTake): Promise<void> {
  try {
    await open(takeOpenRequest(take));
  } catch (err) {
    status.value = errorStatus("Couldn't open the take", err);
  }
}

/**
 * Closing the project (or the takes folder) in the desktop app goes back to the launcher it came from (ADR 0412): this
 * window hides, keeping its debug link, and the launcher shows on Biosonic with its way back to the Foxfire apps. With
 * no launcher open, the Studio's own start screen stays.
 */
async function returnToLauncher(): Promise<void> {
  try {
    const [{ tauriBus, showProjectsWindow }, { getCurrentWindow, Window }] = await Promise.all([import("../editor/launcher/handoff"), import("@tauri-apps/api/window")]);
    if (!(await Window.getByLabel("projects"))) return;
    await getCurrentWindow().hide();
    await showProjectsWindow(await tauriBus());
  } catch (err) {
    console.warn("[studio] couldn't go back to the launcher:", err);
  }
}

/** The desktop app: answer the editor's hand-off over Tauri events (ADR 0341). The page serves it while it lives. */
async function serveHandoff(open: (request: StudioOpenRequest) => Promise<void>): Promise<void> {
  try {
    const [{ tauriBus }, { serveStudioOpen }] = await Promise.all([import("../editor/launcher/handoff"), import("../editor/studioHandoff")]);
    serveStudioOpen(await tauriBus(), open);
  } catch (err) {
    console.warn("[studio] can't take projects handed over by the editor:", err);
  }
}

main().catch((err) => {
  console.error(err);
  const pre = document.createElement("pre");
  pre.className = "studio-boot-error";
  pre.textContent = String(err?.stack ?? err);
  document.body.append(pre);
});
