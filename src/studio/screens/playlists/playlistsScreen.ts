// The Playlists screen's state and actions over the real page (ADR 0343, 0341, 0349): which playlist is open (its path,
// mirrored in the route: the file as `asset`, the embedded entry's indices as `select`), the selected entry, the test
// parameter values, the audition and its voice log. Edits go to the open file's asset document as one labelled undo
// step each (`applyEdit`; drags coalesce); refusals go to the status bar. File actions (new, rename, duplicate, move,
// delete, make shared) go through the engine's asset operations, so references follow. The panels read the signals and
// call these; the rules are the pure models beside this file.
import { computed, effect, signal } from "@preact/signals";
import { currentAudioProject } from "../../../editor/audioProjectFile";
import { openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import { deleteAssets } from "../../../editor/assetDelete";
import { createAsset } from "../../../editor/assetKindHost";
import { duplicateAssets, moveAssets, moveAssetsTo, newFolder, renameAsset } from "../../../editor/assetOps";
import { currentProject, docVersion, status } from "../../../editor/state";
import { parseImportSettings, sidecarPath } from "../../../engine/scene/importSettings";
import { parseDerivedSample } from "../../../engine/audio/sample/format";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { emptyPlaylist, emptyPlaylistBody, isPlaylistPath } from "../../../engine/audio/playlist/format";
import { lintPlaylist, type PlaylistLint } from "../../../engine/audio/playlist/lint";
import { PLAYLIST_FORMAT, type PlaylistAsset, type PlaylistBody, type SampleEntry } from "../../../engine/audio/playlist/types";
import { applyEdit, type EditResult } from "../../../plugins/audio/editor/editResult";
import type { AudioEventHandle, AudioHandle } from "../../../plugins/audio/runtime";
import { audioHost, openRoute, toasts } from "../../shell/studioServices";
import { linkEntry, unlinkEntry, type EditContext } from "./playlistEdits";
import { bodyAt, canonical, editAt, entryName, filePath, indicesToSelect, pathTarget, playlistTitle, whereOf, type PlaylistPath } from "./playlistPaths";
import { linkedByIndex } from "./playlistTree";
import { clipsPlaylist } from "./clipsPlaylist";
import { childrenToKeep, deleteEntry, moveAcrossFiles, moveWithinFile, insertEntries, planDelete, replaceLinks, takeEntry, type ChildrenChoice, type DeletePlan, type DeleteTarget, type LinksChoice } from "./structureEdits";
import type { DropPlan } from "./treeDrop";
import { updateLog, voicesNow, type DebugSnapshot, type LogRow } from "./voiceLog";

// --- state -----------------------------------------------------------------------------------------------------------

/** The open playlist's path (null: none open). */
export const openPath = signal<PlaylistPath | null>(null);
/** The selected entry of the open playlist. */
export const selectedEntry = signal<number | null>(null);
/** Test values of game parameters by name (labelled ones as the label's index); never saved. */
export const testValues = signal<Readonly<Record<string, number>>>({});
/** The audition's voice log, the voices playing now, and the scrub cursor over the log. */
export const voiceLog = signal<readonly LogRow[]>([]);
export const playingNow = signal<ReturnType<typeof voicesNow>>([]);
export const logCursor = signal<number | null>(null);
/** The audio clock at the last poll (the log's "now"). */
export const audioNow = signal(0);
/** The delete confirmation's plan (null: closed). */
export const deleting = signal<DeletePlan | null>(null);
/** The Add dialog is open. */
export const adding = signal(false);

const project = () => currentProject.value;

/** A playlist file's current value (an open document's, edits included), or null when it isn't a readable playlist. Tracks. */
export function loadPlaylist(path: string): PlaylistAsset | null {
  const p = project();
  void docVersion.value;
  if (!p || !isPlaylistPath(path) || !p.files.includes(path)) return null;
  try {
    return readAsset<PlaylistAsset>(p, path, "playlist").value;
  } catch {
    return null;
  }
}

/** The document of a playlist file. */
export function docFor(path: string): AssetDocument<PlaylistAsset> | null {
  const p = currentProject.peek();
  return p ? openAssetDocument<PlaylistAsset>(p, path, "playlist") : null;
}

export const target = computed(() => (openPath.value ? pathTarget(openPath.value) : null));
export const openFile = computed(() => (target.value ? loadPlaylist(target.value.file) : null));
export const openBody = computed<PlaylistBody | null>(() => (openFile.value && target.value ? bodyAt(openFile.value, target.value.indices) : null));
export const openDoc = computed(() => (target.value && openFile.value ? docFor(target.value.file) : null));

/** The project's mix (`audio.json`): its buses and global parameters. */
export const mix = computed(() => {
  const p = project();
  void docVersion.value;
  return p ? currentAudioProject(p) : null;
});
export const busNames = computed(() => (mix.value?.buses ?? []).map((b) => b.name));
export const globalParameters = computed<readonly ParameterDef[]>(() => mix.value?.parameters ?? []);
/** The open playlist's local parameters: its file's, then the open body's own (an embedded one may have some). */
export const localParameters = computed<readonly ParameterDef[]>(() => {
  const own = openBody.value?.parameters ?? [];
  const file = openFile.value?.parameters ?? [];
  return [...file, ...own.filter((p) => !file.some((f) => f.name === p.name))];
});
/** Every parameter the open playlist can use: local ones over global ones of the same name. */
export const allParameters = computed<readonly ParameterDef[]>(() => [...localParameters.value, ...globalParameters.value.filter((g) => !localParameters.value.some((l) => l.name === g.name))]);
export const editContext = computed<EditContext>(() => ({ parameters: allParameters.value }));

/** Lints of the open file that sit in the open body. */
export const openLints = computed<readonly PlaylistLint[]>(() => {
  const file = openFile.value;
  const t = target.value;
  if (!file || !t) return [];
  const prefix = whereOf(t.indices);
  const all = lintPlaylist(file, { playlist: (p) => loadPlaylist(p), sampleTempo });
  return all.filter((l) => (prefix ? l.where === prefix || l.where.startsWith(`${prefix}.`) : !l.where.startsWith("entries[") || !l.where.includes(".embedded")));
});

/** A sample's tempo (its sidecar's or derived sample's edits), null when it has none, undefined when unknown. */
function sampleTempo(path: string): { bpm: number } | null | undefined {
  const p = currentProject.peek();
  if (!p) return undefined;
  try {
    if (path.toLowerCase().endsWith(".sample.json")) {
      const raw = p.assets.get(path);
      if (raw === undefined) return undefined;
      const t = parseDerivedSample(raw).sample.sample.tempo;
      return t ? { bpm: t.bpm } : null;
    }
    const side = p.assets.get(sidecarPath(path));
    if (side === undefined) return null;
    const t = parseImportSettings(side).settings.sample?.tempo;
    return t ? { bpm: t.bpm } : null;
  } catch {
    return undefined;
  }
}

// --- opening ---------------------------------------------------------------------------------------------------------

/** Open a playlist at `path` (the route follows, so a reload opens it again). */
export function openPlaylist(path: PlaylistPath): void {
  openPath.value = path;
  selectedEntry.value = null;
  const t = pathTarget(path);
  openRoute({ screen: "playlists", asset: t.file, select: indicesToSelect(t.indices) });
}

/** Follow the route: a file (and indices) it names that differ from the open path open fresh. Returns the stop. */
export function followRoute(route: { readonly value: { asset?: string; select?: string } }): () => void {
  return effect(() => {
    const r = route.value;
    if (!r.asset || !isPlaylistPath(r.asset)) return;
    const indices = (r.select ?? "").split(".").filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
    const t = openPath.peek() ? pathTarget(openPath.peek()!) : null;
    if (t && t.file === r.asset && t.indices.join(".") === indices.join(".")) return;
    openPath.value = [...filePath(r.asset), ...indices.map((entry) => ({ entry }))];
    selectedEntry.value = null;
  });
}

// --- edits -----------------------------------------------------------------------------------------------------------

/** Apply an edit of the open body as one undo step labelled `label` (a drag coalesces until `drag` is false). */
export function editOpen(label: string, edit: (b: PlaylistBody) => EditResult<PlaylistBody>, drag = false): boolean {
  const t = target.peek();
  if (!t) return false;
  return editFile(t.file, label, (root) => editAt(root, t.indices, edit), drag);
}

/** Apply an edit of a whole playlist file as one undo step of its document. */
export function editFile(file: string, label: string, edit: (root: PlaylistAsset) => EditResult<PlaylistAsset>, drag = false): boolean {
  const doc = docFor(file);
  if (!doc) return false;
  const root = doc.value.peek();
  return applyEdit(edit(root), label, (next) => doc.edit(canonical(next), drag ? { label, coalesce: true } : { label }), root);
}

// --- file actions ----------------------------------------------------------------------------------------------------

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** New playlist: inside the open playlist when it holds entries (an embedded Queue), else a file in `folder`. */
export async function newPlaylist(folder: string | null, nested: boolean): Promise<void> {
  const body = openBody.peek();
  if (nested && body && body.type !== "clip" && body.type !== "sequence") {
    const name = target.peek() ? entryNameOfOpen() : "";
    const n = body.entries.length;
    if (editOpen(`New playlist in ${name}`, (b) => insertEntries(b, [], n, [{ kind: "embedded", embedded: emptyPlaylistBody("queue"), volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} }], editContext.peek()))) {
      openPlaylist([...openPath.peek()!, { entry: n }]);
    }
    return;
  }
  const path = await createAsset<PlaylistAsset>("playlist", { folder: folder ?? "", name: "New playlist", value: emptyPlaylist("queue") });
  if (path) openPlaylist(filePath(path));
}

