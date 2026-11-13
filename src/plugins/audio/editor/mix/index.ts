// The mix panels of the Audio plugin's editor half (ADR 0171 amended by 0172; api-and-models §7). `editor/index.ts` calls
// `registerMixPanels` once, beside `registerMusicPanels`; every mix panel registers here and nowhere else (no menu entry,
// toolbar button or global shortcut). The Profiler is registered now (Pf4); the Mixer panel (Mp2b) registers here later.
//
// W8 slot fills for the Profiler panel (contract H5; see the top of `ProfilerPanel.tsx`) go in the marked block below,
// one import and one line each, so no task edits `ProfilerPanel.tsx`.
import type { EditorPluginContext } from "../../../../editor/sdk";

export const PROFILER_PANEL = "audioprofiler";

export function registerMixPanels(context: EditorPluginContext): void {
  context.registerPanel({
    id: PROFILER_PANEL,
    title: "Audio Profiler",
    view: () => import("./ProfilerPanel").then((m) => m.ProfilerPanel),
  });
  // --- Profiler slot fills (W8): Pf5's tables, Pf8's bar and banners, X2's drop route; Pf3b-d's track factories; Rc4's host ---
}
