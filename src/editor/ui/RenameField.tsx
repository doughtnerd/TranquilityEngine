// Renaming in place (ADR 0278): the one text field the tree view and the asset tiles put where a name was. It takes
// focus with the name selected (or its first `selectTo` characters, a file's name without its extension), and ends
// exactly once: Enter or leaving the field commits, Escape cancels. The value isn't controlled, so a caller that
// re-renders while the user types (the live Hierarchy refreshes every 300 ms) doesn't reset it. The caller compares
// the committed value with the old name.
import { useLayoutEffect, useRef } from "preact/hooks";

export interface RenameFieldProps {
  /** The name it starts with. */
  readonly value: string;
  /** The field's accessible name ("Node name", "Element id"…). */
  readonly label: string;
  readonly placeholder?: string;
  readonly class?: string;
  /** How many characters to select at the start (default: all). */
  readonly selectTo?: number;
  /** Enter or blur: the text as typed. */
  onCommit(value: string): void;
  /** Escape. */
  onCancel(): void;
  /** After it ended from the keyboard (Enter or Escape), so the caller can put focus back where it was. */
  onKeyboardEnd?(): void;
}

export function RenameField(props: RenameFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = input.current!;
    el.focus(); // its own window's element: works in a detached panel window too (ADR 0174)
    el.setSelectionRange(0, props.selectTo ?? el.value.length);
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) props.onCommit(input.current!.value);
    else props.onCancel();
  };
  const stop = (e: Event) => e.stopPropagation();
  return (
    <input
      ref={input}
      class={props.class ?? "rename-input"}
      aria-label={props.label}
      placeholder={props.placeholder}
      defaultValue={props.value}
      onPointerDown={stop}
      onClick={stop}
      onDblClick={stop}
      onContextMenu={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.preventDefault();
        finish(e.key === "Enter");
        props.onKeyboardEnd?.();
      }}
      onBlur={() => finish(true)}
    />
  );
}
