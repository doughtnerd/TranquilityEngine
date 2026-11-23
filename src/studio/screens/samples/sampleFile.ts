// A sample against its WAV file (ADR 0342): the Inspector's Source block (what differs from the file, per field, with
// a revert each), Detach, what "Write to file…" writes, and the changed-on-disk merge review (per changed cue, region
// or loop: Keep project / Use file; new ones Add / Skip; conflicts where the project edited the item). Pure.
import type { LoopDirection, SampleEdits, SampleLoop, SampleMarker } from "../../../engine/audio/sample/types";
import { sampleEditsFromWav } from "../../../engine/audio/sample/wavSample";
import type { WavMetadata } from "../../../engine/audio/sample/wavChunks";
import type { SampleEdit } from "./sampleEditing";

const ok = (next: SampleEdits, label: string): SampleEdit => ({ next, label });
const no = (refused: string): SampleEdit => ({ refused });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export type MarkerField = "type" | "name" | "at" | "end";
export type LoopField = "start" | "end" | "direction" | "count";

export interface DiffRow<F extends string> {
  readonly field: F;
  /** What the file says. */
  readonly file: string | number | null;
  /** What the project has. */
  readonly project: string | number | null;
}

/** Where a file-linked item came from, for its chip ("cue 2", "region 1", "smpl loop 1"). */
export function fileOrigin(item: SampleMarker | SampleLoop): string | null {
  if (!item.file) return null;
  if (item.file.chunk === "smpl") return `smpl loop ${item.file.index + 1}`;
  return item.file.chunk === "cue" ? `cue ${item.file.id}` : `region ${item.file.id}`;
}

/** A marker's fields that differ from its file snapshot (a WAV cue is a note, so any other type differs). */
export function markerDiff(m: SampleMarker): DiffRow<MarkerField>[] {
  const f = m.file;
  if (!f) return [];
  const out: DiffRow<MarkerField>[] = [];
  if (m.type !== "note") out.push({ field: "type", file: "note", project: m.type });
  if (f.name !== "" && m.name !== f.name) out.push({ field: "name", file: f.name, project: m.name });
  if (!near(m.at, f.at)) out.push({ field: "at", file: f.at, project: m.at });
  if ((f.end ?? null) !== (m.end ?? null) && !(f.end !== undefined && m.end !== undefined && near(f.end, m.end))) out.push({ field: "end", file: f.end ?? null, project: m.end ?? null });
  return out;
}

export function loopDiff(l: SampleLoop): DiffRow<LoopField>[] {
  const f = l.file;
  if (!f) return [];
  const out: DiffRow<LoopField>[] = [];
  if (!near(l.start, f.start)) out.push({ field: "start", file: f.start, project: l.start });
  if (!near(l.end, f.end)) out.push({ field: "end", file: f.end, project: l.end });
  if (l.direction !== f.direction) out.push({ field: "direction", file: f.direction, project: l.direction });
  if (l.count !== f.count) out.push({ field: "count", file: f.count, project: l.count });
  return out;
}

/** Put a marker field back to the file's value (the type back to note also restores the name). */
export function revertMarker(e: SampleEdits, id: string, field?: MarkerField): SampleEdit {
  const m = e.markers.find((x) => x.id === id);
  if (!m?.file) return no("that marker isn't from the file");
  const f = m.file;
  const next: SampleMarker = { ...m };
  const fields = field ? [field] : markerDiff(m).map((r) => r.field);
  if (fields.length === 0) return no("nothing differs from the file");
  for (const k of fields) {
    if (k === "type") {
      next.type = "note";
      if (f.name) next.name = f.name;
    } else if (k === "name") next.name = f.name || next.name;
    else if (k === "at") next.at = f.at;
    else if (f.end === undefined) delete next.end;
    else next.end = f.end;
  }
  return ok({ ...e, markers: e.markers.map((x) => (x.id === id ? next : x)).sort((a, b) => a.at - b.at) }, `Revert ${m.name}`);
}

