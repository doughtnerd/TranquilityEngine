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
 * (a mount effect run after paint would overwrite typing that came first), except while the box is being typed in:
 * a value that changes underneath (a live World's, refreshed while playing, ADR 0243) doesn't overwrite typing, and
 * the box shows the latest value again once it's left.
 */
export function useDraftText(shown: string, commit: (draft: string) => void): DraftText {
  const [draft, setDraft] = useState(shown);
  const typing = useRef(false);
  const latest = useRef(shown);
  latest.current = shown;
  useLayoutEffect(() => {
    if (!typing.current) setDraft(shown);
  }, [shown]);
  /** Typing ended: show the latest value (a commit's own new value follows in the same render). */
  const stopTyping = () => {
    if (!typing.current) return;
    typing.current = false;
    setDraft(latest.current);
  };
  // Escape blurs the box, and the blur handler still sees this render's draft (the state update hasn't rendered yet),
  // so it's told to drop the edit rather than commit it.
  const dropping = useRef(false);
  return {
    draft,
    setDraft,
    input: {
      value: draft,
      onInput: (e) => {
        typing.current = true;
        setDraft((e.currentTarget as HTMLInputElement).value);
      },
      onBlur: () => {
        if (!dropping.current) commit(draft);
        stopTyping();
      },
      onKeyDown: (e) => {
        const box = e.currentTarget as HTMLInputElement;
        if (e.key === "Enter") box.blur();
        if (e.key === "Escape") {
          dropping.current = true;
          box.blur();
          dropping.current = false;
          typing.current = false;
          setDraft(shown);
        }
      },
    },
  };
}
