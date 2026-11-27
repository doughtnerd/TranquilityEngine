// The Playlists screen's state and actions over the real page (ADR 0343, 0341, 0349): which playlist is open (its path,
// mirrored in the route: the file as `asset`, the embedded entry's indices as `select`), the selected entry, the test
// parameter values, the audition and its voice log. Edits go to the open file's asset document as one labelled undo
// step each (`applyEdit`; drags coalesce); refusals go to the status bar. File actions (rename, duplicate, move, new
// folder, delete a folder) are the Studio asset library's (`playlistFiles`, ADR 0433), so references follow; new, make
// shared and deleting a playlist (its links and children) are the screen's own, through the engine's asset operations. The panels read the signals and
// call these; the rules are the pure models beside this file.
import { audioProject } from "../../shell/audioProject";
import { computed, effect, signal } from "@preact/signals";
import { currentAudioProject } from "../../../editor/audioProjectFile";
import { assetDocumentsDeleted, openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import { deleteAssets, whyNotDeletable } from "../../../editor/assetDelete";
import { assetUsers, removeReferences } from "../../../editor/assetReferences";
import { errorStatus } from "../../../editor/messages";
import { createAsset } from "../../../editor/assetKindHost";
import { studioLibrary } from "../../library/studioLibrary";
import { docVersion, status } from "../../../editor/state";
import { parseImportSettings, sidecarPath } from "../../../engine/scene/importSettings";
import { parseDerivedSample } from "../../../engine/audio/sample/format";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { emptyPlaylist, emptyPlaylistBody, isPlaylistPath } from "../../../engine/audio/playlist/format";
import { lintPlaylist, type PlaylistLint } from "../../../engine/audio/playlist/lint";
import { PLAYLIST_FORMAT, type ChangeHow, type PlaylistAsset, type PlaylistBody, type SampleEntry } from "../../../engine/audio/playlist/types";
import { matchChangeRule } from "../../../engine/audio/playlist/switchRules";
import { applyEdit, type EditResult } from "../../../editor/sdk/editResult";
import type { AudioEventHandle } from "../../../plugins/audio/runtime";
import { audioHost, openRoute, toasts } from "../../shell/studioServices";
import { newPlaylistParameter } from "./newParameter";
import { linkEntry, unlinkEntry, type EditContext } from "./playlistEdits";
import { bodyAt, canonical, editAt, effectiveOutput, entryName, filePath, indicesToSelect, pathTarget, playlistTitle, whereOf, type PlaylistPath } from "./playlistPaths";
import { ancestorsOf, auditionAsset, auditionPathOf, serveAudition } from "./auditionSource";
import { linkedByIndex } from "./playlistTree";
import { clipsPlaylist } from "./clipsPlaylist";
import { childrenToKeep, deleteEntry, moveAcrossFiles, moveWithinFile, insertEntries, planDelete, replaceLinks, takeEntry, type ChildrenChoice, type DeletePlan, type DeleteTarget, type LinksChoice } from "./structureEdits";
import type { DropPlan } from "./treeDrop";
import { markTrigger, triggerRows, triggerSpan, updateLog, voicesNow, type DebugSnapshot, type LogRow, type TriggerMark } from "./voiceLog";
import { busPath } from "../mixer/busTree";
import { starterTracks } from "./sequence/sequenceEdits";
import { playback as sequencePlayback, sequenceContext } from "./sequence/sequenceState";

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
/** Where the latest trigger began, so the player bar's strip shows that trigger's voices (null: none yet). */
export const triggerMark = signal<TriggerMark | null>(null);
/** The audio clock at the last poll (the log's "now"). */
export const audioNow = signal(0);
/** The delete confirmation's plan (null: closed). */
export const deleting = signal<DeletePlan | null>(null);
/** The Add dialog is open. */
export const adding = signal(false);
/** The open playlist's name is being edited (a new playlist opens so, W2.5). */
export const renamingOpen = signal(false);
/**
 * The last Switch label change heard while auditioning (W8.5): the playlist, from and to, the rule that applied (its
 * index, -1 for When it changes) and how it changes. Cleared by a new trigger or another playlist.
 */
export const lastChange = signal<{ readonly playlist: string; readonly from: string; readonly to: string; readonly rule: number; readonly change: ChangeHow } | null>(null);
/**
 * Pause (W14.2, ADR 0362 §1): the audition's playbacks pause (`AudioPlaylistHandle.pause`: voices, timers, picks and the
 * sequence clock hold) and Plays now, Voices and the voice log's cursor freeze at that moment; Resume continues the
 * playbacks from where they held and the views follow them live again.
 */
export const frozen = signal<{ readonly log: readonly LogRow[]; readonly now: ReturnType<typeof voicesNow>; readonly time: number } | null>(null);

const project = () => audioProject.value;

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
  const p = audioProject.peek();
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
/** Each bus's routing path ("SFX › Vehicles"), as the Output select names it (J8.2: a flat list of names). */
export const busPaths = computed<ReadonlyMap<string, string>>(() => {
  const m = mix.value;
  return new Map((m?.buses ?? []).map((b) => [b.name, busPath(m!, b.name)]));
});
export const globalParameters = computed<readonly ParameterDef[]>(() => mix.value?.parameters ?? []);
/** The open playlist's local parameters: its file's, then the open body's own (an embedded one may have some). */
export const localParameters = computed<readonly ParameterDef[]>(() => {
  const own = openBody.value?.parameters ?? [];
  const file = openFile.value?.parameters ?? [];
  return [...file, ...own.filter((p) => !file.some((f) => f.name === p.name))];
});
/** Every parameter the open playlist can use: local ones over global ones of the same name. */
export const allParameters = computed<readonly ParameterDef[]>(() => [...localParameters.value, ...globalParameters.value.filter((g) => !localParameters.value.some((l) => l.name === g.name))]);
export const editContext = computed<EditContext>(() => ({ parameters: allParameters.value, newParameter: newPlaylistParameter }));

/** Lints of the open file that sit in the open body. */
export const openLints = computed<readonly PlaylistLint[]>(() => {
  const file = openFile.value;
  const t = target.value;
  if (!file || !t) return [];
  const prefix = whereOf(t.indices);
  const all = lintPlaylist(file, { playlist: (p) => loadPlaylist(p), sampleTempo, globalParameters: () => (mix.value ? mix.value.parameters : undefined) });
  return all.filter((l) => (prefix ? l.where === prefix || l.where.startsWith(`${prefix}.`) : !l.where.startsWith("entries[") || !l.where.includes(".embedded")));
});

/** A sample's tempo (its sidecar's or derived sample's edits), null when it has none, undefined when unknown. */
function sampleTempo(path: string): { bpm: number } | null | undefined {
  const p = audioProject.peek();
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
  renamingOpen.value = false;
  lastChange.value = null;
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
  if (!path) return;
  openPlaylist(filePath(path));
  renamingOpen.value = true; // it opens with its name field in rename mode (W2.5)
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
  const value = emptyPlaylist("sequence");
  const seq = value.sequence!;
  const path = await createAsset<PlaylistAsset>("playlist", { folder: folder ?? "", name: "New sequence", value: { ...value, sequence: { ...seq, tracks: starterTracks(seq) } } });
  if (path) openPlaylist(filePath(path));
}

export const newPlaylistFolder = (parent: string): Promise<string | null> => playlistFiles.newFolder(parent);

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

/**
 * The Playlists tree's file actions: a typed name keeps `.playlist.json`; every file the open path names (the file and
 * the linked playlists it went into) follows a move; one duplicate opens.
 */
export const playlistFiles = studioLibrary({
  noun: "playlist",
  extension: (path) => path.match(/\.playlist\.json$/i)?.[0] ?? "",
  openPaths: () => (openPath.peek() ?? []).flatMap((s) => ("file" in s ? [s.file] : [])),
  open: (path) => openPlaylist(filePath(path)),
  follow: (from, to) => followMove(from, to),
});

/** Rename a playlist file (references follow); the open path follows. */
export async function renamePlaylistFile(path: string, name: string): Promise<void> {
  await playlistFiles.renameFile(path, name);
}

export async function renameFolder(path: string, name: string): Promise<void> {
  await playlistFiles.renameFolder(path, name);
}

export async function moveToFolder(paths: readonly string[], folder: string): Promise<void> {
  await playlistFiles.move(paths, folder);
}

export async function duplicatePlaylistFiles(paths: readonly string[]): Promise<void> {
  await playlistFiles.duplicate(paths);
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
  const p = audioProject.peek();
  const doc = docFor(t.path);
  const body = loadPlaylist(t.path);
  if (!p || !doc || !body) return;
  const refused = whyNotDeletable(p, [t.path]);
  if (refused) {
    status.value = { kind: "info", text: `Can't delete ${plan.name}: ${refused}.` };
    return;
  }
  // What Undo puts back: the file as it is now (edits included) and its sidecar.
  const text = `${JSON.stringify(canonical(doc.value.peek()), null, 2)}\n`;
  const side = p.textOf(sidecarPath(t.path));
  // Children up: each embedded one becomes a file of its own beside it.
  const made: string[] = [];
  if (children === "up") {
    for (const c of childrenToKeep(body)) {
      const e = body.entries[c.index]!;
      const path = await createAsset<PlaylistAsset>("playlist", { folder: folderOf(t.path), name: entryName(e, c.index), value: { format: PLAYLIST_FORMAT, ...structuredClone(c.body) } });
      if (path) made.push(path);
    }
  }
  // Links: unlink every copy (each keeps its own playlist) or remove them from every playlist; each one undo step.
  const relinked = plan.linkedBy.filter((f) =>
    editFile(f, links === "unlink" ? `Unlink ${plan.name} in ${playlistTitle(f)}` : `Remove link to ${plan.name} from ${playlistTitle(f)}`, (r) => ({ next: replaceLinks(r, t.path, links, body) })),
  );
  // Scenes and settings naming it lose the reference (as the engine's delete does); Undo writes them back.
  const users = (await assetUsers(p, t.path)).filter((u) => p.files.includes(u) && !plan.linkedBy.includes(u));
  const before = new Map(users.flatMap((u) => { const s = p.textOf(u); return s === undefined ? [] : [[u, s] as const]; }));
  try {
    await p.deleteFile(t.path);
  } catch (err) {
    status.value = errorStatus(`Couldn't delete ${plan.name}`, err);
    return;
  }
  await assetDocumentsDeleted([t.path]);
  const cleaned = await removeReferences(p, t.path, `Remove references to ${plan.name}`).catch(() => [] as string[]);
  docVersion.value++;
  const path = openPath.peek();
  if (path?.some((s) => "file" in s && s.file === t.path)) openPath.value = null;
  toasts.show({
    text: `Deleted ${plan.name}.`,
    undo: () => void restoreDeleted(t.path, text, side, made, relinked, cleaned.filter((f) => before.has(f)).map((f) => [f, before.get(f)!] as const)),
  });
}

/** Undo a playlist delete: the file and its sidecar back, the children kept as files gone, the links and references back. */
async function restoreDeleted(path: string, text: string, side: string | undefined, made: readonly string[], relinked: readonly string[], cleaned: readonly (readonly [string, string])[]): Promise<void> {
  const p = audioProject.peek();
  if (!p) return;
  try {
    await p.writeFile(path, text);
    if (side !== undefined) await p.writeFile(sidecarPath(path), side);
    for (const [f, s] of cleaned) await p.writeText(f, s);
    for (const f of made) {
      if (!p.files.includes(f)) continue;
      await p.deleteFile(f);
      await assetDocumentsDeleted([f]);
    }
  } catch (err) {
    status.value = errorStatus(`Couldn't bring ${playlistTitle(path)} back`, err);
  }
  for (const f of relinked) docFor(f)?.undo();
  docVersion.value++;
  status.value = { kind: "info", text: `Brought back ${path}.` };
}

// --- folders ---------------------------------------------------------------------------------------------------------

/** The folder delete's confirmation: the folder, how many items move up and where to (null: closed). */
export const deletingFolder = signal<{ readonly path: string; readonly items: number; readonly to: string } | null>(null);

/** Delete folder…: ask first, saying how many items move up and where. */
export function askDeleteFolder(folder: string): void {
  deletingFolder.value = { path: folder, ...playlistFiles.folderDeletePlan(folder) };
}

/**
 * Delete a folder, keeping what's inside: its files and folders move up to its parent (references follow, names taken
 * there get a number), then the empty folder goes; the toast's Undo puts it back (the library's folder delete).
 * Resolves to whether it was deleted.
 */
export function deleteFolderKeepingContents(folder: string): Promise<boolean> {
  deletingFolder.value = null;
  return playlistFiles.deleteFolder(folder);
}

/** Carry out a tree drop's plan (its refusal goes to the status bar). */
export async function runDrop(plan: DropPlan, label: string): Promise<void> {
  const ctx = editContext.peek();
  switch (plan.kind) {
    case "refused":
      status.value = { kind: "info", text: `Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${plan.reason}.` };
      return;
    case "moveFolder":
      await playlistFiles.move([plan.path], plan.to);
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

const handles = new Set<AudioEventHandle>();
let poller: ReturnType<typeof setInterval> | null = null;
let idlePolls = 0;
/** The file the log follows. */
let logAsset: string | null = null;

/** Something the audition started still plays. */
export const auditioning = signal(false);

/** What Trigger plays: a playlist by path (with the value to serve there, for a nested one), or a sample. */
export type AuditionTarget = { readonly kind: "file"; readonly path: string; readonly nested?: PlaylistAsset } | { readonly kind: "sample"; readonly path: string };

/**
 * What Trigger plays for the open playlist (UI pass Q7, PB4): the file, or the open nested playlist itself (served
 * under its audition path, `auditionSource.ts`), an embedded Clip its sample directly. Null when there's nothing to
 * play: a playlist with no entries yet, or a generator Clip (it auditions in the Generator editor, ADR 0360).
 */
export function auditionTarget(): AuditionTarget | null {
  const t = target.peek();
  const b = openBody.peek();
  const path = openPath.peek();
  if (!t || !b || !path) return null;
  if (b.type !== "sequence" && b.entries.length === 0) return null;
  if (t.indices.length && b.type === "clip") {
    const s = b.entries[0];
    return s?.kind === "sample" ? { kind: "sample", path: s.sample } : null;
  }
  if (t.indices.length === 0) return { kind: "file", path: t.file };
  const out = effectiveOutput(path, loadPlaylist);
  const root = openFile.peek();
  return { kind: "file", path: auditionPathOf(t.file, t.indices), nested: auditionAsset(b, out.bus, localParameters.peek(), root ? ancestorsOf(root, t.indices) : []) };
}

/** Why Trigger is off for the open playlist, or null when it plays (the player bar's tooltip). */
export function triggerOffReason(): string | null {
  const b = openBody.peek();
  if (!b || auditionTarget()) return null;
  return b.type === "clip" && b.entries.length ? "This Clip plays a generator: audition it in the Generator editor" : b.type === "clip" ? "Choose a sample for this Clip to trigger it" : "Add entries to this playlist to trigger it";
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
  // Trigger while paused starts fresh: the held voices go, the views come back to life.
  if (frozen.peek()) {
    stopAudition();
    frozen.value = null;
  }
  lastChange.value = null;
  // Global test values go to the runtime first, so the trigger picks with them.
  for (const [name, value] of Object.entries(parameterOptions(globalParameters.peek()))) host.audio.setParameter(name, value);
  if (what.kind === "file" && what.nested) serveAudition(what.path, what.nested);
  // A Clip's sample plays through the playlist runtime too (`Audio.play` takes a sample), so Pause holds it as well.
  const h = what.kind === "file" ? host.audition(what.path, { parameters: parameterOptions(localParameters.peek()) }) : host.audition(what.path);
  if (!h) {
    status.value = { kind: "info", text: host.state.peek().kind === "failed" ? "The audio core isn't running, so nothing plays." : `Nothing played: ${what.path} was refused (Plays now says why).` };
  } else handles.add(h);
  if (logAsset !== (what.kind === "file" ? what.path : null)) {
    logAsset = what.kind === "file" ? what.path : null;
    voiceLog.value = [];
  }
  startTrigger();
}

/** A new trigger: the strip starts over with this trigger's voices and the playhead follows it live from the start. */
function startTrigger(): void {
  const before = voiceLog.peek();
  logCursor.value = null;
  triggerMark.value = markTrigger(before, Number.POSITIVE_INFINITY);
  startPolling();
  triggerMark.value = markTrigger(before, audioNow.peek());
}

/** Stop every voice the audition started (a 120 ms fade). */
export function stopAudition(): void {
  for (const h of handles) h.stop(0.12);
  handles.clear();
  audioHost().stopAll(0.12);
  if (frozen.peek()) {
    frozen.value = null;
    logCursor.value = null;
  }
}

/** Pause (W14.2): pause the audition's playbacks where they are and freeze Plays now, Voices and the log's cursor there. */
export function pauseAudition(): void {
  if (frozen.peek()) return;
  frozen.value = { log: voiceLog.peek(), now: playingNow.peek(), time: audioNow.peek() };
  logCursor.value = audioNow.peek();
  for (const h of handles) h.pause();
}

/** Resume: the playbacks continue from where they held and the views follow them live. */
export function resumeAudition(): void {
  if (!frozen.peek()) return;
  frozen.value = null;
  logCursor.value = null;
  for (const h of handles) h.resume();
}

/** Key-off: held loops end by their exit settings, a Blend's envelope releases; the playhead follows live again. */
export function releaseAudition(): void {
  logCursor.value = null;
  for (const h of handles) h.release();
}

/** A test value changed: globals go to the runtime, locals to the playing instances. */
export function setTestValue(name: string, value: number | null): void {
  noteSwitchChange(name, value);
  const next = { ...testValues.peek() };
  if (value === null) delete next[name];
  else next[name] = value;
  testValues.value = next;
  const def = allParameters.peek().find((d) => d.name === name);
  if (!def) return;
  const v = value === null ? def.default : "labels" in def ? (def.labels[Math.round(value)] ?? def.default) : value;
  if (localParameters.peek().some((l) => l.name === name)) {
    for (const h of handles) h.setParameter(name, v);
  } else audioHost().audio.setParameter(name, v);
}

/** While auditioning a Switch, its parameter's label changing: which rule applies (W8.5), for the rules table and Plays now. */
function noteSwitchChange(name: string, value: number | null): void {
  const b = openBody.peek();
  const s = b?.type === "switch" ? b.switch : null;
  if (!s || s.parameter !== name || !auditioning.peek()) return;
  const def = allParameters.peek().find((d) => d.name === name);
  if (!def || !("labels" in def)) return;
  const label = (v: number | undefined) => (v === undefined ? def.default : (def.labels[Math.round(v)] ?? def.default));
  const from = label(testValues.peek()[name]);
  const to = label(value ?? undefined);
  if (from === to) return;
  const rule = matchChangeRule(s.rules, from, to);
  lastChange.value = { playlist: entryNameOfOpen(), from, to, rule: rule ? s.rules.indexOf(rule) : -1, change: rule ?? s.onChange };
}

function startPolling(): void {
  idlePolls = 0;
  auditioning.value = true;
  poller ??= setInterval(poll, 100);
  poll(); // read at once, also when already polling (a new play's voices show without waiting for the next poll)
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
  // The trigger ended (by itself, Release or Stop): the playhead goes back to its start, ready to scrub or trigger again.
  if (auditioning.peek() && !busy && !frozen.peek()) {
    const span = triggerSpan(triggerRows(voiceLog.peek(), triggerMark.peek()), triggerMark.peek(), audioNow.peek());
    if (span) logCursor.value = span[0];
  }
  auditioning.value = busy;
  if (busy) idlePolls = 0;
  else if (++idlePolls > 10 && poller) {
    clearInterval(poller);
    poller = null;
  }
}

/**
 * Follow `path`'s voices in Plays now and the Voices log, as Trigger does: a sequence's play is started by its own
 * transport (`playSequence`), and its voices are logged too (J6.3: Voices said "Trigger to start capturing" while the
 * sequence played).
 */
export function followVoices(path: string): void {
  if (logAsset !== path) {
    logAsset = path;
    voiceLog.value = [];
  }
  startTrigger();
}
effect(() => {
  if (!sequencePlayback.value) return;
  const file = sequenceContext.peek()?.file;
  if (file) followVoices(file);
});

/** Clear the voice log. */
export function clearLog(): void {
  voiceLog.value = [];
  logCursor.value = null;
  triggerMark.value = null;
}
