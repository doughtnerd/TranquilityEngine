// The take controls of the graph editor's debugger (ADR 0348, 0373; T73): open a recorded take from the project's `recordings/`
// folder to debug this graph against it, and, while one is open, say what changed in the project since it was recorded.
// `TakePicker` is the menu (files, Open, Close, why a file wouldn't open); `TakeNotes` lists what the take or the project
// differs by. Both are views of their props; `TakeBar` (`takeControl.ts` state) wires them.
import { useState } from "preact/hooks";

export interface TakePickerProps {
  /** The take files of the project (paths). */
  files: readonly string[];
  /** The take open now, or null. */
  open: string | null;
  /** A take is being read. */
  busy: boolean;
  /** Why the last open failed, or null. */
  error: string | null;
  onOpen(path: string): void;
  onClose(): void;
}

/** A take path as a short label (`recordings/run_01.sporesample` -> `run_01`). */
export function takeLabel(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.sporesample$/i, "");
}

export function TakePicker(props: TakePickerProps) {
  const [picked, setPicked] = useState<string>("");
  const choice = picked !== "" && props.files.includes(picked) ? picked : (props.files[0] ?? "");
  return (
    <div class="dbg-take" role="group" aria-label="Take">
      {props.open ? (
        <>
          <span class="dbg-take-name" title={props.open}>Take {takeLabel(props.open)}</span>
          <button onClick={props.onClose} title="Close the take and debug the running game again">Close take</button>
        </>
      ) : (
        <>
          <label class="dbg-take-pick">
            <span class="dbg-muted">Take</span>
            <select aria-label="Take file" value={choice} disabled={props.files.length === 0 || props.busy} onChange={(e) => setPicked((e.currentTarget as HTMLSelectElement).value)}>
              {props.files.length === 0 && <option value="">No takes in the project</option>}
              {props.files.map((f) => <option key={f} value={f}>{takeLabel(f)}</option>)}
            </select>
          </label>
          <button disabled={choice === "" || props.busy} onClick={() => props.onOpen(choice)} title="Debug this graph against a recorded take">{props.busy ? "Opening…" : "Open take"}</button>
        </>
      )}
      {props.error && <span class="dbg-refused" role="alert">{props.error}</span>}
    </div>
  );
}

export interface TakeNotesProps {
  /** One sentence each: what the project changed by since the take, and what of it didn't read. */
  notes: readonly string[];
}

export function TakeNotes(props: TakeNotesProps) {
  if (props.notes.length === 0) return null;
  return (
    <ul class="dbg-notes" role="status" aria-label="Take notes">
      {props.notes.map((n, i) => <li key={i}>{n}</li>)}
    </ul>
  );
}
