// Changed on disk (ADR 0328): when the project reports that an audio file changed (`Assets.onChanged`, fed by the
// project watch's `rereadFiles`) and its cues, regions or loops differ from what the sidecar last saw, the Sample panel
// shows a banner and the merge review (`sampleFile.ts` `mergeRows`). The same review opens after a re-import.
//
// TODO(ADR 0327): the Studio doesn't run the project watch yet (the editor does, `editorProjectWatch.ts`), so outside
// changes reach the Studio only once something calls `rereadFiles`; wiring the watch for the Studio is a shell task.
import { effect, signal } from "@preact/signals";
import { Assets } from "../../../engine";
import { readWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { currentProject } from "../../../editor/state";
import type { EditorProject } from "../../../editor/projects";
import { mergeRows, type MergeRow } from "./sampleFile";
import { bytesOf, forgetAudio, sampleSession } from "./sampleSession";
import { isWavPath } from "./importPlan";

export interface DiskChange {
  /** The audio file. */
  readonly path: string;
  readonly summary: string;
  readonly rows: readonly MergeRow[];
}

export const diskChange = signal<DiskChange | null>(null);

/** "2 cue changes and the loop end moved." */
export function summarize(rows: readonly MergeRow[]): string {
  const markers = rows.filter((r) => r.kind === "marker").length;
  const loops = rows.filter((r) => r.kind === "loop");
  const parts: string[] = [];
  if (markers) parts.push(`${markers} cue change${markers === 1 ? "" : "s"}`);
  if (loops.length === 1) parts.push(loops[0].title.charAt(0).toLowerCase() + loops[0].title.slice(1).replace(/^loop/, "the loop"));
  else if (loops.length > 1) parts.push(`${loops.length} loop changes`);
  return parts.length ? `${parts.join(" and ")}.` : "";
}

/** Read `path` as it is now and open the review if its chunks changed against the sample's file snapshots. */
export async function reviewDisk(project: EditorProject, path: string): Promise<boolean> {
  if (!isWavPath(path) || !project.files.includes(path)) return false;
  forgetAudio(project, path);
  const meta = readWavMetadata(await bytesOf(project, path));
  const rows = mergeRows(sampleSession(project, path).edits.peek(), meta);
  if (rows.length === 0) return false;
  diskChange.value = { path, summary: summarize(rows), rows };
  return true;
}

let installed = false;
/** Follow outside changes to the project's audio files (installed with the screen, once). */
export function installDiskWatch(): void {
  if (installed) return;
  installed = true;
  let off: (() => void) | null = null;
  effect(() => {
    const project = currentProject.value;
    off?.();
    off = null;
    diskChange.value = null;
    if (!project) return;
    off = Assets.onChanged((path) => {
      if (isWavPath(path)) void reviewDisk(project, path).catch(() => undefined);
    });
  });
}
