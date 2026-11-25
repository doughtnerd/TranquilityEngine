// The desktop app's launcher (ADR 0059, 0380): the Projects window, opening on the Foxfire Studios stage. Open on an
// application's card moves to that app's projects screen in the same page (Myco Engine, or Biosonic, the Audio
// Studio); its "‹ Foxfire launcher" goes back. A Myco project is handed to the editor window, which is created hidden
// once this window has painted and loads in the background (ADR 0082); a Biosonic project or take, and Connect to Game…, is handed to the
// Studio's window. This window then hides until the editor closes its project or the Studio window closes. It loads
// no engine code, so it shows at once. Outside the desktop app there's no second window, so it goes to the editor page.
import type { Window } from "@tauri-apps/api/window";
import { signal } from "@preact/signals";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { isTauri } from "../../engine/platform/FileSystem";
import { projectFileSystem } from "../projectFs";
import { recentProjects } from "../recentProjects";
import { setStartActions, type StartActions } from "../startActions";
import { errorStatus } from "../messages";
import { status } from "../state";
import { installTheme } from "../theme";
import "../ui/fonts";
import { AboutDialog } from "../ui/AboutDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { MycoProjectsScreen } from "../ui/appProjects/MycoProjectsScreen";
import { NewProjectDialog } from "../ui/NewProjectDialog";
import "../ui/editor.css";
import { addTakes, isTakeFilePath } from "../../studio/takesFolder";
import { BiosonicProjectsScreen, showRecordedTakes } from "../../studio/start/BiosonicProjectsScreen";
import { takeOpenRequest, type RecentTake } from "../../studio/start/recentTakes";
import { launcherActions } from "./actions";
import { startEditorWindow, startEditorWindowWhenIdle } from "./editorWindowStart";
import { FoxfireScreen, type LauncherApp } from "./FoxfireScreen";
import { linkToEditor, tauriBus, type EditorLink } from "./handoff";
import "./launcher.css";
import { openInStudioWindow, studioRequestFor } from "./studioWindow";
import { fitWindowToWorkArea } from "./windowSize";

/** The design's window size (logical px), fitted to a smaller work area at start. */
const WINDOW_SIZE = { width: 1280, height: 818 };

/** False until the editor window has loaded (a Myco project picked before then waits for it). */
const editorReady = signal(false);
/** Which stage shows. */
const stage = signal<"foxfire" | LauncherApp>("foxfire");

/** True while take files are being dragged over the window (the drop highlight). */
const droppingTakes = signal(false);

/**
 * Dropping .sporesample files on the window adds them to Recorded takes (ADR 0408): Tauri's webview drag-drop hands over
 * the files' paths. Anything else dropped is refused with a note.
 */
async function listenForTakeDrops(): Promise<void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent(({ payload: p }) => {
    if (p.type === "enter") droppingTakes.value = p.paths.some(isTakeFilePath);
    else if (p.type === "leave") droppingTakes.value = false;
    else if (p.type === "drop") {
      droppingTakes.value = false;
      const added = addTakes(p.paths);
      if (added.length === 0) {
        status.value = { kind: "info", text: "Only .sporesample files can be added to Recorded takes." };
        return;
      }
      stage.value = "biosonic";
      showRecordedTakes();
      status.value = { kind: "info", text: `Added ${added.length} ${added.length === 1 ? "take" : "takes"}` };
    }
  });
}

