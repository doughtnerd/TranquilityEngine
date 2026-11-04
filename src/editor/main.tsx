// Scene editor entry (ADR 0022, 0025, 0026). Renders the Preact layout on the start screen (ADR
// 0031): open a project folder (desktop editor only) or a sample. `?sample=<id>` opens a sample
// straight away. The desktop editor's window starts hidden instead, and opens the project its
// Projects window (projects.html) hands it (ADR 0059).
import { render } from "preact";
import { isTauri } from "../engine/platform/FileSystem";
import { installCloseGuard } from "./dialogs";
import { installMessageLog } from "./messages";
import { findSample } from "./samples";
import { copySampleToFolder, createProject, openProjectFolder, openRecentProject, openSample, openTestProject, pickProjectLocation } from "./session";
import { setStartActions } from "./startActions";
import { installShortcuts } from "./shortcuts";
import { installTheme } from "./theme";
import { App } from "./ui/App";
import "./ui/editor.css";

async function main(): Promise<void> {
  installMessageLog();
  installTheme(); // before the first render, so it paints in the chosen theme
  setStartActions({ openProjectFolder, openRecentProject, openSample, copySampleToFolder, pickProjectLocation, createProject });
  render(<App />, document.getElementById("app")!);
  installShortcuts();
  installCloseGuard();
  Object.assign(window, { openTestProject }); // end-to-end test hook
  if (isTauri()) await (await import("./launcher/editorWindow")).serveDesktopProjectsWindow();
  const sample = new URLSearchParams(location.search).get("sample");
  if (sample) await openSample(await findSample(sample));
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
