// The New parameter dialog (UI pass J4.1, J5.1, J6.5): what "+ New parameter…" in a parameter select opens. A name, the
// kind (a number with a range and default, or labels: a state such as a surface), and Create; the caller adds the
// definition where its parameters live and picks it in the select it came from. A caller that needs one kind (a Switch
// reads labels, a Blend axis a number) fixes it. Rendered into the document body, so no container-type ancestor (a
// header, a toolbar) becomes the containing block of its fixed backdrop. Escape or a click on the backdrop cancels;
// Enter creates.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact";
import type { ParameterDef } from "../../engine/audio/parameters";
import { newDraft, parameterFromDraft, whyNotCreate, type NewParameterKind, type ParameterDraft } from "./newParameterModel";
import "./newParameterDialog.css";

export interface NewParameterDialogProps {
  /** The names already taken where the parameter goes. */
  readonly existing: readonly string[];
  /** Only this kind (the select reads numbers, or labels); omitted: the user chooses. */
  readonly kind?: NewParameterKind;
  /** Where it goes, in a line ("A global parameter: the game sets it, and any playlist or bus can read it."). */
  readonly note?: string;
  /** The most parameters where it goes. */
  readonly limit?: number;
  /** Also offer True / false and Text (the project's global parameters take them; a playlist's own don't). */
  readonly types?: boolean;
  onCreate(def: ParameterDef): void;
  onCancel(): void;
}

export function NewParameterDialog(props: NewParameterDialogProps) {
  const [d, setD] = useState<ParameterDraft>(() => newDraft(props.existing, props.kind ?? "numeric"));
  const ref = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    name.current?.focus();
    name.current?.select();
  }, []);
  const set = (patch: Partial<ParameterDraft>) => setD((x) => ({ ...x, ...patch }));
  const why = whyNotCreate(d, props.existing, props.limit);
  const create = () => {
    if (why === null) props.onCreate(parameterFromDraft(d));
  };
  const num = (key: "min" | "max" | "default", label: string) => (
    <label class="studio-newparam-field">
      <span>{label}</span>
      <input type="number" aria-label={label} value={d[key]} onInput={(e) => set({ [key]: (e.currentTarget as HTMLInputElement).valueAsNumber })} />
    </label>
  );
  return createPortal(
    <div class="studio-newparam-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div
        ref={ref}
        class="studio-newparam"
        role="dialog"
        aria-modal="true"
        aria-label="New parameter"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            create();
          }
        }}
      >
        <h2 class="studio-newparam-title">New parameter</h2>
        {props.note && <p class="studio-newparam-note">{props.note}</p>}
        <label class="studio-newparam-field">
          <span>Name</span>
          <input ref={name} type="text" aria-label="Name" value={d.name} onInput={(e) => set({ name: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        {props.kind === undefined && (
          <div class="studio-newparam-field" role="radiogroup" aria-label="Kind">
            <span>Kind</span>
            <label class="studio-newparam-radio"><input type="radio" name="studio-newparam-kind" checked={d.kind === "numeric"} onChange={() => set({ kind: "numeric" })} /> Number</label>
            <label class="studio-newparam-radio"><input type="radio" name="studio-newparam-kind" checked={d.kind === "labelled"} onChange={() => set({ kind: "labelled" })} /> Labels</label>
            {props.types && <label class="studio-newparam-radio"><input type="radio" name="studio-newparam-kind" checked={d.kind === "bool"} onChange={() => set({ kind: "bool" })} /> True / false</label>}
            {props.types && <label class="studio-newparam-radio"><input type="radio" name="studio-newparam-kind" checked={d.kind === "text"} onChange={() => set({ kind: "text" })} /> Text</label>}
          </div>
        )}
        {d.kind === "numeric" ? (
          <div class="studio-newparam-range">
            {num("min", "Min")}
            {num("max", "Max")}
            {num("default", "Default")}
          </div>
        ) : d.kind === "bool" ? null : (
          <label class="studio-newparam-field">
            <span>{d.kind === "text" ? "Values" : "Labels"}</span>
            <input type="text" aria-label={d.kind === "text" ? "Values" : "Labels"} title={d.kind === "text" ? "The values the game sends, comma-separated, to test with (conditions can also match part of the text)" : "Comma-separated; the first is the default"} value={d.labels} onInput={(e) => set({ labels: (e.currentTarget as HTMLInputElement).value })} />
          </label>
        )}
        <div class="studio-newparam-buttons">
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" class="primary" disabled={why !== null} title={why ?? undefined} onClick={create}>Create</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
