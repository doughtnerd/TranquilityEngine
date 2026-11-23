// The Samples screen's dialogs: Write to file… (what is written, the backup), the changed-on-disk merge review (per
// change: Keep project / Use file, new items Add / Skip, conflicts flagged), and Fork / Duplicate / Save snippet as
// sample. Each review is a pure view over its props; `SampleDialogs` wires them to the open sample.
import { useState } from "preact/hooks";
import { currentProject, status } from "../../../editor/state";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { toasts } from "../../shell/studioServices";
import { ImportDialog } from "./ImportDialog";
import { ReimportDialog } from "./ReimportDialog";
import { applyMerge, writeSummary, type MergeChoice, type MergeRow, type WriteSummaryRow } from "./sampleFile";
import { diskChange } from "./sampleDisk";
import { snippets } from "./sampleEditing";
import { audioFolders, folderOf, nameOf } from "./sampleLibrary";
import { lengthOf } from "./sampleSession";
import { deriveSample, freeSamplePath, stemOf, writeDerived, writeToFile, type DeriveKind } from "./sampleWrites";
import { dialog, openSample, openSession } from "./samplesState";

const CHOICE_NAMES: Record<MergeChoice, string> = { project: "Keep project", file: "Use file", add: "Add", skip: "Skip" };

function Frame(props: { label: string; onCancel(): void; children: preact.ComponentChildren }) {
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="dialog smp-dialog" role="dialog" aria-modal="true" aria-label={props.label} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
        {props.children}
      </div>
    </div>
  );
}

export function WriteReview(props: { name: string; rows: readonly WriteSummaryRow[]; keptInSidecar: number; busy?: boolean; onWrite(): void; onCancel(): void }) {
  return (
    <Frame label={`Write to ${props.name}`} onCancel={props.onCancel}>
      <h2>Write to {props.name}</h2>
      <p class="smp-muted">The audio isn't changed: only these chunks are rewritten. A copy of the file as it is now is kept in .myco/sample-versions/.</p>
      <table class="smp-write">
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.chunks + r.what}>
              <td>{r.what}</td>
              <td class="smp-muted">{r.chunks}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.keptInSidecar > 0 && <p class="smp-muted">{props.keptInSidecar} Exit, Hit point or Cue marker{props.keptInSidecar === 1 ? "" : "s"} stay in the sidecar (a WAV can't carry their types).</p>}
      <div class="dialog-buttons">
        <button onClick={props.onCancel}>Cancel</button>
        <button class="primary" autoFocus disabled={props.busy} onClick={props.onWrite}>{props.busy ? "Writing…" : "Write to file"}</button>
      </div>
    </Frame>
  );
}

export function MergeReview(props: { name: string; rows: readonly MergeRow[]; onApply(rows: MergeRow[]): void; onLater(): void }) {
  const [choices, setChoices] = useState<Record<string, MergeChoice>>(() => Object.fromEntries(props.rows.map((r) => [r.key, r.choice])));
  const conflicts = props.rows.filter((r) => r.conflict).length;
  return (
    <Frame label={`${props.name} changed on disk`} onCancel={props.onLater}>
      <h2>{props.name} changed on disk</h2>
      <p class="smp-muted">The audio is reloaded either way. For each change to the file's cues and loops, choose what the project keeps. Markers you added in the project are never touched.</p>
      <ul class="smp-merge">
        {props.rows.map((r) => (
          <li key={r.key} class={r.conflict ? "conflict" : undefined}>
            <div>
              <b>{r.title}</b> <span class="smp-muted">{r.detail}</span>
              {r.conflict && <div class="smp-warning">You also changed this in the project.</div>}
            </div>
            <SegmentedControl size="small" label={r.title} value={choices[r.key]} options={r.options.map((o) => ({ value: o, label: CHOICE_NAMES[o] }))} onChange={(v) => setChoices({ ...choices, [r.key]: v })} />
          </li>
        ))}
      </ul>
      {conflicts > 0 && <p class="smp-warning">{conflicts} conflict{conflicts === 1 ? "" : "s"} with project edits</p>}
      <div class="dialog-buttons">
        <button onClick={props.onLater}>Later</button>
        <button class="primary" onClick={() => props.onApply(props.rows.map((r) => ({ ...r, choice: choices[r.key] })))}>Apply</button>
      </div>
    </Frame>
  );
}

export interface DeriveFormProps {
  readonly kind: DeriveKind;
  readonly parentName: string;
  readonly name: string;
  readonly folder: string;
  readonly folders: readonly string[];
  readonly mode: "follow" | "pin";
  readonly edits: number;
  onName(name: string): void;
  onFolder(folder: string): void;
  onMode(mode: "follow" | "pin"): void;
  onCreate(): void;
  onCancel(): void;
}