/**
 * "Create playlist from clips": a new playlist file of `samples` (a Clip for one, a Queue for several; `clipsPlaylist`),
 * opened here. A file isn't an undo step of any document, so the toast's Undo deletes it (the editor's delete, which
 * asks first when the user has it ask).
 */
export async function newPlaylistFromSamples(samples: readonly string[]): Promise<string | null> {
  const made = clipsPlaylist(samples);
  if (!made) return null;
  const path = await createAsset<PlaylistAsset>("playlist", { folder: made.folder, name: made.name, value: made.value });
  if (!path) return null;
  openPlaylist(filePath(path));
  const what = samples.length === 1 ? "1 sample" : `${new Set(samples).size} samples`;
  toasts.show({
    text: `Created ${playlistTitle(path)} from ${what}.`,
    undo: () => {
      void deleteAssets([path]).then((gone) => {
        if (gone && openPath.peek()?.some((s) => "file" in s && s.file === path)) openPath.value = null;
      });
    },
  });
  return path;
}

/** New sequence: a Sequence playlist file in `folder` (its timeline is edited from M5). */
export async function newSequence(folder: string | null): Promise<void> {
  const path = await createAsset<PlaylistAsset>("playlist", { folder: folder ?? "", name: "New sequence", value: emptyPlaylist("sequence") });
  if (path) openPlaylist(filePath(path));
}

