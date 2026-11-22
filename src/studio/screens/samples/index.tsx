// The Samples screen (ADR 0328, milestone M3): its panels (Samples, Outline, the fixed Sample timeline, Edits, Loop
// seam, Inspector, History) and its keys. Default layout as the prototype's: left Samples over Outline, right
// Inspector, bottom Edits | Loop seam, the timeline in the middle.
import type { ComponentChildren } from "preact";
import { historyPanel } from "../placeholder";
import type { StudioPanel } from "../../shell/studioPanels";
import { keymap } from "../../shell/studioServices";
import { EditsPanel } from "./EditsPanel";
import { InspectorPanel } from "./InspectorPanel";
import { OutlinePanel } from "./OutlinePanel";
import * as act from "./sampleActions";
import { SampleDialogs } from "./SampleDialogs";
import { installDiskWatch } from "./sampleDisk";
import { installSampleTransport } from "./SamplePlayerBar";
import { SamplesPanel } from "./SamplesPanel";
import { registerSampleKinds } from "./sampleSession";
import { dialog, openSession, razorOn } from "./samplesState";
import { SeamPanel } from "./SeamPanel";
import { TimelinePanel } from "./TimelinePanel";
import "./samples.css";

let started = false;
/** Register the screen's document kinds, keys, player bar and disk watch (once, the first time a panel draws). */
function start(): void {
  if (started) return;
  started = true;
  registerSampleKinds();
  installSampleTransport();
  installDiskWatch();
  const scope = { screen: "samples" } as const;
  const group = "Sample";
  const keys: [string, string[], string, () => boolean][] = [
    ["play", ["Space"], "Play the selection, stop, or release a held loop", () => act.togglePlay()],
    ["marker", ["M"], "Add a marker at the playhead", act.addMarkerAtPlayhead],
    ["loop", ["L"], "Add a loop at the playhead", () => act.addLoopHere(undefined)],
    ["trimStart", ["I"], "Trim start at the playhead", () => act.trimAtPlayhead("start")],
    ["trimEnd", ["O"], "Trim end at the playhead", () => act.trimAtPlayhead("end")],
    ["snip", ["S"], "Snip at the playhead", () => act.snipAtPlayhead()],
    ["razor", ["C"], "Razor on or off", act.toggleRazor],
    ["delete", ["Delete", "Backspace"], "Delete the selected marker, loop or snippet", act.deleteSelected],
    ["zoomIn", ["=", "+"], "Zoom in", () => act.zoom(1.5)],
    ["zoomOut", ["-"], "Zoom out", () => act.zoom(1 / 1.5)],
    ["fit", ["0"], "Zoom to fit", act.zoomFit],
    ["zoomSel", ["Z"], "Zoom to the selection", act.zoomToSelection],
    ["left", ["ArrowLeft"], "Playhead back one snap step", () => act.nudgePlayhead(-1, false, false)],
    ["right", ["ArrowRight"], "Playhead on one snap step", () => act.nudgePlayhead(1, false, false)],
    ["left10", ["Shift+ArrowLeft"], "Playhead back ten steps", () => act.nudgePlayhead(-1, true, false)],
    ["right10", ["Shift+ArrowRight"], "Playhead on ten steps", () => act.nudgePlayhead(1, true, false)],
    ["leftFine", ["Alt+ArrowLeft"], "Playhead back 1 ms", () => act.nudgePlayhead(-1, false, true)],
    ["rightFine", ["Alt+ArrowRight"], "Playhead on 1 ms", () => act.nudgePlayhead(1, false, true)],
    ["prevMark", ["Mod+ArrowLeft"], "Playhead to the previous landmark", () => act.jumpLandmark(-1)],
    ["nextMark", ["Mod+ArrowRight"], "Playhead to the next landmark", () => act.jumpLandmark(1)],
    ["home", ["Home"], "Playhead to the trim start", () => act.playheadToTrim("start", false)],
    ["end", ["End"], "Playhead to the trim end", () => act.playheadToTrim("end", false)],
    ["homeAll", ["Mod+Home"], "Playhead to the sample start", () => act.playheadToTrim("start", true)],
    ["endAll", ["Mod+End"], "Playhead to the sample end", () => act.playheadToTrim("end", true)],
    ["razorOff", ["Escape"], "Razor off", () => (razorOn.peek() ? ((razorOn.value = false), true) : false)],
    ["fork", ["Mod+Shift+S"], "Fork as new sample", () => (act.current() ? ((dialog.value = { kind: "fork", mode: "fork" }), true) : false)],
  ];
  for (const [id, combos, label, run] of keys) keymap.register({ id: `samples.${id}`, keys: combos, label, group, scope, run });
}

/** A panel view that starts the screen the first time any of its panels draws. */
const view = (body: () => ComponentChildren) => () => {
  start();
  return body();
};

/**
 * The open sample's document scope: focus or a press inside makes its asset document the active history (Undo, Redo,
 * the History panel, ADR 0145). `display: contents`, so the panel's layout is untouched.
 */
function DocScope(props: { children: ComponentChildren }) {
  const path = openSession.value?.documentPath;
  return (
    <div class="smp-doc" data-asset-document={path}>
      {props.children}
    </div>
  );
}
const docView = (body: () => ComponentChildren) => view(() => <DocScope>{body()}</DocScope>);

export const SAMPLES_PANELS: readonly StudioPanel[] = [
  { id: "samples-library", title: "Samples", dock: "left", view: view(() => <SamplesPanel />) },
  { id: "samples-outline", title: "Outline", dock: "left", view: docView(() => <OutlinePanel />) },
  {
    id: "samples-editor",
    title: "Sample",
    dock: "fill",
    fixed: true,
    view: docView(() => (
      <>
        <TimelinePanel />
        <SampleDialogs />
      </>
    )),
  },
  { id: "samples-inspector", title: "Inspector", dock: "right", view: docView(() => <InspectorPanel />) },
  { id: "samples-edits", title: "Sample effects", dock: "bottom", view: docView(() => <EditsPanel />) },
  { id: "samples-seam", title: "Loop seam", dock: "bottom", view: docView(() => <SeamPanel />) },
  historyPanel("samples"),
];
