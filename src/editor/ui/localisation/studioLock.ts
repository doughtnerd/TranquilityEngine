// Whether the Audio Studio holds the open project (0341), as the editor last read its lock: the strings ownership rule
// (`localisationData.ts` `tableAccess`, ADR 0356 §9) needs it for the tables audio data names. The Localisation panel
// and the Inspector's Localise control read it and refresh it while they're shown.
import { signal } from "@preact/signals";
import { otherAppHolds } from "../../projectLocks";
import type { EditorProject } from "../../projects";
import type { LockState } from "./localisationData";

/** The Studio's lock on the open project, as last read. */
export const studioLock = signal<LockState>("unknown");

/** Read the Studio's lock on `project` again. */
export async function refreshStudioLock(project: EditorProject): Promise<void> {
  if (!project.fileSystem || !project.root) return void (studioLock.value = "none");
  try {
    studioLock.value = (await otherAppHolds(project.fileSystem, project.root, "editor")) ? "held" : "none";
  } catch {
    studioLock.value = "unknown";
  }
}
