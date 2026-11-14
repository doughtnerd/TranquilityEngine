// The e2e specs' hook into detached windows (tests/e2e/childwindow.spec.ts), like the editor's other
// `window` debug hooks: opens a child with a probe inside (a panel-styled box with a text field), so a
// spec can check its stylesheets, theme, shortcuts and closing before the layout uses it (ADR 0174).
import { h, render } from "preact";
import { openChildWindow, type ChildWindowHandle } from "./childWindow";

export interface ChildWindowHook {
  /** Open a child with the probe in it; resolves true once it has loaded, false if it was refused. */
  open(title: string): Promise<boolean>;
  /** The last child opened, once loaded. */
  last: ChildWindowHandle | null;
  /** Why the last open was refused. */
  refused: string | null;
}

export function installChildWindowHook(): void {
  const hook: ChildWindowHook = {
    last: null,
    refused: null,
    async open(title) {
      hook.refused = null;
      const opening = openChildWindow({ title, bounds: { w: 480, h: 360 }, onRefused: (reason) => (hook.refused = reason) });
      if (!opening) return false;
      const handle = await opening;
      render(h("div", { class: "panel child-window-probe" }, h("input", { class: "child-window-probe-input", "aria-label": "Probe" })), handle.container);
      hook.last = handle;
      return true;
    },
  };
  Object.assign(window, { childWindows: hook });
}
