// Re-import and source versions on the Samples screen (ADR 0328 "Source versions"). Re-import copies a new file over
// the sample's audio file and keeps every version's audio in `.myco/sample-versions/<path>/v<n>.<ext>` (the list in
// `versions.json`, `sourceVersions.ts`); the edits are carried onto the new length (`remap.ts`: keep seconds, or scale
// to the new length) as one undo step ("Re-import · v2") that records the version in `sample.sourceVersion`; the WAV's
// own changed cues and loops then open the merge review (`sampleFile.ts` `mergeRows`), and edits past a shorter file
// are flagged by the timeline's warnings, never dropped.
//
// The undo tree is the authority (ground rules): `syncSourceVersion` keeps the audio file on the version the edits
// name, so undoing a re-import puts the old audio back and redoing it brings the new one again. Restoring an older
// version is a re-import of it. Versions move with their sample (`moveSourceVersions`).
import { effect } from "@preact/signals";
import { remapToNewSource, type RemapMode } from "../../../engine/audio/sample/remap";
import { parseSourceVersions, SOURCE_VERSIONS_FILE, sourceVersionsFolder, sourceVersionsToJson, versionFor, withVersion, type SourceVersion, type SourceVersions } from "../../../engine/audio/sample/sourceVersions";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { readWavMetadata, type WavMetadata } from "../../../engine/audio/sample/wavChunks";
import { sampleEditsFromWav } from "../../../engine/audio/sample/wavSample";
import { joinPath } from "../../../editor/projectPaths";
import type { EditorProject } from "../../../editor/projects";
import { docVersion } from "../../../editor/state";
import { isWavPath } from "./importPlan";
import { diskChange } from "./sampleDisk";
import { mergeRows, summarizeMerge } from "./sampleFile";
import { nameOf } from "./sampleLibrary";
import { decodeAudio, forgetAudio, isDerived, type SampleSession } from "./sampleSession";
import { openSession } from "./samplesState";
import { backupSource } from "./sampleWrites";

const extOf = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

function folderAccess(project: EditorProject) {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) throw new Error("only a project folder keeps source versions");
  return { fs, abs: (rel: string) => joinPath(root, rel) };
}

/** The sample's version list (empty when it has none, or the project isn't a folder). */
export async function readSourceVersions(project: EditorProject, path: string): Promise<SourceVersions> {
  try {
    const { fs, abs } = folderAccess(project);
    const file = abs(`${sourceVersionsFolder(path)}/${SOURCE_VERSIONS_FILE}`);
    return (await fs.exists(file)) ? parseSourceVersions(JSON.parse(await fs.readText(file))) : parseSourceVersions(null);
  } catch {
    return parseSourceVersions(null);
  }
}

async function writeSourceVersions(project: EditorProject, path: string, s: SourceVersions): Promise<void> {
  const { fs, abs } = folderAccess(project);
  await fs.mkdir(abs(sourceVersionsFolder(path)));
  await fs.writeText(abs(`${sourceVersionsFolder(path)}/${SOURCE_VERSIONS_FILE}`), `${JSON.stringify(sourceVersionsToJson(s), null, 2)}\n`);
}

/** A version's audio (null when the file is gone). */
async function versionBytes(project: EditorProject, path: string, v: SourceVersion): Promise<Uint8Array | null> {
  const { fs, abs } = folderAccess(project);
  return fs.readBinary(abs(`${sourceVersionsFolder(path)}/${v.file}`)).catch(() => null);
}

/** The asset's audio as it is on disk now. */
async function currentBytes(project: EditorProject, path: string): Promise<Uint8Array> {
  const { fs, abs } = folderAccess(project);
  return fs.readBinary(abs(path));
}

