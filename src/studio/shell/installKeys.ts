// The Studio's global keys (ADR 0335 "Keyboard"), registered in the keymap and dispatched from the window: Ctrl/⌘+1…6
// switch screens (also while typing), F6 and Shift+F6 move focus between the screen's panels, ? opens the shortcut
// list (a single-key shortcut), and Undo, Redo and stepping through history act on the active history (ADR 0145) with
// the editor's keys (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y, Ctrl/⌘+Alt(+Shift)+Z): those are classified by the editor's
// own key classifier (`shortcutFor`, shortcutKeys.ts), so both apps answer the same keys; the keymap lists them for the
// shortcuts dialog. Text fields keep their own undo.
import { activeHistory, redo, stepBack, stepForward, undo } from "../../editor/activeHistory";
import { isEditable } from "../../editor/editable";
import { shortcutFor, type Shortcut } from "../../editor/shortcutKeys";
import { isMacPlatform } from "../../editor/ui/keyCombo";
import { panelScopesOf } from "./keymap";
import { SCREENS } from "./screens";
import { keymap, openRoute, shortcutsOpen, singleKeyShortcuts, studioRouter } from "./studioServices";

/** Focus the next (or previous) dock group's panel on the screen showing. */
function cyclePanels(doc: Document, step: 1 | -1): boolean {
  const groups = [...doc.querySelectorAll<HTMLElement>(".studio-dock .dock-group")];
  if (groups.length === 0) return false;
  const at = groups.findIndex((g) => g.contains(doc.activeElement));
  const next = groups[(at + step + groups.length) % groups.length];
  const target = next.querySelector<HTMLElement>('.panel button:not(:disabled), .panel input, .panel select, .panel textarea, .panel [tabindex]:not([tabindex="-1"])') ?? next.querySelector<HTMLElement>(".panel");
  if (!target) return false;
  if (!target.hasAttribute("tabindex") && !target.matches("button, input, select, textarea")) target.tabIndex = -1;
  target.focus();
  return true;
}

const withHistory = (run: () => unknown) => () => {
  if (!activeHistory.peek()) return false;
  run();
  return true;
};

/** What the history shortcuts do (the keys are the shared classifier's). */
const HISTORY_ACTIONS: Partial<Record<Shortcut, () => void>> = { undo, redo, back: stepBack, forward: stepForward };

/** Register the global keys and listen on `win`; returns the stop. */
export function installStudioKeys(win: Window = window): () => void {
  const stops = [
    ...SCREENS.map((s) => keymap.register({ id: `screen.${s.id}`, keys: [`Mod+${s.digit}`], label: `Go to ${s.title}`, group: "Screens", scope: "global", inText: true, run: () => openRoute({ screen: s.id }) })),
    keymap.register({ id: "panel.next", keys: ["F6"], label: "Next panel", scope: "global", inText: true, run: () => cyclePanels(win.document, 1) }),
    keymap.register({ id: "panel.previous", keys: ["Shift+F6"], label: "Previous panel", scope: "global", inText: true, run: () => cyclePanels(win.document, -1) }),
    keymap.register({ id: "shortcuts", keys: ["?"], label: "Keyboard shortcuts", scope: "global", run: () => void (shortcutsOpen.value = true) }),
    keymap.register({ id: "undo", keys: ["Mod+Z"], label: "Undo", group: "Edit", scope: "global", run: withHistory(undo) }),
    keymap.register({ id: "redo", keys: ["Mod+Shift+Z", "Ctrl+Y"], label: "Redo", group: "Edit", scope: "global", run: withHistory(redo) }),
    keymap.register({ id: "history.back", keys: ["Mod+Alt+Z"], label: "Step back through history (in the order made)", group: "Edit", scope: "global", run: withHistory(stepBack) }),
    keymap.register({ id: "history.forward", keys: ["Mod+Alt+Shift+Z"], label: "Step forward through history", group: "Edit", scope: "global", run: withHistory(stepForward) }),
  ];
  const mac = isMacPlatform();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    // A modal dialog keeps its keys (the shortcuts dialog, calibration, Move to…).
    if (win.document.querySelector('[aria-modal="true"]')) return;
    const target = e.target as Element | null;
    const typing = isEditable(target);
    const action = shortcutFor(e);
    const history = action ? HISTORY_ACTIONS[action] : undefined;
    if (history) {
      // Undo, Redo and history steps: the active history's, unless a text field keeps its own.
      if (typing || !activeHistory.peek()) return;
      history();
      e.preventDefault();
      return;
    }
    const handled = keymap.handle(e, { screen: studioRouter().route.peek().screen, panels: panelScopesOf(target), singleKeys: singleKeyShortcuts.peek(), typing, mac });
    if (handled) e.preventDefault();
  };
  win.addEventListener("keydown", onKeyDown);
  return () => {
    win.removeEventListener("keydown", onKeyDown);
    for (const s of stops) s();
  };
}
