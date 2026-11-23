// The Projects window's start screen (ADR 0059, 0318): the project-opening module resolves what the user asked for
// here (a folder picked or confirmed, a sample copied, a project created), then the project is handed to the editor
// window to open. Nothing here loads the engine.
import type { FileSystem } from "../../engine/platform/FileSystem";
import { projectOpening, type OpenOutcome } from "../projectOpening";
import type { RecentProjects } from "../recentProjectList";
import type { StartActions } from "../startActions";
import { status } from "../state";
import { StudioRefusal } from "../studioHandoff";
import { EditorRefusal, type EditorLink } from "./handoff";

export interface LauncherSeams {
  /** The window that opens the project: the editor's, or the Audio Studio's for Biosonic (ADR 0380); it says why when it couldn't. */
  readonly link: Pick<EditorLink, "open">;
  /** Runs once the editor window shows the project (the Projects window hides). */
  opened(): void;
  folders(): Promise<FileSystem | null>;
  readonly recent: Pick<RecentProjects, "check" | "handle">;
}

export function launcherActions({ link, opened, folders, recent }: LauncherSeams): StartActions {
  const opening = projectOpening({
    folders,
    recent,
    progress: (text) => (status.value = { kind: "info", text }),
    async open(source) {
      try {
        await link.open(source.kind === "folder" ? { kind: "folder", root: source.root } : { kind: "sample", id: source.sample.id });
      } catch (err) {
        // The editor or Studio window words its own refusal; anything else (the window didn't start) is worded here.
        if (err instanceof EditorRefusal || err instanceof StudioRefusal) return { kind: "refused", reason: { kind: "error", text: err.message } };
        throw err;
      }
      return { kind: "opened" };
    },
  });
  /** The editor window has the project: this window's line clears as it hides. */
  const show = (outcome: OpenOutcome): OpenOutcome => {
    if (outcome.kind === "opened") {
      status.value = null;
      opened();
    } else if (outcome.kind === "refused") {
      status.value = outcome.reason;
    }
    return outcome;
  };
  return {
    open: async (intent) => show(await opening.open(intent)),
    async pickProjectLocation() {
      const outcome = await opening.pickLocation();
      if (outcome.kind === "refused") status.value = outcome.reason;
      return outcome;
    },
  };
}
