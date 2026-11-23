// Editor registration seam: timeline (T53). Registers the Timeline window: tracks, bindings, blends, camera cuts, nested timelines.
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
//
// - The window is a single dockable panel, opened from the Add Panel dialog, by double-clicking an authored timeline (the
//   `timeline` asset kind names it as its panel) or with the TimelineDirector card's "Timeline window" button.
// - It edits the timeline of the selected TimelineDirector or the file opened in it; the preview plays it on the director
//   in the Editor World through the runtime (`timelinePreviewLogic.ts`).
import { h } from "preact";
import type { ComponentHeaderActionProps, EditorPluginContext } from "../../../../editor/sdk";
import { editor } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { TIMELINE_WINDOW_PANEL } from "./panelId";

/** The TimelineDirector card's header button that opens the window. */
function OpenWindowButton(props: ComponentHeaderActionProps) {
  if (props.paths.length !== 1) return null;
  return h(
    "button",
    { type: "button", class: "edit-handles aw-open", title: "Open the Timeline window on this director's timeline", "aria-label": "Open the Timeline window", onClick: () => editor.showPanel(TIMELINE_WINDOW_PANEL) },
    "▤",
  );
}

/** @internal */
export function registerTimeline(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerPanel({
    id: TIMELINE_WINDOW_PANEL,
    title: "Timeline",
    view: () => import("./TimelineWindow").then((m) => m.TimelineWindow),
    dock: "bottom",
    single: true,
    onDemand: true,
  });
  context.registerComponentHeaderAction({ id: "myco.animation.openTimelineWindow", types: ["engine.TimelineDirector"], view: OpenWindowButton });
}
