// The Samples screen's state (ADR 0349 "Navigation between screens"): which sample is open and what in it is selected
// are the route's (`#/samples?asset=…&select=marker:m2`), so a reload, the editor's hand-off or Back returns there.
// Per-user view choices (time display, snap, play options) are preferences; the view span, playhead and razor are
// per page.
import { computed, signal, untracked } from "@preact/signals";
import type { EffectType } from "../../../engine/audio/effects/types";
import type { IncomingFile } from "../../../editor/assetImportFiles";
import { persisted } from "../../../editor/preferences";
import { currentProject, docVersion } from "../../../editor/state";
import type { TimeFormat, TimeSpan } from "../../components/timeRulerModel";
import { openRoute, studioRouter } from "../../shell/studioServices";
import { isSamplePath } from "./sampleLibrary";
import { sampleSession, type SampleSession } from "./sampleSession";
import { parseSelection, selectionKey, type SampleSelection, type SnapSetting } from "./sampleView";

/** The open sample's path, or null. */
export const openSamplePath = computed<string | null>(() => {
  const route = studioRouter().route.value;
  if (route.screen !== "samples" || !route.asset || !isSamplePath(route.asset)) return null;
  const project = currentProject.value;
  docVersion.value; // files come and go
  return project && project.files.includes(route.asset) ? route.asset : null;
});

/** The open sample's session (documents and edits). */
export const openSession = computed<SampleSession | null>(() => {
  const project = currentProject.value;
  const path = openSamplePath.value;
  // Opening the documents (their effects and history) is not part of this computed's dependencies.
  return project && path ? untracked(() => sampleSession(project, path)) : null;
});

/** What is selected in the open sample. */
export const selection = computed<SampleSelection>(() => parseSelection(studioRouter().route.value.select));

export function openSample(path: string | null, select?: SampleSelection): void {
  openRoute({ screen: "samples", asset: path ?? "", select: select && select.kind !== "sample" ? selectionKey(select) : undefined });
}

export function select(s: SampleSelection): void {
  const path = openSamplePath.peek();
  if (path) openRoute({ screen: "samples", asset: path, select: s.kind === "sample" ? "" : selectionKey(s) });
}

/** Per user. */
export const timeFormat = persisted<TimeFormat>("myco.studio.samples.timeFormat", "timecode");
export const snapSetting = persisted<SnapSetting>("myco.studio.samples.snap", { on: true, unit: "ms", step: 10 });
export const followPlayhead = persisted<boolean>("myco.studio.samples.follow", true);
export const preRoll = persisted<boolean>("myco.studio.samples.preRoll", false);
export const returnToStart = persisted<boolean>("myco.studio.samples.returnToStart", false);
/** Spec §4.1.10's play modes ("loop" is Cycle loop; "through" is a Whole stored by an older Studio). */
export type PlayMode = "selection" | "whole" | "loop" | "through" | "pickupLoop" | "heldLoop" | "loopExit" | "toNextMarker" | "toNextExit" | "toEnd";
export const playMode = persisted<PlayMode>("myco.studio.samples.playMode", "selection");
/** The Loop seam panel's Repeat: Play across the seam keeps cycling through it until stopped. */
export const seamRepeat = persisted<boolean>("myco.studio.samples.seamRepeat", true);

/** The audio lane's views (spec §4.1.6): Waveform, Spectrogram, or both (a split view); one always stays on. */
export const waveViews = persisted<{ readonly wave: boolean; readonly spectrogram: boolean }>("myco.studio.samples.views", { wave: true, spectrogram: false });
/** Colours saved from the custom colour picker (§3.12), offered in every marker's colour row. */
export const savedColours = persisted<string[]>("myco.studio.samples.savedColours", ["#6aa8ff", "#e8907a"]);

/**
 * Per page: A/B (spec §4.1.5, §2.11): hear and show the source with every edit bypassed; the effect whose step the
 * waveform shows (a row or chip hovered or chosen in Sample effects; null: after the whole chain).
 */
export const abSource = signal(false);
export const fxFocus = signal<string | null>(null);
/** An effect type hovered in Add effect: the waveform previews it, added at its defaults (spec §4.1.7). */
export const fxPreview = signal<EffectType | null>(null);

/** Per page: the timeline's view (timeline seconds; null: fit), the playhead (source seconds), the razor, the hovered time (timeline seconds). */
export const viewSpan = signal<TimeSpan | null>(null);
export const playheadTime = signal(0);
export const razorOn = signal(false);
export const hoverTime = signal<number | null>(null);
/** The Import dialog, Write dialog, merge review, fork dialog. */
export const dialog = signal<null | { kind: "import"; dropped?: readonly IncomingFile[]; into?: string } | { kind: "reimport" } | { kind: "write" } | { kind: "merge" } | { kind: "fork"; mode: "fork" | "duplicate" } | { kind: "snippet"; index: number }>(null);
