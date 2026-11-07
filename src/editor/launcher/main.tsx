// The desktop editor's Projects window (ADR 0059): the start screen on its own, shown at start-up;
// once it has painted it creates the hidden editor window, which loads in the background (ADR 0082). Picking a project hands it to the editor window, and this
// window hides until the editor closes the project. It loads no engine code, so it shows at once.
// Outside the desktop app there's no second window, so it goes to the editor page instead.
import type { Window } from "@tauri-apps/api/window";
import { signal } from "@preact/signals";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { isTauri } from "../../engine/platform/FileSystem";
import { recentVersion } from "../recentProjects";
import { setStartActions } from "../startActions";
import { status } from "../state";
import { installTheme } from "../theme";
import "../ui/fonts";
import { AboutDialog } from "../ui/AboutDialog";
import { NewProjectDialog } from "../ui/NewProjectDialog";
import { StartScreen } from "../ui/StartScreen";
import "../ui/editor.css";
import { launcherActions } from "./actions";
import { startEditorWindow, startEditorWindowWhenIdle } from "./editorWindowStart";
import { linkToEditor, tauriBus, type EditorLink } from "./handoff";
import "./launcher.css";
import { fitWindowToWorkArea, measureScrollbar } from "./windowSize";

/** False until the editor window has loaded (a project picked before then waits for it). */
const editorReady = signal(false);

/** Minimise and close, laid over the banner (the window has no title bar). Close takes the usual route: the Rust side hides this window or quits. */
function WindowControls({ window }: { window: Window }) {
  return (
    <div class="window-controls">
      <button aria-label="Minimize" title="Minimize" onClick={() => void window.minimize()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
      </button>
      <button class="close" aria-label="Close" title="Close" onClick={() => void window.close()}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" /></svg>
      </button>
    </div>
  );
}

/**
 * Keeps the window the size of the start panel and the status line under it, capped to the work
 * area of the monitor it is on (scale factor and taskbar included; the page scrolls when capped),
 * and drags it by the banner. The first fit centres the window on that monitor; later fits (the
 * panel grows for New Project, the status line appears) keep where the user put it but nudge it
 * back inside the work area, since a window grows down from its top edge.
 */
function useCardWindow(window: Window): void {
  useEffect(() => {
    const card = document.querySelector<HTMLElement>(".start-card");
    const statusLine = document.querySelector<HTMLElement>(".projects-status");
    if (!card) return;
    const scrollbar = measureScrollbar(document);
    let frame = 0;
    let centred = false;
    const fit = async () => {
      frame = 0;
      const { LogicalSize, PhysicalPosition, currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
      const { width, height } = card.getBoundingClientRect();
      const content = { width, height: height + (statusLine?.offsetHeight ?? 0) };
      const monitor = (await currentMonitor()) ?? (await primaryMonitor());
      if (!monitor) {
        await window.setSize(new LogicalSize(Math.ceil(content.width), Math.ceil(Math.min(content.height, screen.availHeight - 48))));
        if (!centred) await window.center();
        centred = true;
        return;
      }
      const area = { ...monitor.workArea.position, ...monitor.workArea.size };
      const current = centred ? await window.outerPosition() : undefined;
      const fitted = fitWindowToWorkArea(content, area, monitor.scaleFactor, scrollbar, current);
      await window.setSize(new LogicalSize(fitted.size.width, fitted.size.height));
      await window.setPosition(new PhysicalPosition(fitted.position.x, fitted.position.y));
      centred = true;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => void fit().catch(console.error));
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(card);
    if (statusLine) observer.observe(statusLine);
    const drag = (e: MouseEvent) => {
      if (e.button === 0 && e.target instanceof Element && e.target.closest(".start-brand") && !e.target.closest("button")) void window.startDragging();
    };
    document.addEventListener("mousedown", drag);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", drag);
    };
  }, []);
}

function ProjectsWindow({ window }: { window: Window }) {
  useCardWindow(window);
  const s = status.value;
  return (
    <>
      <StartScreen chrome={<WindowControls window={window} />} />
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
  // The editor window is created once this one shows (ADR 0082), or at once if a project is picked first.
  const handOff: EditorLink = { ready: link.ready, dispose: () => link.dispose(), open: (request) => startEditorWindow().then(() => link.open(request)) };
  setStartActions(launcherActions(handOff, () => void window.hide()));
  render(<ProjectsWindow window={window} />, document.getElementById("app")!);
  startEditorWindowWhenIdle();
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