export function revertLoop(e: SampleEdits, id: string, field?: LoopField): SampleEdit {
  const l = e.loops.find((x) => x.id === id);
  if (!l?.file) return no("that loop isn't from the file");
  const fields = field ? [field] : loopDiff(l).map((r) => r.field);
  if (fields.length === 0) return no("nothing differs from the file");
  const next: SampleLoop = { ...l };
  for (const k of fields) {
    if (k === "start") next.start = l.file.start;
    else if (k === "end") next.end = l.file.end;
    else if (k === "direction") next.direction = l.file.direction;
    else next.count = l.file.count;
  }
  const others = e.loops.filter((x) => x.id !== id);
  if (others.some((o) => next.start < o.end && o.start < next.end)) return no("the file's loop would overlap another loop");
  return ok({ ...e, loops: [...others, next].sort((a, b) => a.start - b.start) }, `Revert loop`);
}

/** Detach one marker from the file. */
export function detachMarker(e: SampleEdits, id: string): SampleEdit {
  const m = e.markers.find((x) => x.id === id);
  if (!m?.file) return no("that marker isn't from the file");
  return ok({ ...e, markers: e.markers.map((x) => (x.id === id ? { ...x, file: null } : x)) }, `Detach ${m.name}`);
}

/** Detach the whole sample: no item tracks the file; file tempo and root become set values. */
export function detachAll(e: SampleEdits): SampleEdit {
  const linked = e.markers.some((m) => m.file) || e.loops.some((l) => l.file) || e.tempo?.source === "file" || e.root?.source === "file";
  if (!linked) return no("nothing here tracks the file");
  return ok(
    {
      ...e,
      markers: e.markers.map((m) => ({ ...m, file: null })),
      loops: e.loops.map((l) => ({ ...l, file: null })),
      tempo: e.tempo ? { ...e.tempo, source: e.tempo.source === "file" ? "set" : e.tempo.source } : null,
      root: e.root ? { ...e.root, source: e.root.source === "file" ? "set" : e.root.source } : null,
    },
    "Detach from file",
  );
}

/** How many items differ from the file (the Source block's "· k changed"). */
export function changedCount(e: SampleEdits): number {
  return e.markers.filter((m) => markerDiff(m).length > 0).length + e.loops.filter((l) => loopDiff(l).length > 0).length;
}

// --- Write to file… -------------------------------------------------------------------------------------------------

export interface WriteSummaryRow {
  readonly what: string;
  readonly chunks: string;
}

/** What "Write to file…" will write (its review lists it). Exit, Hit point and Cue markers stay in the sidecar. */
export function writeSummary(e: SampleEdits): { rows: WriteSummaryRow[]; keptInSidecar: number } {
  const points = e.markers.filter((m) => m.type === "note" && m.end === undefined).length;
  const ranges = e.markers.filter((m) => m.type === "note" && m.end !== undefined).length;
  const rows: WriteSummaryRow[] = [
    { what: `${points} cue point${points === 1 ? "" : "s"}`, chunks: "cue + labl + note" },
    { what: `${ranges} region${ranges === 1 ? "" : "s"}`, chunks: "ltxt" },
    { what: e.loops.length ? `${e.loops.length} loop${e.loops.length === 1 ? "" : "s"}` : "Removes the smpl loops", chunks: "smpl" },
    { what: e.tempo ? `Tempo ${e.tempo.bpm} BPM ${e.tempo.meter}` : "No tempo (removes acid)", chunks: "acid" },
    { what: e.root ? `Root note ${e.root.note}${e.root.cents ? ` ${e.root.cents > 0 ? "+" : ""}${e.root.cents} ct` : ""}` : "No root note", chunks: "smpl" },
  ];
  return { rows, keptInSidecar: e.markers.filter((m) => m.type !== "note").length };
}

// --- changed on disk: the merge review ------------------------------------------------------------------------------

export type MergeChoice = "project" | "file" | "add" | "skip";