/** Keep `bytes` as the next `v<n>` and describe it. */
async function keepVersion(project: EditorProject, path: string, bytes: Uint8Array, kind: SourceVersion["kind"], name: string, length: number | null): Promise<SourceVersion> {
  const rel = await backupSource(project, path, bytes);
  const file = rel.slice(rel.lastIndexOf("/") + 1);
  return { n: Number(/^v(\d+)\./.exec(file)![1]), file, kind, name, at: new Date().toISOString(), length };
}

/** Audio bytes' length in seconds: a WAV's from its header, anything else decoded. */
export async function audioLength(project: EditorProject, bytes: Uint8Array, name: string): Promise<number | null> {
  if (isWavPath(name)) {
    const m = readWavMetadata(bytes);
    if (m.sampleRate && m.frames !== null) return m.frames / m.sampleRate;
  }
  try {
    const pcm = await decodeAudio(project, bytes.slice(), name);
    return pcm.rate > 0 ? Math.floor(pcm.pcm.length / pcm.channels) / pcm.rate : null;
  } catch {
    return null;
  }
}

/** The edits a re-import gives (`remapToNewSource`, the new WAV's tempo and root for those from the file), with the version. */
export function reimportedEdits(e: SampleEdits, oldLength: number, newLength: number, mode: RemapMode, newMeta: WavMetadata | null, version: number) {
  const r = remapToNewSource(e, oldLength, newLength, mode, newMeta ? sampleEditsFromWav(newMeta) : null);
  return { ...r, edits: { ...r.edits, sourceVersion: version } };
}

export type ReimportResult =
  | {
      readonly version: number;
      readonly oldLength: number | null;
      readonly newLength: number | null;
      /** Items past the new end (flagged, not dropped). */
      readonly outside: number;
      /** Changes the new file's own chunks make, for the merge review (none for a file that isn't a WAV). */
      readonly changes: number;
    }
  | { readonly refused: string };

/**
 * Re-import `session`'s audio file from `bytes` (a file named `name`): keep the audio as it is now and the new audio as
 * versions, write the new audio over the asset, carry the edits onto it by `mode` as the step "Re-import · v<n>", and
 * open the merge review for what its own chunks changed. `label` names the step (Restore uses "Restore v<n>").
 */
export async function reimportSample(session: SampleSession, bytes: Uint8Array, name: string, mode: RemapMode, options: { label?: string; restoring?: SourceVersion } = {}): Promise<ReimportResult> {
  if (session.readOnly) return { refused: "the sample is read-only" };
  if (isDerived(session.path)) return { refused: "a derived sample plays another file's audio; re-import that file" };
  const project = session.project, path = session.path;
  if (extOf(name) !== extOf(path)) return { refused: `pick a ${extOf(path)} file: the sample's file keeps its name and format` };
  const was = await currentBytes(project, path);
  const oldLength = await audioLength(project, was, path);
  let versions = await readSourceVersions(project, path);
  const now = versions.versions.find((v) => v.n === versions.current) ?? null;
  // The audio as it is now is kept first: as the original the first time, or when something changed it since.
  if (!versions.versions.some((v) => v.kind === "original")) versions = withVersion(versions, await keepVersion(project, path, was, "original", nameOf(path), oldLength));
  else if (!now || !same(await versionBytes(project, path, now), was)) versions = withVersion(versions, await keepVersion(project, path, was, "reimport", `${nameOf(path)} (as it was)`, oldLength));
  const newLength = await audioLength(project, bytes, name);
  const version = options.restoring ?? (await keepVersion(project, path, bytes, "reimport", name, newLength));
  versions = withVersion(versions, version);
  await writeSourceVersions(project, path, versions);
  await project.writeBinary(path, bytes);
  forgetAudio(project, path);
  docVersion.value++;

  const newMeta = isWavPath(path) ? readWavMetadata(bytes) : null;
  const r = reimportedEdits(session.edits.peek(), oldLength ?? newLength ?? 0, newLength ?? oldLength ?? 0, mode, newMeta, version.n);
  // The original's number is no `sourceVersion` at all (what an untouched sidecar says).
  const edits = version.kind === "original" ? (({ sourceVersion: _, ...rest }) => rest)(r.edits) : r.edits;
  session.commit({ next: edits, label: options.label ?? `Re-import · v${version.n}` });
  const rows = newMeta ? mergeRows(session.edits.peek(), newMeta) : [];
  diskChange.value = rows.length ? { path, summary: summarizeMerge(rows), rows } : null;
  return { version: version.n, oldLength, newLength, outside: r.outside.markers.length + r.outside.loops.length + (r.outside.trim ? 1 : 0), changes: rows.length };
}

