// Scene editor entry (ADR 0022, 0025, 0026). Renders the Preact layout on the start screen (ADR
// 0031): open a project folder (desktop editor only) or a sample. `?sample=<id>` opens a sample
// straight away. The desktop editor's window starts hidden instead, and opens the project its
// Projects window (projects.html) hands it (ADR 0059).
//
// Start-up order (ADR 0082): in the browser the start screen shows first, from the few modules it
// needs (as the desktop Projects window does), while the editor's layout, the session and the engine
// load behind it; its buttons wait for the session if they are clicked first. Then the panels the
// layout shows load (ADR 0083), and once idle the rest of the panels and the engine's chunks.
import "../plugins/editorBoot"; // first: registers plugin contributions before the layout store loads (ADR 0133)
import { render } from "preact";
import { isTauri } from "../engine/platform/FileSystem";
import { installCloseGuard } from "./dialogs";
import { layout } from "./layout/store";
import { installMessageLog } from "./messages";
import { prefetchWhenIdle } from "./prefetch";
import { findSample } from "./samples";
import { setStartActions, type StartActions } from "./startActions";
import { installProjectTheme } from "./projectTheme";
import { installTheme } from "./theme";
import { AboutDialog } from "./ui/AboutDialog";
import "./ui/editor.css";
import "./ui/fonts";
import { NewProjectDialog } from "./ui/NewProjectDialog";
import { StartScreen } from "./ui/StartScreen";

const session = () => import("./session");

/** The start screen's actions, each loading the session first (usually loaded by the time one is clicked). */
const startActions: StartActions = {
  openProjectFolder: async () => (await session()).openProjectFolder(),
  openRecentProject: async (entry) => (await session()).openRecentProject(entry),
  openSample: async (sample) => (await session()).openSample(sample),
  copySampleToFolder: async (sample) => (await session()).copySampleToFolder(sample),
  pickProjectLocation: async () => (await session()).pickProjectLocation(),
  createProject: async (fs, parent, name, template) => (await session()).createProject(fs, parent, name, template),
};

async function main(): Promise<void> {
  installMessageLog();
  installTheme(); // before the first render, so it paints in the chosen theme
  installProjectTheme(); // a project's own .myco/theme.json overrides it while the project is open (ADR 0116)
  setStartActions(startActions);
  // End-to-end test hook; usable before the session has loaded.
  Object.assign(window, { openTestProject: async (extra?: Record<string, string>) => (await session()).openTestProject(extra) });
  const root = document.getElementById("app")!;
  const sample = new URLSearchParams(location.search).get("sample");
  const load = () => Promise.all([import("./ui/App"), import("./shortcuts"), import("./ui/panels"), session()]);
  const shell = !isTauri() && !sample;
  // With the start screen showing, the rest starts after its first paint, so parsing it doesn't delay that paint.
  const app = shell ? new Promise<void>((painted) => requestAnimationFrame(() => setTimeout(painted, 0))).then(load) : load();
  if (shell) {
    render(
      <div class="editor editor-starting">
        <StartScreen />
        <NewProjectDialog />
        <AboutDialog />
      </div>,
      root,
    );
  }
  const [{ App }, { installShortcuts }, { preloadPanels }] = await app;
  render(<App />, root);
  installShortcuts();
  installCloseGuard();
  if (isTauri()) await (await import("./launcher/editorWindow")).serveDesktopProjectsWindow();
  // A sample to open goes first; the background loading waits for it so as not to compete.
  const opening = sample ? (await session()).openSample(await findSample(sample)) : Promise.resolve();
  void preloadPanels(layout.peek()); // the panels the layout shows, the rest when idle (ADR 0083)
  await opening;
  prefetchWhenIdle();
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
