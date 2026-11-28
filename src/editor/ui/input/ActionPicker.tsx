// A mapping's action picker (ADR 0433): a button naming the action and its set, opening a searchable list grouped by
// set (`actionPickerModel.ts` has the rules). Typing filters every set; ↑ ↓ move one highlight across the sections and
// the Create rows, Enter picks, Esc closes and keeps the old choice. A set's header folds it; folds are remembered per
// project across editor restarts (`pickerFolds.ts`), and the engine's sets start folded.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { initialHighlight, moveHighlight, pickerModel, type PickerRow, type PickerSet } from "./actionPickerModel";
import { pickerFolds, setPickerFold } from "./pickerFolds";

let pickers = 0;

export interface ActionPickerProps {
  readonly sets: readonly PickerSet[];
  /** Whose folds the picker shows and remembers: the project (its folder's path, or a sample's name). */
  readonly project: string;
  /** The action the mapping names now, resolved; null when it names none that exists. */
  readonly current: { readonly set: string; readonly name: string } | null;
  /** What the mapping names, as written (shown when it names no action). */
  readonly value: string;
  readonly readOnly: boolean;
  onPick(set: string, name: string): void;
  onCreate(set: string, name: string): void;
  onNewSet(name: string): void;
}

const rowKey = (r: PickerRow) => (r.kind === "action" ? `a:${r.set}:${r.name}` : r.kind === "create" ? `c:${r.set}` : "n");

export function ActionPicker(props: ActionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [foldVersion, setFoldVersion] = useState(0);
  const [hi, setHi] = useState(-1);
  const root = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useMemo(() => `input-action-picker-${++pickers}`, []);
  const folds = useMemo(() => pickerFolds(props.project), [props.project, foldVersion]);
  const model = useMemo(() => pickerModel(props.sets, query, folds), [props.sets, query, folds]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector(`[data-row="${hi}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [hi, open]);

  const show = () => {
    if (props.readOnly) return;
    setQuery("");
    setOpen(true);
    setHi(initialHighlight(pickerModel(props.sets, "", folds), props.current, ""));
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) root.current?.querySelector<HTMLButtonElement>(".input-picker-button")?.focus();
  };
  const pick = (row: PickerRow | undefined) => {
    if (!row) return;
    close();
    if (row.kind === "action") props.onPick(row.set, row.name);
    else if (row.kind === "create") props.onCreate(row.set, row.name);
    else props.onNewSet(row.name);
  };
  const toggleFold = (set: string, folded: boolean) => {
    setPickerFold(props.project, set, !folded);
    setFoldVersion((v) => v + 1);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi(moveHighlight(model, hi, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(model.rows[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the dialog's Escape closes the dialog
      close();
    }
  };

  const current = props.current;
  let index = 0;
  const option = (row: PickerRow, children: ComponentChildren) => {
    const i = index++;
    return (
      <li
        key={rowKey(row)}
        id={`${id}-${i}`}
        role="option"
        data-row={i}
        aria-selected={i === hi}
        class={`input-picker-option${i === hi ? " highlighted" : ""}${row.kind !== "action" ? " create" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setHi(i)}
        onClick={() => pick(row)}
      >
        {children}
      </li>
    );
  };

  return (
    <span
      ref={root}
      class="input-picker"
      onFocusOut={(e) => {
        if (open && !root.current?.contains((e as FocusEvent).relatedTarget as Node | null)) close(false);
      }}
    >
      <button class={`input-picker-button${current ? "" : " missing"}`} aria-label="Action" aria-haspopup="listbox" aria-expanded={open} disabled={props.readOnly} onClick={() => (open ? close() : show())}>
        {current ? (
          <>
            <span class="input-picker-name">{current.name}</span>
            <span class="input-picker-set">{current.set}</span>
          </>
        ) : (
          <span class="input-picker-name">{props.value ? `${props.value} (not defined)` : "(choose an action)"}</span>
        )}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div class="input-picker-popup">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search actions"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={hi >= 0 ? `${id}-${hi}` : undefined}
            placeholder="Search actions and sets"
            spellcheck={false}
            value={query}
            onInput={(e) => {
              const q = e.currentTarget.value;
              setQuery(q);
              setHi(initialHighlight(pickerModel(props.sets, q, folds), props.current, q));
            }}
            onKeyDown={onKeyDown}
          />
          <ul id={`${id}-list`} role="listbox" aria-label="Actions" class="input-picker-list">
            {model.sections.map((s) => (
              <li key={s.id} role="presentation" class="input-picker-section">
                <button
                  class="input-picker-head"
                  tabIndex={-1}
                  aria-expanded={!s.folded}
                  disabled={!!query.trim()}
                  title={s.folded ? "Unfold" : "Fold"}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleFold(s.id, s.folded)}
                >
                  <span aria-hidden="true">{s.folded ? "▸" : "▾"}</span>
                  <span class="input-picker-set-id">{s.id}</span>
                  <span class="input-picker-count">{query.trim() ? `${s.shown} of ${s.total}` : s.total}</span>
                </button>
                {s.rows.length > 0 && (
                  <ul role="group" aria-label={s.id}>
                    {s.rows.map((r) =>
                      r.kind === "action"
                        ? option(
                            r,
                            <>
                              <span class="input-picker-name">
                                {r.label.pre}
                                {r.label.mid && <mark>{r.label.mid}</mark>}
                                {r.label.post}
                              </span>
                              <span class="input-picker-type">{r.type}</span>
                              {current?.set === r.set && current.name === r.name && <span aria-label="current">✓</span>}
                            </>,
                          )
                        : null,
                    )}
                  </ul>
                )}
              </li>
            ))}
            {model.noMatch && <li role="presentation" class="input-picker-note">No action matches “{query.trim()}”.</li>}
            {model.badName && <li role="presentation" class="input-picker-note">{model.badName}</li>}
            {model.create.length > 0 && (
              <li role="presentation" class="input-picker-section">
                <ul role="group" aria-label="Create">
                  {model.create.map((r) => option(r, r.kind === "create" ? `Create “${r.name}” in ${r.set}` : "New set…"))}
                </ul>
              </li>
            )}
          </ul>
          <p class="input-picker-hint">↑ ↓ move, Enter picks, Esc keeps the old choice.</p>
        </div>
      )}
    </span>
  );
}