export interface MergeRow {
  readonly key: string;
  readonly kind: "marker" | "loop";
  /** "Moved cue", "New cue", "Loop end moved", "Removed from the file". */
  readonly title: string;
  readonly detail: string;
  /** The project also changed this item since the file last said it. */
  readonly conflict: boolean;
  readonly options: readonly MergeChoice[];
  readonly choice: MergeChoice;
  /** The project item (absent for a new file item). */
  readonly id?: string;
  /** The file's new item, as a sample item with its snapshot. */
  readonly fileMarker?: SampleMarker;
  readonly fileLoop?: SampleLoop;
}

const fmtS = (t: number) => `${t.toFixed(3)} s`;
const markerKey = (m: { file: { chunk: string; id: number } | null }) => (m.file ? `${m.file.chunk}:${m.file.id}` : "");

/**
 * The rows of the merge review between the project's block and the file as it is now. A marker or loop is matched
 * by its file id (cue or region id, smpl index); the default keeps the project where it edited the item, else uses
 * the file. Project-only items are never touched.
 */
export function mergeRows(e: SampleEdits, now: WavMetadata): MergeRow[] {
  const file = sampleEditsFromWav(now);
  const rows: MergeRow[] = [];
  const projectByKey = new Map(e.markers.filter((m) => m.file).map((m) => [markerKey(m), m]));
  for (const fm of file.markers) {
    const key = markerKey(fm);
    const pm = projectByKey.get(key);
    const label = fm.file!.chunk === "cue" ? "cue" : "region";
    if (!pm) {
      rows.push({ key, kind: "marker", title: `New ${label}`, detail: `${fm.name} at ${fmtS(fm.at)}`, conflict: false, options: ["add", "skip"], choice: "add", fileMarker: fm });
      continue;
    }
    projectByKey.delete(key);
    const was = pm.file!;
    const fileChanged = !near(was.at, fm.at) || was.name !== fm.file!.name || (was.end ?? null) !== (fm.end ?? null);
    if (!fileChanged) continue;
    const edited = markerDiff(pm).length > 0;
    rows.push({
      key, kind: "marker", title: `${near(was.at, fm.at) ? "Changed" : "Moved"} ${label}`,
      detail: `${pm.name}: ${fmtS(was.at)} → ${fmtS(fm.at)}${was.name !== fm.file!.name ? ` · renamed ${fm.file!.name}` : ""}`,
      conflict: edited, options: ["project", "file"], choice: edited ? "project" : "file", id: pm.id, fileMarker: fm,
    });
  }
  for (const [key, pm] of projectByKey) {
    rows.push({ key, kind: "marker", title: `Removed from the file`, detail: `${pm.name} at ${fmtS(pm.at)}`, conflict: markerDiff(pm).length > 0, options: ["project", "file"], choice: "project", id: pm.id });
  }
  const projectLoops = new Map(e.loops.filter((l) => l.file).map((l) => [l.file!.index, l]));
  // Loops a sidecar holds without a file snapshot (written before snapshots were kept): a file loop overlapping one
  // is that loop, its own bounds standing in for what the file last said, rather than a new loop.
  const untracked = e.loops.filter((l) => !l.file);
  const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start);
  for (const fl of file.loops) {
    const idx = fl.file!.index;
    let pl = projectLoops.get(idx);
    let was: { start: number; end: number; direction: string; count: number } | undefined = pl?.file ?? undefined;
    if (!pl) {
      const twin = untracked.filter((l) => overlap(l, fl) > 0).sort((a, b) => overlap(b, fl) - overlap(a, fl))[0];
      if (twin) {
        untracked.splice(untracked.indexOf(twin), 1);
        pl = twin;
        was = { start: twin.start, end: twin.end, direction: twin.direction, count: twin.count };
      }
    }
    if (!pl || !was) {
      rows.push({ key: `smpl:${idx}`, kind: "loop", title: "New loop", detail: `${fmtS(fl.start)} – ${fmtS(fl.end)}`, conflict: false, options: ["add", "skip"], choice: "add", fileLoop: fl });
      continue;
    }
    projectLoops.delete(idx);
    const startMoved = !near(was.start, fl.start), endMoved = !near(was.end, fl.end);
    if (!startMoved && !endMoved && was.direction === fl.direction && was.count === fl.count) continue;
    const edited = loopDiff(pl).length > 0;
    const what = startMoved && endMoved ? "Loop moved" : startMoved ? "Loop start moved" : endMoved ? "Loop end moved" : "Loop settings changed";
    rows.push({
      key: `smpl:${idx}`, kind: "loop", title: what, detail: `${fmtS(was.start)} – ${fmtS(was.end)} → ${fmtS(fl.start)} – ${fmtS(fl.end)}`,
      conflict: edited, options: ["project", "file"], choice: edited ? "project" : "file", id: pl.id, fileLoop: fl,
    });
  }
  return rows;
}