/** Minimise, maximise and close, laid over the top right (the window has no title bar). Close takes the usual route: the Rust side hides this window or quits. */
function WindowControls({ window }: { window: Window }) {
  return (
    <div class="window-controls">
      <button aria-label="Minimize" title="Minimize" onClick={() => void window.minimize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
      </button>
      <button aria-label="Maximize" title="Maximize" onClick={() => void window.toggleMaximize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5h9v9h-9z" /></svg>
      </button>
      <button class="close" aria-label="Close" title="Close" onClick={() => void window.close()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" /></svg>
      </button>
    </div>
  );
}

/** Fits the window to the monitor's work area once (a small screen), and drags it by the brand column (and the title-bar row over the projects list); a double-click there maximises. */
function useLauncherWindow(window: Window): void {
  useEffect(() => {
    void (async () => {
      const { LogicalSize, PhysicalPosition, currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
      const monitor = (await currentMonitor()) ?? (await primaryMonitor());
      if (!monitor) return;
      const area = { ...monitor.workArea.position, ...monitor.workArea.size };
      const fitted = fitWindowToWorkArea(WINDOW_SIZE, area, monitor.scaleFactor);
      await window.setSize(new LogicalSize(fitted.size.width, fitted.size.height));
      await window.setPosition(new PhysicalPosition(fitted.position.x, fitted.position.y));
    })().catch(console.error);
    const onBrand = (e: MouseEvent) => e.target instanceof Element && !!e.target.closest(".ff-brand, .ap-brand, .ap-titlebar") && !e.target.closest("button");
    const drag = (e: MouseEvent) => {
      if (e.button !== 0 || !onBrand(e)) return;
      if (e.detail === 2) void window.toggleMaximize();
      else void window.startDragging();
    };
    document.addEventListener("mousedown", drag);
    return () => document.removeEventListener("mousedown", drag);
  }, []);
}

interface LauncherProps {
  readonly window: Window;
  readonly actions: Record<LauncherApp, StartActions>;
  openTake(take: RecentTake): Promise<void>;
  /** Connect to Game…: the Studio window, with its Connect dialog open. */
  connect(): Promise<void>;
}

function Launcher({ window, actions, openTake, connect }: LauncherProps) {
  useLauncherWindow(window);
  const chrome = <WindowControls window={window} />;
  const show = (next: "foxfire" | LauncherApp) => {
    if (next !== "foxfire") setStartActions(actions[next]); // the New Project dialog and the projects tab open through these
    status.value = null;
    stage.value = next;
  };
  const back = () => show("foxfire");
  const s = stage.value;
  return (
    <div class={`launcher${droppingTakes.value ? " bs-dropping" : ""}`} data-floating-root="">
      {s === "foxfire" ? (
        <FoxfireScreen chrome={chrome} onOpen={show} />
      ) : s === "myco" ? (
        <MycoProjectsScreen chrome={chrome} back={back} note={editorReady.value ? undefined : "Starting the editor…"} />
      ) : (
        <BiosonicProjectsScreen chrome={chrome} back={back} onOpenTake={openTake} onConnect={() => void connect()} />
      )}
      <NewProjectDialog />
      <AboutDialog />
      <ConfirmDialog />
    </div>
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
  // The recent projects list hears the editor or Studio window add the project it opened (storage events), so it needn't be told here.
  const link = linkToEditor(bus, () => {
    status.value = null;
    void window.show().then(() => window.setFocus());
  });
  void link.ready.then(() => (editorReady.value = true));
  // The editor window is created once this one shows (ADR 0082), or at once if a project is picked first.
  const editor: EditorLink = { ready: link.ready, dispose: () => link.dispose(), open: (request) => startEditorWindow().then(() => link.open(request)) };
  const hide = () => void window.hide();
  const common = { opened: hide, folders: projectFileSystem, recent: recentProjects() };
  const actions: Record<LauncherApp, StartActions> = {
    myco: launcherActions({ ...common, link: editor }),
    biosonic: launcherActions({ ...common, link: { open: (request) => openInStudioWindow(studioRequestFor(request)) } }),
  };
  setStartActions(actions.myco);
  const openTake = async (take: RecentTake) => {
    status.value = { kind: "info", text: `Opening ${take.name}…` };
    try {
      await openInStudioWindow(takeOpenRequest(take));
      status.value = null;
      hide();
    } catch (err) {
      status.value = errorStatus(`Couldn't open ${take.name}`, err);
    }
  };
  // The Studio window holds the debug link (its Take, Profiler and Mixer screens use the build), so the launcher hands
  // Connect to Game… to it rather than connecting itself; whatever the Studio has open stays open.
  const connect = async () => {
    status.value = { kind: "info", text: "Opening the Audio Studio…" };
    try {
      await openInStudioWindow({ project: null, connect: true });
      status.value = null;
      hide();
    } catch (err) {
      status.value = errorStatus("Couldn't open the Audio Studio to connect", err);
    }
  };
  render(<Launcher window={window} actions={actions} openTake={openTake} connect={connect} />, document.getElementById("app")!);
  startEditorWindowWhenIdle();
  listenForTakeDrops().catch((err) => console.warn("[launcher] drag and drop of takes is unavailable:", err));
}

main().catch((err) => {
  console.error(err);
  // Styled by launcher.css (its token has a fallback for before the theme installs); the text is set as text, not markup.
  const pre = document.createElement("pre");
  pre.className = "launcher-fatal";
  pre.textContent = String(err?.stack ?? err);
  document.body.append(pre);
});
