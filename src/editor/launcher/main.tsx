// The desktop editor's Projects window (ADR 0059): the start screen on its own, shown at start-up
// while the editor window loads hidden. Picking a project hands it to the editor window, and this
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
import { AboutDialog } from "../ui/AboutDialog";
import { NewProjectDialog } from "../ui/NewProjectDialog";
import { StartScreen } from "../ui/StartScreen";
import "../ui/editor.css";
import { launcherActions } from "./actions";
import { linkToEditor, tauriBus } from "./handoff";
import "./launcher.css";
import { measureScrollbar, windowSizeFor } from "./windowSize";

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
 * Keeps the window the size of the start panel and the status line under it, and drags it by the
 * banner. The window is centred again after its first fit, since it shrinks from its configured size.
 */
function useCardWindow(window: Window): void {
  useEffect(() => {
    const card = document.querySelector<HTMLElement>(".start-card");
    const statusLine = document.querySelector<HTMLElement>(".projects-status");
    if (!card) return;
    const scrollbar = measureScrollbar(document);
    let frame = 0;
    let centred = false;
    const fit = () => {
      frame = 0;
      const { width, height } = card.getBoundingClientRect();
      const size = windowSizeFor({ width, height: height + (statusLine?.offsetHeight ?? 0) }, screen.availHeight, scrollbar);
      void import("@tauri-apps/api/window")
        .then(({ LogicalSize }) => window.setSize(new LogicalSize(size.width, size.height)))
        .then(() => {
          if (centred) return;
          centred = true;
          return window.center();
        });
    };
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(fit);
    });
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
  setStartActions(launcherActions(link, () => void window.hide()));
  render(<ProjectsWindow window={window} />, document.getElementById("app")!);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
