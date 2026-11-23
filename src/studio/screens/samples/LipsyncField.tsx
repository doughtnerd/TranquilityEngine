// The Samples inspector's Lip-sync row (ADR 0354 §7): how many viseme keys the sample's sidecar holds, Import (Rhubarb
// Lip Sync's TSV or JSON output, read by `engine/audio/localisation/lipsync.ts`; the Studio never runs Rhubarb) and
// Clear, each one undo step through the sample's session.
import { parseRhubarb, withLipsync } from "../../../engine/audio/localisation/lipsync";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { useRef } from "preact/hooks";
import type { SampleEdit } from "./sampleEditing";

export interface LipsyncFieldProps {
  readonly e: SampleEdits;
  readonly ro: boolean;
  commit(result: SampleEdit): void;
  /** Tells the user what an import skipped. */
  onProblem(message: string): void;
}

export function LipsyncField(props: LipsyncFieldProps) {
  const keys = props.e.lipsync?.keys.length ?? 0;
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="fld">
      <span>Lip-sync</span>
      <span>
        {keys ? `${keys} key${keys === 1 ? "" : "s"} (${props.e.lipsync!.set})` : "None"}{" "}
        {/* A real button opens the hidden file input, so the keyboard reaches it (a label around it can't take focus). */}
        <button type="button" class="smp-link" disabled={props.ro} title="Import Rhubarb Lip Sync output (.txt/.tsv or .json) for this file" onClick={() => input.current?.click()}>
          Import…
        </button>
        <input ref={input} type="file" hidden accept=".txt,.tsv,.json,text/plain,application/json" aria-label="Import Rhubarb lip-sync output" disabled={props.ro}
            onChange={async (ev) => {
              const input = ev.currentTarget as HTMLInputElement;
              const file = input.files?.[0];
              input.value = "";
              if (!file) return;
              const imported = parseRhubarb(await file.text(), file.name);
              const result = withLipsync(props.e, imported);
              props.commit(result); // a refusal shows in the screen's status line
              if ("next" in result && imported.problems.length) props.onProblem(`Lip-sync imported; ${imported.problems.length} row${imported.problems.length === 1 ? "" : "s"} skipped (${imported.problems[0]}).`);
            }} />
        {keys > 0 && <> <button class="smp-link" disabled={props.ro} onClick={() => props.commit(withLipsync(props.e, null))}>Clear</button></>}
      </span>
    </div>
  );
}