export const newPlaylistFolder = (parent: string): Promise<string | null> => newFolder(parent);

function entryNameOfOpen(): string {
  const path = openPath.peek();
  if (!path) return "";
  const t = pathTarget(path);
  if (t.indices.length === 0) return playlistTitle(t.file);
  const parent = bodyAt(openFile.peek()!, t.indices.slice(0, -1));
  const i = t.indices[t.indices.length - 1]!;
  const e = parent?.entries[i];
  return e ? entryName(e, i) : "";
}

/** Rename a playlist file (references follow); the open path follows. */
export async function renamePlaylistFile(path: string, name: string): Promise<void> {
  const clean = name.trim().replace(/\.playlist\.json$/i, "");
  if (!clean) return;
  const next = `${folderOf(path) ? `${folderOf(path)}/` : ""}${clean}.playlist.json`;
  if (await renameAsset(path, `${clean}.playlist.json`)) followMove(path, next);
}

export async function renameFolder(path: string, name: string): Promise<void> {
  if (name.trim() && name !== path.slice(path.lastIndexOf("/") + 1)) await renameAsset(path, name.trim());
}

export async function moveToFolder(paths: readonly string[], folder: string): Promise<void> {
  const before = paths.map((p) => [p, `${folder ? `${folder}/` : ""}${p.slice(p.lastIndexOf("/") + 1)}`] as const);
  if (await moveAssetsTo(paths, folder)) for (const [from, to] of before) followMove(from, to);
}

