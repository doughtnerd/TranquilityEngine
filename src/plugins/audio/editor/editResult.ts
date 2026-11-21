// One refused-or-next result for the audio editor's edits (ADR 0307): every pure edit a user can get refused (segment,
// rule, tree, ducking, bus and snapshot rename, parameter list) returns `EditResult`, and `applyEdit` is the one place a
// result is applied: a refusal goes to the status bar and the message log, an accepted change is committed once with
// its undo label. `applyToDocument` and `applyToSettings` are the asset document's and the settings draft's adapters.
import { editor, type AssetDocument, type SettingsDraft } from "../../../editor/sdk";

/** The next value, or why the edit was refused (nothing changes). */
export type EditResult<T> = { readonly next: T } | { readonly refused: string };

export const accept = <T>(next: T): EditResult<T> => ({ next });
export const refuse = (reason: string): { readonly refused: string } => ({ refused: reason });

/**
 * Lift an edit of `part` (a segment, a container) into the `whole` it sits in: refused stays refused, `part` itself
 * (nothing changed) is `whole` itself, and a new part is `place(next)`.
 */
export function placeEdit<P, W>(result: EditResult<P>, part: P, whole: W, place: (next: P) => W): EditResult<W> {
  if ("refused" in result) return result;
  return accept(result.next === part ? whole : place(result.next));
}

/** "Rename bus Music to SFX" as "rename bus Music to SFX", for "Can't …". */
const lowerFirst = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/**
 * Apply `result`: a refusal is reported as an error in the status bar and the log ("Can't <label>: <reason>"); an
 * accepted value goes to `commit` with the label (one undo step), unless it is `unchanged` itself (the value before the
 * edit, when the caller has one). Returns whether it was accepted.
 */
export function applyEdit<T>(result: EditResult<T>, label: string, commit: (next: T, label: string) => void, ...unchanged: [T?]): boolean {
  if ("refused" in result) {
    editor.messages.error(`Can't ${lowerFirst(label)}: ${result.refused}`);
    return false;
  }
  if (unchanged.length === 0 || result.next !== unchanged[0]) commit(result.next, label);
  return true;
}

/** Apply an edit of an asset document's value as one labelled undo step of the document. */
export const applyToDocument = <T>(doc: AssetDocument<T>, result: EditResult<T>, label: string): boolean =>
  applyEdit(result, label, (next) => doc.edit(next, { label }), doc.value.value);

/** Apply an edit of the Project panel's settings draft through the section's `set` (one undo step of the panel). */
export const applyToSettings = (draft: SettingsDraft, set: (label: string, next: SettingsDraft) => void, result: EditResult<SettingsDraft>, label: string): boolean =>
  applyEdit(result, label, (next) => set(label, next), draft);
