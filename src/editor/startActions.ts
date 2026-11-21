// What the start screen's buttons do (ADR 0059, 0318). Both windows resolve what the user asked for through the
// project-opening module (projectOpening.ts); in the editor window the project then opens there (session.ts), in the
// desktop editor's Projects window it is handed to the editor window (launcher/actions.ts). Each shows the outcome
// in its status line before returning it. The start screen calls these rather than session.ts, so the Projects
// window opens without loading the editor or the engine.
import type { LocationOutcome, OpenIntent, OpenOutcome } from "./projectOpening";

export interface StartActions {
  /** Open what the user asked for; resolves to what came of it, already shown in the status line. */
  open(intent: OpenIntent): Promise<OpenOutcome>;
  /** The folder a new project goes in (it gets its own folder inside), or why there is none. */
  pickProjectLocation(): Promise<LocationOutcome>;
}

let actions: StartActions | null = null;

/** Set by each page's entry point before it renders. */
export function setStartActions(value: StartActions): void {
  actions = value;
}

export function startActions(): StartActions {
  if (!actions) throw new Error("The start screen's actions weren't set.");
  return actions;
}