export async function duplicatePlaylistFiles(paths: readonly string[]): Promise<void> {
  const made = await duplicateAssets(paths);
  if (made.length === 1) openPlaylist(filePath(made[0]!));
}

function followMove(from: string, to: string): void {
  const path = openPath.peek();
  if (!path) return;
  if (path.some((s) => "file" in s && s.file === from)) openPlaylist(path.map((s) => ("file" in s && s.file === from ? { file: to } : s)));
}

/** "Make shared": write an embedded entry's playlist to a file of its own beside its parent and link it there. */
export async function makeShared(file: string, parent: readonly number[], index: number): Promise<void> {
  const root = loadPlaylist(file);
  const e = root ? bodyAt(root, parent)?.entries[index] : undefined;
  if (!e || e.kind !== "embedded") return;
  const path = await createAsset<PlaylistAsset>("playlist", { folder: folderOf(file), name: entryName(e, index), value: { format: PLAYLIST_FORMAT, ...structuredClone(e.embedded) } });
  if (!path) return;
  editFile(file, "Make shared", (r) => editAt(r, parent, (b) => linkEntry(b, index, path)));
}

/** "Unlink": a linked entry becomes an embedded copy (later edits to it change only this one). */
export function unlink(file: string, parent: readonly number[], index: number): void {
  const root = loadPlaylist(file);
  const e = root ? bodyAt(root, parent)?.entries[index] : undefined;
  if (!e || e.kind !== "linked") return;
  editFile(file, `Unlink ${playlistTitle(e.playlist)} in ${playlistTitle(file)}`, (r) => editAt(r, parent, (b) => unlinkEntry(b, index, loadPlaylist(e.playlist))));
}

/** Who links each playlist file. */
export const linkedBy = computed(() => {
  const p = project();
  return p ? linkedByIndex(p.files, (f) => loadPlaylist(f)) : new Map<string, string[]>();
});

/** Ask before deleting: with children or links the confirmation offers the prototype's choices. */
export function askDelete(target: DeleteTarget, name: string): void {
  const plan = planDelete(target, name, (p) => loadPlaylist(p), (p) => linkedBy.peek().get(p) ?? []);
  if (!plan) return;
  if (target.kind === "entry") {
    const root = loadPlaylist(target.file);
    const e = root ? bodyAt(root, target.parent)?.entries[target.index] : undefined;
    if (e?.kind === "linked") return removeLinkEntry(target.file, target.parent, target.index);
  }
  deleting.value = plan;
}

/** Remove a linked entry (the linked file stays), with an undo toast. */
export function removeLinkEntry(file: string, parent: readonly number[], index: number): void {
  const root = loadPlaylist(file);
  const e = root ? bodyAt(root, parent)?.entries[index] : undefined;
  if (!e || e.kind !== "linked") return;
  const label = `Remove link to ${playlistTitle(e.playlist)} from ${playlistTitle(file)}`;
  if (editFile(file, label, (r) => editAt(r, parent, (b) => deleteEntry(b, [], index, "all", editContext.peek())))) {
    toasts.show({ text: `${label}.`, undo: () => docFor(file)?.undo() });
  }
}