/**
 * Apply the merge choices. Every matched item's `file` snapshot takes the file's new values whatever the choice, so a
 * "Keep project" item then reads as changed against the file; "Use file" takes the file's values; new items are
 * added with fresh ids; an item the file dropped and "Use file" removes it.
 */
export function applyMerge(e: SampleEdits, rows: readonly MergeRow[], name: string): SampleEdit {
  let markers = [...e.markers];
  let loops = [...e.loops];
  const ids = new Set(markers.map((m) => m.id));
  const loopIds = new Set(loops.map((l) => l.id));
  const fresh = (prefix: string, used: Set<string>) => {
    for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return used.add(`${prefix}${i}`), `${prefix}${i}`;
  };
  for (const r of rows) {
    if (r.kind === "marker") {
      if (r.choice === "skip") continue;
      if (r.choice === "add" && r.fileMarker) markers.push({ ...r.fileMarker, id: fresh("m", ids) });
      else if (r.id && !r.fileMarker) {
        if (r.choice === "file") markers = markers.filter((m) => m.id !== r.id);
        else markers = markers.map((m) => (m.id === r.id ? { ...m, file: null } : m));
      } else if (r.id && r.fileMarker) {
        const fm = r.fileMarker;
        markers = markers.map((m) => {
          if (m.id !== r.id) return m;
          if (r.choice === "project") return { ...m, file: fm.file };
          const next: SampleMarker = { ...m, at: fm.at, name: fm.name, file: fm.file };
          if (fm.end === undefined) delete next.end;
          else next.end = fm.end;
          return next;
        });
      }
    } else {
      if (r.choice === "skip") continue;
      if (r.choice === "add" && r.fileLoop) {
        const fl = r.fileLoop;
        if (!loops.some((l) => fl.start < l.end && l.start < fl.end)) loops.push({ ...fl, id: fresh("l", loopIds) });
      } else if (r.id && r.fileLoop) {
        const fl = r.fileLoop;
        loops = loops.map((l) => (l.id !== r.id ? l : r.choice === "project" ? { ...l, file: fl.file } : { ...l, start: fl.start, end: fl.end, direction: fl.direction as LoopDirection, count: fl.count, file: fl.file }));
      }
    }
  }
  loops.sort((a, b) => a.start - b.start);
  // Overlaps a "Use file" made are refused rather than silently dropped.
  if (loops.some((l, i) => i > 0 && l.start < loops[i - 1].end)) return no("the file's loops would overlap the project's; keep the project's loop or remove one first");
  return ok({ ...e, markers: markers.sort((a, b) => a.at - b.at), loops }, `Merge changes from ${name}`);
}

/** "2 cue changes and the loop end moved." */
export function summarizeMerge(rows: readonly MergeRow[]): string {
  const markers = rows.filter((r) => r.kind === "marker").length;
  const loops = rows.filter((r) => r.kind === "loop");
  const parts: string[] = [];
  if (markers) parts.push(`${markers} cue change${markers === 1 ? "" : "s"}`);
  if (loops.length === 1) parts.push((loops[0].title.charAt(0).toLowerCase() + loops[0].title.slice(1)).replace(/^loop/, "the loop"));
  else if (loops.length > 1) parts.push(`${loops.length} loop changes`);
  return parts.length ? `${parts.join(" and ")}.` : "";
}