export function DeriveForm(props: DeriveFormProps) {
  const title = props.kind === "fork" ? "Fork as new sample" : props.kind === "duplicate" ? "Duplicate sample" : "Save snippet as sample";
  return (
    <Frame label={title} onCancel={props.onCancel}>
      <h2>{title}</h2>
      <label class="fld">
        <span>Name</span>
        <input autoFocus value={props.name} aria-label="Name" onInput={(e) => props.onName((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label class="fld">
        <span>Folder</span>
        <select value={props.folder} aria-label="Folder" onChange={(e) => props.onFolder((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">Top level</option>
          {props.folders.filter((f) => !f.startsWith(".")).map((f) => <option key={f} value={f}>{f.split("/").join(" › ")}</option>)}
        </select>
      </label>
      <p class="smp-muted">References {props.parentName} {props.kind === "snippet" ? "(the snippet's range)" : `and its ${props.edits} edit${props.edits === 1 ? "" : "s"}`}; no audio is copied.</p>
      {props.kind === "fork" && (
        <div class="fld">
          <span>Parent changes</span>
          <SegmentedControl label="Parent changes" value={props.mode} options={[{ value: "follow", label: "Follow the parent" }, { value: "pin", label: "Pin to its current state" }]} onChange={props.onMode} />
        </div>
      )}
      <div class="dialog-buttons">
        <button onClick={props.onCancel}>Cancel</button>
        <button class="primary" disabled={props.name.trim() === ""} onClick={props.onCreate}>Create</button>
      </div>
    </Frame>
  );
}

function DeriveDialog(props: { kind: DeriveKind; snippet?: number }) {
  const session = openSession.value;
  const project = currentProject.value;
  const base = session ? stemOf(session.path) : "";
  const suffix = props.kind === "fork" ? "_fork" : props.kind === "duplicate" ? "_copy" : `_snippet${props.snippet ?? 1}`;
  const [name, setName] = useState(`${base}${suffix}`);
  const [folder, setFolder] = useState(session ? folderOf(session.path) : "");
  const [mode, setMode] = useState<"follow" | "pin">("follow");
  if (!session || !project) return null;
  const close = () => (dialog.value = null);
  const e = session.edits.value;
  const count = e.markers.length + e.loops.length + e.effects.length + (e.trim ? 1 : 0);
  return (
    <DeriveForm
      kind={props.kind} parentName={nameOf(session.path)} name={name} folder={folder} folders={audioFolders(project.folders, project.files)} mode={mode} edits={count}
      onName={setName} onFolder={setFolder} onMode={setMode} onCancel={close}
      onCreate={async () => {
        const length = lengthOf(project, session.source.peek()) ?? 0;
        const s = props.snippet !== undefined ? snippets(e, length).find((x) => x.index === props.snippet) : undefined;
        const path = freeSamplePath(project, folder, name.trim().replace(/\.sample\.json$/i, ""));
        const derived = deriveSample(props.kind, session.path, session.source.peek(), e, { mode, range: s ? [s.start, s.end] : undefined });
        try {
          await writeDerived(project, path, derived);
        } catch (err) {
          status.value = { kind: "error", text: `Couldn't create ${path}: ${err instanceof Error ? err.message : String(err)}` };
          return;
        }
        close();
        toasts.show({ text: props.kind === "fork" ? `Forked ${nameOf(session.path)} as ${nameOf(path)} (${mode === "follow" ? "follows the parent" : "pinned"})` : `Created ${nameOf(path)}` });
        openSample(path);
      }}
    />
  );
}

/** The open dialog, if any. */
export function SampleDialogs() {
  const d = dialog.value;
  const session = openSession.value;
  const [busy, setBusy] = useState(false);
  if (!d) return null;
  const close = () => (dialog.value = null);
  if (d.kind === "import") return <ImportDialog />;
  if (d.kind === "reimport") return <ReimportDialog />;
  if (d.kind === "fork") return <DeriveDialog kind={d.mode} />;
  if (d.kind === "snippet") return <DeriveDialog kind="snippet" snippet={d.index} />;
  if (!session) return null;
  if (d.kind === "write") {
    const s = writeSummary(session.edits.value);
    return (
      <WriteReview name={nameOf(session.source.value)} rows={s.rows} keptInSidecar={s.keptInSidecar} busy={busy} onCancel={close}
        onWrite={async () => {
          setBusy(true);
          try {
            const r = await writeToFile(session);
            toasts.show({ text: `Wrote ${nameOf(session.source.peek())} · ${r.cues} cues, ${r.regions} regions and ${r.loops} loops (backup kept)` });
            close();
          } catch (err) {
            status.value = { kind: "error", text: `Couldn't write ${nameOf(session.source.peek())}: ${err instanceof Error ? err.message : String(err)}` };
          } finally {
            setBusy(false);
          }
        }} />
    );
  }
  const change = diskChange.value;
  if (d.kind === "merge" && change) {
    return (
      <MergeReview name={nameOf(change.path)} rows={change.rows} onLater={close}
        onApply={(rows) => {
          if (session.commit(applyMerge(session.edits.peek(), rows, nameOf(change.path)))) toasts.show({ text: `Merged changes from ${nameOf(change.path)}` });
          diskChange.value = null;
          close();
        }} />
    );
  }
  return null;
}
