// One visible span per recording, shared by the Take and Profiler timelines (ADR 0412): a `.sporesample` open on both
// screens shows the same seconds on each, so zooming or scrolling one, or the playhead paging one, moves the other.
// Only the last recording's span is kept: opening another starts fitted.
import { signal, type Signal } from "@preact/signals";
import type { TimeSpan } from "./timeRulerModel";

let current: { readonly key: string; readonly view: Signal<TimeSpan | null> } | null = null;

/** The shared span of the recording at `key` (its path): null while fitted. */
export function recordingView(key: string): Signal<TimeSpan | null> {
  if (current?.key !== key) current = { key, view: signal<TimeSpan | null>(null) };
  return current.view;
}
