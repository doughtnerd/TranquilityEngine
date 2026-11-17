// The typed text of an edit box: kept as a draft while typing, committed on Enter or when the box loses focus,
// dropped on Escape.
import { useLayoutEffect, useRef, useState } from "preact/hooks";

/** Props to spread onto the `<input>`. */
export interface DraftInputProps {
  value: string;
  onInput: (e: Event) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface DraftText {
  draft: string;
  setDraft: (text: string) => void;
  input: DraftInputProps;
}

/**
 * The draft text of a box showing `shown`. Leaving the box (or Enter, which leaves it) calls `commit` with the draft;
 * Escape leaves it without committing and shows `shown` again. A new `shown` replaces the draft, in the same commit
 * (a mount effect run after paint would overwrite typing that came first).
 */
export function useDraftText(shown: string, commit: (draft: string) => void): DraftText {
  const [draft, setDraft] = useState(shown);
  useLayoutEffect(() => setDraft(shown), [shown]);
  // Escape blurs the box, and the blur handler still sees this render's draft (the state update hasn't rendered yet),
  // so it's told to drop the edit rather than commit it.
  const dropping = useRef(false);
  return {
    draft,
    setDraft,
    input: {
      value: draft,
      onInput: (e) => setDraft((e.currentTarget as HTMLInputElement).value),
      onBlur: () => {
        if (!dropping.current) commit(draft);
      },
      onKeyDown: (e) => {
        const box = e.currentTarget as HTMLInputElement;
        if (e.key === "Enter") box.blur();
        if (e.key === "Escape") {
          dropping.current = true;
          box.blur();
          dropping.current = false;
          setDraft(shown);
        }
      },
    },
  };
}
