// The desktop editor's Projects window (ADR 0059): the start screen on its own, shown at start-up
// while the editor window loads hidden. Picking a project hands it to the editor window, and this
// window hides until the editor closes the project. It loads no engine code, so it shows at once.
// Outside the desktop app there's no second window, so it goes to the editor page instead.
import { signal } from "@preact/signals";
import { render } from "preact";
import { isTauri } from "../../engine/platform/FileSystem";
import { recentVersion } from "../recentProjects";
import { setStartActions } from "../startActions";
import { status } from "../state";
import { installTheme } from "../theme";
import { AboutDialog } from "../ui/AboutDialog";
import { NewProjectDialog } from "../ui/NewProjectDialog";
import { StartScreen } from "../ui/StartScreen";
import "../ui/editor.css";
import { launcherActions } from "./actions";
import { linkToEditor, tauriBus } from "./handoff";
import "./launcher.css";

/** False until the editor window has loaded (a project picked before then waits for it). */
const editorReady = signal(false);

function ProjectsWindow() {
  const s = status.value;
  return (
    <>
      <StartScreen />
      <p class={`projects-status${s?.kind === "error" ? " error" : ""}`} role="status">
        {s?.text ?? (editorReady.value ? "" : "Starting the editor…")}
      </p>
      <NewProjectDialog />
      <AboutDialog />
    </>
  );
}

async function main(): Promise<void> {
  if (!isTauri()) {
    location.replace(new URL("editor.html", location.href));
    return;
  }
  installTheme();
  const [bus, { getCurrentWindow }] = await Promise.all([tauriBus(), import("@tauri-apps/api/window")]);
  const window = getCurrentWindow();
  const link = linkToEditor(bus, () => {
    status.value = null;
    recentVersion.value++; // the editor may have added one
    void window.show().then(() => window.setFocus());
  });
  void link.ready.then(() => (editorReady.value = true));
  setStartActions(launcherActions(link, () => void window.hide()));
  render(<ProjectsWindow />, document.getElementById("app")!);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
