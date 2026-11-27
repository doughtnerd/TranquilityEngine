// What the Input dialog should do when it next shows a file (ADR 0417), apart from its module so New Action Set can ask
// without loading the dialog's code.
import { signal } from "@preact/signals";

/** A set or context file just made: the dialog shows it at the end of its list with its name selected for typing. */
export const inputDialogRename = signal<string | null>(null);
