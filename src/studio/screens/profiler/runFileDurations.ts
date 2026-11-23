// The duration the Takes and Captures trees show beside each file (the prototype's "32.0 s" meta): read once per file
// version from the file itself (the capture reader's time index: last record minus first), one file at a time in the
// background, and remembered by the file's asset URL (a rewritten file gets a new one). `durations.version` changes when
// one arrives, so a panel that reads it redraws.
import { signal } from "@preact/signals";
import { CaptureTimeIndex, openCapture } from "../../../plugins/audio/runtime/capture/reader";
import type { EditorProject } from "../../../editor/projects";

const known = new Map<string, number | null>();
const waiting: { key: string; url: string }[] = [];
let reading = false;

/** Bumped when a duration arrives. */
export const durationsVersion = signal(0);

async function readNext(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    for (let job = waiting.shift(); job; job = waiting.shift()) {
      let seconds: number | null = null;
      try {
        const res = await fetch(job.url);
        const c = await openCapture(new Uint8Array(await res.arrayBuffer()));
        const idx = new CaptureTimeIndex();
        idx.extend(c);
        seconds = Number.isFinite(idx.endSeconds - idx.startSeconds) ? Math.max(0, idx.endSeconds - idx.startSeconds) : null;
      } catch {
        seconds = null; // unreadable: no duration shown (opening it says why)
      }
      known.set(job.key, seconds);
      durationsVersion.value++;
    }
  } finally {
    reading = false;
  }
}

/** File `path`'s duration in seconds, or null until it has been read (or when it can't be). */
export function fileDuration(project: EditorProject | null, path: string): number | null {
  const url = project?.assets.get(path);
  if (typeof url !== "string") return null;
  const key = `${path}\n${url}`;
  if (known.has(key)) return known.get(key)!;
  known.set(key, null);
  waiting.push({ key, url });
  void readNext();
  return null;
}