/** Carry out a confirmed delete with the choices made. */
export async function confirmDelete(plan: DeletePlan, children: ChildrenChoice, links: LinksChoice): Promise<void> {
  deleting.value = null;
  const t = plan.target;
  if (t.kind === "entry") {
    const label = `Delete ${plan.name}`;
    if (editFile(t.file, label, (r) => deleteEntry(r, t.parent, t.index, children, editContext.peek()))) {
      toasts.show({ text: `Deleted ${plan.name}.`, undo: () => docFor(t.file)?.undo() });
      const path = openPath.peek();
      if (path && pathTarget(path).file === t.file && pathTarget(path).indices.length > t.parent.length) openPlaylist(filePath(t.file));
    }
    return;
  }
  const body = loadPlaylist(t.path);
  // Children up: each embedded one becomes a file of its own beside it.
  if (children === "up" && body) {
    for (const c of childrenToKeep(body)) {
      const e = body.entries[c.index]!;
      await createAsset<PlaylistAsset>("playlist", { folder: folderOf(t.path), name: entryName(e, c.index), value: { format: PLAYLIST_FORMAT, ...structuredClone(c.body) } });
    }
  }
  // Links: unlink every copy (each keeps its own playlist) or remove them from every playlist.
  for (const f of plan.linkedBy) {
    editFile(f, links === "unlink" ? `Unlink ${plan.name} in ${playlistTitle(f)}` : `Remove link to ${plan.name} from ${playlistTitle(f)}`, (r) => ({ next: replaceLinks(r, t.path, links, body) }));
  }
  if (await deleteAssets([t.path])) {
    const path = openPath.peek();
    if (path?.some((s) => "file" in s && s.file === t.path)) openPath.value = null;
  }
}

/** Carry out a tree drop's plan (its refusal goes to the status bar). */
export async function runDrop(plan: DropPlan, label: string): Promise<void> {
  const ctx = editContext.peek();
  switch (plan.kind) {
    case "refused":
      status.value = { kind: "info", text: `Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${plan.reason}.` };
      return;
    case "moveFolder":
      await moveAssets([[plan.path, `${plan.to ? `${plan.to}/` : ""}${plan.path.slice(plan.path.lastIndexOf("/") + 1)}`]]);
      return;
    case "moveFile":
      await moveToFolder([plan.path], plan.to);
      return;
    case "link":
      editFile(plan.into.file, label, (r) => insertEntries(r, plan.into.indices, plan.at, [{ kind: "linked", playlist: plan.path, volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} }], ctx));
      return;
    case "moveEntry":
      if (plan.from.file === plan.into.file) {
        editFile(plan.from.file, label, (r) => moveWithinFile(r, plan.from.indices, plan.index, plan.into.indices, plan.at, ctx));
        return;
      }
      {
        const source = docFor(plan.from.file)?.value.peek();
        const targetRoot = docFor(plan.into.file)?.value.peek();
        if (!source || !targetRoot) return;
        const r = moveAcrossFiles(source, plan.from, plan.index, targetRoot, plan.into, plan.at, ctx);
        if ("refused" in r) return void applyEdit(r, label, () => {});
        editFile(plan.into.file, label, () => ({ next: r.next.target }));
        editFile(plan.from.file, label, () => ({ next: r.next.source }));
      }
      return;
    case "extract": {
      const source = loadPlaylist(plan.from.file);
      const taken = source ? takeEntry(source, plan.from.indices, plan.index) : null;
      if (!taken || "refused" in taken) return;
      const e = taken.next.entry;
      if (e.kind === "embedded") {
        const path = await createAsset<PlaylistAsset>("playlist", { folder: plan.folder, name: entryName(e, plan.index), value: { format: PLAYLIST_FORMAT, ...structuredClone(e.embedded) } });
        if (!path) return;
      }
      editFile(plan.from.file, label, () => ({ next: taken.next.root }));
      return;
    }
  }
}

// --- audition --------------------------------------------------------------------------------------------------------

type Playing = AudioEventHandle | AudioHandle;
const handles = new Set<Playing>();
let poller: ReturnType<typeof setInterval> | null = null;
let idlePolls = 0;
/** The file the log follows. */
let logAsset: string | null = null;

