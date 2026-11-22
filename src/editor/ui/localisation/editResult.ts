// One refused-or-next result for the localisation editing models (ADR 0307, 0313; the ground rules' "every edit a user
// can get refused returns { next } | { refused }"): the Localisation panel's string edits, the Languages and Subtitles
// settings edits and the Inspector's Localise and Extract. The view applies `next` (one undo step) or shows `refused`
// in the status bar; a "disabled" check asks the edit itself (`refusalOf`), so each rule lives in one place.

/** The next value, or why the edit was refused (nothing changes). */
export type EditResult<T> = { readonly next: T } | { readonly refused: string };

export const accept = <T>(next: T): EditResult<T> => ({ next });
export const refuse = (reason: string): { readonly refused: string } => ({ refused: reason });

/** Why `result` was refused, or null when it was accepted. */
export const refusalOf = <T>(result: EditResult<T>): string | null => ("refused" in result ? result.refused : null);

/** `result`'s next value passed through `f`; a refusal stays. */
export function mapEdit<T, U>(result: EditResult<T>, f: (next: T) => U): EditResult<U> {
  return "refused" in result ? result : { next: f(result.next) };
}
