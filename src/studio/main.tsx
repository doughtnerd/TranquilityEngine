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
import { installMessageLog } from "../editor/messages";
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
import { engineRuntime } from "./runtime/engineRuntime";
import { createStudioAudioHost } from "./runtime/studioAudioHost";
import { installCalibration } from "./shell/applyCalibration";
import { installStudioKeys } from "./shell/installKeys";
import { installLongPress } from "./shell/longPress";
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
  installCalibration(runtime);

  render(<StudioApp onCloseProject={projects.close} />, document.getElementById("app")!);
  if (isTauri()) await serveHandoff(projects.handOff);
  await projects.openRequest(startRequest(location.search));
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
