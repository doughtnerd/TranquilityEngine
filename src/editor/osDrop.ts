// Dropping files from the OS onto the Assets panel (ADR 0085, 0324): one drop controller
// (`osDropController.ts`) fed by the window's HTML5 drag events and, in the desktop editor, where
// Tauri swallows those, by its webview's drag-drop event.
import { isTauri } from "../engine/platform/FileSystem";
import { createOsDropController, listenBrowserDrops, listenDesktopDrops, osDrag } from "./osDropController";

/** Listen for drops onto the Assets panel. Returns a function that stops listening. */
export function installOsDrop(): () => void {
  const drop = createOsDropController();
  const stops = [listenBrowserDrops(window, drop)];
  if (isTauri()) {
    let cancelled = false;
    let stopDesktop: (() => void) | null = null;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (!cancelled) stopDesktop = listenDesktopDrops(getCurrentWebview(), { elementFromPoint: (x, y) => document.elementFromPoint(x, y), get devicePixelRatio() { return window.devicePixelRatio; } }, drop);
    });
    stops.push(() => {
      cancelled = true;
      stopDesktop?.();
    });
  }
  return () => {
    osDrag.value = null;
    for (const stop of stops) stop();
  };
}
