// The desktop editor window's side of the Projects window (ADR 0059): it starts hidden, opens the
// project the Projects window hands it and shows itself, and when its project closes it hides and
// shows the Projects window again.
import { effect } from "@preact/signals";
import { openPickedProject, sceneViewStarted } from "../session";
import { currentProject, status } from "../state";
import { serveProjectsWindow, showProjectsWindow, tauriBus } from "./handoff";

export async function serveDesktopProjectsWindow(): Promise<void> {
  const [bus, { getCurrentWindow, Window }] = await Promise.all([tauriBus(), import("@tauri-apps/api/window")]);
  const window = getCurrentWindow();
  // The Projects window creates this one once it shows (ADR 0082); if it was closed while this was
  // being created, nothing would ever show this window, so the app ends here instead.
  if (!(await Window.getByLabel("projects"))) {
    await window.destroy();
    return;
  }
  serveProjectsWindow(bus, async (request) => {
    await openPickedProject(request);
    if (!currentProject.peek()) throw new Error(status.peek()?.text ?? "The project didn't open.");
    await sceneViewStarted(); // show the scene view drawn (ADR 0082)
    await window.show();
    await window.setFocus();
  });
  let open = currentProject.peek() !== null;
  effect(() => {
    const now = currentProject.value !== null;
    if (open && !now) void window.hide().then(() => showProjectsWindow(bus));
    open = now;
  });
}