/** Restore an older version: a re-import of its audio (its own step), keeping the version list. */
export async function restoreSourceVersion(session: SampleSession, n: number, mode: RemapMode): Promise<ReimportResult> {
  const versions = await readSourceVersions(session.project, session.path);
  const v = versions.versions.find((x) => x.n === n);
  if (!v) return { refused: `this machine has no v${n} of the sample` };
  const bytes = await versionBytes(session.project, session.path, v);
  if (!bytes) return { refused: `v${n}'s audio is missing from .myco/sample-versions/` };
  return reimportSample(session, bytes, session.path, mode, { label: `Restore v${n}`, restoring: v });
}

/**
 * Put the audio file on the version `edits` name (after an undo or redo of a re-import). Resolves to the version put
 * back, or null when nothing changed (it already holds it, or this machine doesn't have that version).
 */
export async function syncSourceVersion(project: EditorProject, path: string, edits: Pick<SampleEdits, "sourceVersion">): Promise<number | null> {
  if (isDerived(path)) return null;
  let versions = await readSourceVersions(project, path);
  const target = versionFor(versions, edits.sourceVersion);
  if (!target || target.n === versions.current) return null;
  const bytes = await versionBytes(project, path, target);
  if (!bytes) return null;
  const was = await currentBytes(project, path).catch(() => null);
  const now = versions.versions.find((v) => v.n === versions.current);
  // Audio that changed since its version was kept (an outside edit, Write to file) is kept before it is replaced.
  if (was && (!now || !same(await versionBytes(project, path, now), was))) versions = withVersion(versions, await keepVersion(project, path, was, "reimport", `${nameOf(path)} (as it was)`, null), false);
  await writeSourceVersions(project, path, { ...versions, current: target.n });
  await project.writeBinary(path, bytes);
  forgetAudio(project, path);
  docVersion.value++;
  return target.n;
}

/** Move the versions of moved samples and folders with them (`moves`: project paths, from → to). */
export async function moveSourceVersions(project: EditorProject, moves: readonly (readonly [string, string])[]): Promise<void> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return;
  for (const [from, to] of moves) {
    const a = joinPath(root, sourceVersionsFolder(from)), b = joinPath(root, sourceVersionsFolder(to));
    try {
      if (!(await fs.exists(a)) || (await fs.exists(b))) continue;
      await fs.mkdir(joinPath(root, sourceVersionsFolder(to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "")));
      await fs.rename(a, b);
    } catch {
      // Versions are a per-machine convenience; a failed move leaves them where they were.
    }
  }
}

let installed = false;
/** Keep the open sample's audio on the version its edits name (installed with the screen, once). */
export function installVersionSync(): void {
  if (installed) return;
  installed = true;
  let queue: Promise<unknown> = Promise.resolve();
  let last: { session: SampleSession; version: number | undefined } | null = null;
  effect(() => {
    const session = openSession.value;
    if (!session || isDerived(session.path)) return;
    const version = session.edits.value.sourceVersion;
    // Every edit reruns this; only a new sample or a new version needs a look at the disk.
    if (last && last.session === session && last.version === version) return;
    last = { session, version };
    const { project, path } = session;
    queue = queue.then(() => syncSourceVersion(project, path, { sourceVersion: version })).catch(() => undefined);
  });
}
