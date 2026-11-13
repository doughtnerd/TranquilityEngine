// The detached panel windows (ADR 0174): a dock layout rendered into each open window through a
// portal, so its panels share the main window's state; and, in the main window, a banner for windows
// a layout holds that aren't open (a browser blocks pop-ups not started by a click).
import { useEffect } from "preact/hooks";
import { DockLayout } from "../layout/DockLayout";
import { dockWindowInMain, openLayoutWindow, openWindows, pendingWindows, startDetachedWindows, windowTitle } from "../layout/detached";
import { addPanelRequest, layout } from "../layout/store";
import { ChildWindowPortal } from "../windows/ChildWindowPortal";
import { AddPanelDialog } from "./AddPanelDialog";
import { PANEL_VIEWS } from "./panels";

export function DetachedWindows() {
  useEffect(() => startDetachedWindows(), []);
  return (
    <>
      {[...openWindows.value].map(([id, handle]) => (
        <ChildWindowPortal key={id} handle={handle}>
          <DockLayout panels={PANEL_VIEWS} windowId={id} />
          {addPanelRequest.value?.window === id && <AddPanelDialog inWindow={id} />}
        </ChildWindowPortal>
      ))}
    </>
  );
}

/** "2 detached windows aren't open": Open (the next one, from this click) or Dock Here (their panels into the main window). */
export function PendingWindowsBanner() {
  const pending = pendingWindows.value;
  if (pending.length === 0) return null;
  const l = layout.value;
  const first = pending[0]!;
  return (
    <div class="pending-windows" role="status">
      <span>
        {pending.length === 1 ? `A detached window (${windowTitle(l, first).replace(/ · Myco Engine$/, "")}) isn't open.` : `${pending.length} detached windows aren't open.`}
      </span>
      <button onClick={() => openLayoutWindow(first.id)} title="Open it (allow pop-ups for the editor if the browser blocks it)">
        {pending.length === 1 ? "Open" : "Open next"}
      </button>
      <button onClick={() => pending.forEach((w) => dockWindowInMain(w.id))} title="Put their panels in this window instead">
        Dock here
      </button>
    </div>
  );
}