/** Something the audition started still plays. */
export const auditioning = signal(false);

/** What Trigger plays for the open playlist: the file (an embedded Clip plays its sample directly). */
export function auditionTarget(): { kind: "file"; path: string } | { kind: "sample"; path: string } | null {
  const t = target.peek();
  const b = openBody.peek();
  if (!t || !b) return null;
  if (t.indices.length && b.type === "clip") {
    const s = b.entries[0];
    return s?.kind === "sample" ? { kind: "sample", path: s.sample } : null; // a generator Clip auditions in the Generator editor (ADR 0360)
  }
  return { kind: "file", path: t.file };
}

/** Labelled test values as labels (the runtime takes labels by name). */
function parameterOptions(defs: readonly ParameterDef[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const d of defs) {
    const v = testValues.peek()[d.name];
    if (v === undefined) continue;
    out[d.name] = "labels" in d ? (d.labels[Math.round(v)] ?? d.default) : v;
  }
  return out;
}

/** Trigger the open playlist (Space). */
export function trigger(): void {
  const what = auditionTarget();
  const host = audioHost();
  if (!what) return;
  // Global test values go to the runtime first, so the trigger picks with them.
  for (const [name, value] of Object.entries(parameterOptions(globalParameters.peek()))) host.audio.setParameter(name, value);
  const h = what.kind === "file" ? host.audition(what.path, { parameters: parameterOptions(localParameters.peek()) }) : host.playClip(what.path);
  if (!h) {
    status.value = { kind: "info", text: host.state.peek().kind === "failed" ? "The audio core isn't running, so nothing plays." : `Nothing played: ${what.path} was refused (Plays now says why).` };
  } else handles.add(h);
  if (logAsset !== (what.kind === "file" ? what.path : null)) {
    logAsset = what.kind === "file" ? what.path : null;
    voiceLog.value = [];
    logCursor.value = null;
  }
  startPolling();
}

/** Stop every voice the audition started (a 120 ms fade). */
export function stopAudition(): void {
  for (const h of handles) h.stop(0.12);
  handles.clear();
  audioHost().stopAll(0.12);
}

/** Key-off: held loops end by their exit settings, a Blend's envelope releases. */
export function releaseAudition(): void {
  for (const h of handles) if ("release" in h) h.release();
}

/** A test value changed: globals go to the runtime, locals to the playing instances. */
export function setTestValue(name: string, value: number | null): void {
  const next = { ...testValues.peek() };
  if (value === null) delete next[name];
  else next[name] = value;
  testValues.value = next;
  const def = allParameters.peek().find((d) => d.name === name);
  if (!def) return;
  const v = value === null ? def.default : "labels" in def ? (def.labels[Math.round(value)] ?? def.default) : value;
  if (localParameters.peek().some((l) => l.name === name)) {
    for (const h of handles) if ("setParameter" in h) h.setParameter(name, v);
  } else audioHost().audio.setParameter(name, v);
}

function startPolling(): void {
  idlePolls = 0;
  auditioning.value = true;
  if (poller) return;
  poller = setInterval(poll, 100);
  poll();
}

function poll(): void {
  for (const h of handles) if (!h.playing) handles.delete(h);
  let snap: DebugSnapshot | null = null;
  try {
    snap = audioHost().audio.debug() as unknown as DebugSnapshot;
  } catch {
    snap = null;
  }
  if (snap && logAsset) {
    voiceLog.value = updateLog(voiceLog.peek(), snap, logAsset);
    playingNow.value = voicesNow(snap, logAsset);
    audioNow.value = snap.time;
  }
  const busy = handles.size > 0 || playingNow.peek().length > 0;
  auditioning.value = busy;
  if (busy) idlePolls = 0;
  else if (++idlePolls > 10 && poller) {
    clearInterval(poller);
    poller = null;
  }
}

/** Clear the voice log. */
export function clearLog(): void {
  voiceLog.value = [];
  logCursor.value = null;
}
