// The one message the editor gives when an action needs to write to a project that can't be saved
// (a sample, or a browser without a folder picker). Status lines, tooltips, refusals and thrown errors
// all word it the same way through `readOnlyMessage`; the SDK's `project.refuseReadOnly` uses it too.

/** What `readOnlyMessage` needs to know about a project. */
export interface ReadOnlySubject {
  readonly name: string;
  readonly canSave: boolean;
}

/**
 * "`<name>` is read-only. Open a project folder (or copy the sample) to `<toDo>`." `toDo` is the action
 * as a verb phrase ("create prefabs", "add scenes", "change a.json").
 */
export const readOnlyMessage = (project: Pick<ReadOnlySubject, "name">, toDo: string): string =>
  `${project.name} is read-only. Open a project folder (or copy the sample) to ${toDo}.`;

/** `readOnlyMessage` when the project can't be saved, else null. */
export const whyReadOnly = (project: ReadOnlySubject, toDo: string): string | null => (project.canSave ? null : readOnlyMessage(project, toDo));
