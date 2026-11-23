// Re-import (ADR 0342 "Source versions"): pick a new file for the sample's audio, choose how its edits follow a new
// length (Keep seconds, or Scale to the new length), and see the source versions this machine keeps, each with
// Restore. Re-import is one undo step; the WAV's own changed cues and loops then open the merge review.
// `ReimportReview` is a pure view over its props; `ReimportDialog` wires it to the open sample (`sampleVersions.ts`).
import { useEffect, useRef, useState } from "preact/hooks";
import type { RemapMode } from "../../../engine/audio/sample/remap";
import type { SourceVersions } from "../../../engine/audio/sample/sourceVersions";
import { status } from "../../../editor/state";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { toasts } from "../../shell/studioServices";
import { nameOf } from "./sampleLibrary";
import { lengthOf } from "./sampleSession";
import { audioLength, readSourceVersions, reimportSample, restoreSourceVersion, type ReimportResult } from "./sampleVersions";
import { dialog, openSession } from "./samplesState";

const secs = (s: number | null) => (s === null ? "?" : `${s.toFixed(3)} s`);

export interface ReimportReviewProps {
  /** The sample's file name. */
  readonly name: string;
  /** Its length now (null while unknown). */
  readonly length: number | null;
  readonly versions: SourceVersions;
  /** The picked file, with its length once read. */
  readonly picked: { readonly name: string; readonly length: number | null } | null;
  readonly mode: RemapMode;
  readonly busy?: boolean;
  onPick(): void;
  onMode(mode: RemapMode): void;
  onImport(): void;
  onRestore(n: number): void;
  onCancel(): void;
}

/** The review (pure view over its props). */
export function ReimportReview(props: ReimportReviewProps) {
  const { picked, length } = props;
  const shorter = picked?.length != null && length !== null && picked.length < length - 1e-6;
  const changed = picked?.length != null && length !== null && Math.abs(picked.length - length) > 1e-6;
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="dialog smp-dialog" role="dialog" aria-modal="true" aria-label={`Re-import ${props.name}`} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
        <h2>Re-import {props.name}</h2>
        <p class="smp-muted">The new file replaces the audio; markers, loops, trim and effects are kept. The audio as it is now is kept as a version in .myco/sample-versions/ (on this machine), and Undo puts it back.</p>
        <div class="smp-actions">
          <button class="primary" autoFocus={!picked} onClick={props.onPick}>{picked ? "Choose another file…" : "Choose a file…"}</button>
          {picked && <span>{picked.name} · {secs(picked.length)} <span class="smp-muted">(now {secs(length)})</span></span>}
        </div>
        {picked && changed && (
          <div class="fld">
            <span>Edits</span>
            <SegmentedControl label="How edits follow the new length" value={props.mode} onChange={props.onMode}
              options={[{ value: "seconds", label: "Keep seconds" }, { value: "scale", label: "Scale to the new length" }]} />
          </div>
        )}
        {picked && changed && <p class="smp-muted">{props.mode === "seconds" ? "Every marker, loop and the trim stay at the same time (a new tail or a fixed click)." : "Every time keeps its place relative to the length (a time-stretched version); the tempo follows."}</p>}
        {shorter && props.mode === "seconds" && <p class="smp-warning" role="alert">The new file is shorter: edits past its end are kept and flagged, and Fit to the source pulls them in.</p>}
        <h3 class="smp-insp-section">Source versions</h3>
        {props.versions.versions.length === 0 ? (
          <p class="smp-muted">None yet: the first re-import keeps the current audio as v1.</p>
        ) : (
          <ul class="smp-versions" aria-label="Source versions">
            {[...props.versions.versions].reverse().map((v) => (
              <li key={v.n}>
                <b>v{v.n}</b> <span>{v.kind === "original" ? "Original" : v.name}</span>
                <span class="smp-muted">{v.at ? new Date(v.at).toLocaleString() : ""}{v.length !== null ? ` · ${secs(v.length)}` : ""}</span>
                {v.n === props.versions.current ? <span class="smp-muted">Current</span> : <button disabled={props.busy} onClick={() => props.onRestore(v.n)}>Restore</button>}
              </li>
            ))}
          </ul>
        )}
        <div class="dialog-buttons">
          <button onClick={props.onCancel}>Cancel</button>
          <button class="primary" disabled={props.busy || !picked} onClick={props.onImport}>{props.busy ? "Re-importing…" : "Re-import"}</button>
        </div>
      </div>
    </div>
  );
}

/** "Re-imported as v2 · 3 changes in the file's cues and loops to review · 1 item past the end". */
export function reimportMessage(r: Exclude<ReimportResult, { refused: string }>, verb = "Re-imported as"): string {
  return [`${verb} v${r.version}`, r.changes ? `${r.changes} change${r.changes === 1 ? "" : "s"} in the file's cues and loops to review` : "", r.outside ? `${r.outside} item${r.outside === 1 ? "" : "s"} past the end` : ""].filter(Boolean).join(" · ");
}

export function ReimportDialog() {
  const session = openSession.value;
  const [versions, setVersions] = useState<SourceVersions>({ current: 0, versions: [] });
  const [picked, setPicked] = useState<{ name: string; bytes: Uint8Array; length: number | null } | null>(null);
  const [mode, setMode] = useState<RemapMode>("seconds");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (session) void readSourceVersions(session.project, session.path).then(setVersions);
  }, [session]);
  if (!session) return null;
  const close = () => (dialog.value = null);
  const done = (r: ReimportResult, verb?: string) => {
    if ("refused" in r) return void (status.value = { kind: "info", text: `Can't re-import: ${r.refused}.` });
    close();
    toasts.show({ text: reimportMessage(r, verb), undo: () => session.undo() });
    if (r.changes) dialog.value = { kind: "merge" };
  };
  const run = async (work: () => Promise<ReimportResult>, verb?: string) => {
    setBusy(true);
    try {
      done(await work(), verb);
    } catch (err) {
      status.value = { kind: "error", text: `Couldn't re-import ${nameOf(session.path)}: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      setBusy(false);
    }
  };
  const ext = session.path.slice(session.path.lastIndexOf("."));
  return (
    <>
      <ReimportReview
        name={nameOf(session.path)}
        length={lengthOf(session.project, session.source.value)}
        versions={versions}
        picked={picked}
        mode={mode}
        busy={busy}
        onPick={() => input.current?.click()}
        onMode={setMode}
        onCancel={close}
        onImport={() => picked && void run(() => reimportSample(session, picked.bytes, picked.name, mode))}
        onRestore={(n) => void run(() => restoreSourceVersion(session, n, mode), "Restored")}
      />
      <input ref={input} type="file" accept={ext} hidden onChange={async (e) => {
        const file = (e.currentTarget as HTMLInputElement).files?.[0];
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        setPicked({ name: file.name, bytes, length: await audioLength(session.project, bytes, file.name) });
      }} />
    </>
  );
}
