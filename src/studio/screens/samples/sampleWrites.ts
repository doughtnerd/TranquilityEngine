// What the Samples screen writes besides the sidecar (ADR 0328): "Write to file…" (the WAV's chunks, a backup of the
// file first in `.myco/sample-versions/<path>/v<n>.<ext>`, then every `file` snapshot refreshed as one step), and
// derived samples (`*.sample.json`: forks that follow or pin, duplicates, snippets).
import { defaultSampleEdits, derivedSampleToJson, forkSample, parseSampleEdits, sampleEditsToJson } from "../../../engine/audio/sample/format";
import { SAMPLE_FORMAT, type DerivedSampleAsset, type SampleEdits } from "../../../engine/audio/sample/types";
import { readWavMetadata, writeWavMetadata } from "../../../engine/audio/sample/wavChunks";
import { refreshFileSnapshots, wavEditFromSample } from "../../../engine/audio/sample/wavSample";
import { joinPath } from "../../../editor/projectPaths";
import type { EditorProject } from "../../../editor/projects";
import { docVersion } from "../../../editor/state";
import { folderOf, nameOf } from "./sampleLibrary";
import { bytesOf, forgetAudio, type SampleSession } from "./sampleSession";

/** Where a file's source versions are kept, per machine (ADR 0328). */
export const versionsFolder = (path: string): string => `.myco/sample-versions/${path}`;

/** Keep a copy of `path`'s current bytes as the next `v<n>`; returns its project-relative path. */
export async function backupSource(project: EditorProject, path: string, bytes: Uint8Array): Promise<string> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) throw new Error("only a project folder keeps source versions");
  const dir = versionsFolder(path);
  const abs = joinPath(root, dir);
  await fs.mkdir(abs);
  let n = 1;
  try {
    const names = (await fs.list(abs)).map((e) => e.name);
    for (const name of names) {
      const m = /^v(\d+)\./.exec(name);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  } catch {
    n = 1;
  }
  const ext = path.slice(path.lastIndexOf("."));
  const rel = `${dir}/v${n}${ext}`;
  await fs.writeBinary(joinPath(root, rel), bytes);
  return rel;
}

/** "Write to file…": write the sample's notes, loops, root and tempo into its WAV (backup first), then refresh the snapshots. */
export async function writeToFile(session: SampleSession): Promise<{ backup: string; cues: number; regions: number; loops: number }> {
  const project = session.project;
  const source = session.source.peek();
  const bytes = await bytesOf(project, source);
  const meta = readWavMetadata(bytes);
  if (!meta.sampleRate) throw new Error(`${nameOf(source)} isn't a WAV file the Studio can write`);
  const backup = await backupSource(project, source, bytes);
  const edits = session.edits.peek();
  const out = writeWavMetadata(bytes, wavEditFromSample(edits, meta.sampleRate, meta.frames ?? undefined));
  await project.writeBinary(source, out);
  forgetAudio(project, source);
  const written = readWavMetadata(out);
  session.commit({ next: refreshFileSnapshots(edits, written), label: "Write to file" });
  docVersion.value++;
  return { backup, cues: written.cues.length, regions: written.regions.length, loops: written.loops.length };
}

/** A free `*.sample.json` path in `folder` from a base name ("brake_skid_fork", then "brake_skid_fork 2"…). */
export function freeSamplePath(project: EditorProject, folder: string, base: string): string {
  const taken = (p: string) => project.files.includes(p) || project.folders.includes(p);
  const at = (n: number) => `${folder ? `${folder}/` : ""}${base}${n > 1 ? ` ${n}` : ""}.sample.json`;
  for (let n = 1; ; n++) if (!taken(at(n))) return at(n);
}

/** A sample's base name without its extension ("brake_skid" for `brake_skid.wav` and `brake_skid.sample.json`). */
export const stemOf = (path: string): string => nameOf(path).replace(/\.sample\.json$/i, "").replace(/\.[^.]+$/, "");

export type DeriveKind = "fork" | "duplicate" | "snippet";

/** The derived sample `kind` makes from `parent` (playing `source`) with its current edits. */
export function deriveSample(kind: DeriveKind, parent: string, source: string, edits: SampleEdits, options: { mode?: "follow" | "pin"; range?: [number, number] } = {}): DerivedSampleAsset {
  if (kind === "fork") return forkSample(parent, source, edits, options.mode ?? "follow");
  const copy = parseSampleEdits(sampleEditsToJson(edits), "copy", []);
  if (kind === "duplicate") return { format: SAMPLE_FORMAT, source, range: null, lineage: { kind: "duplicate", parent, mode: "pin" }, sample: copy };
  const range = options.range ?? [0, 0];
  return { format: SAMPLE_FORMAT, source, range, lineage: { kind: "snippet", parent, mode: "pin" }, sample: defaultSampleEdits("oneshot") };
}

/** Write a derived sample at `path`. */
export async function writeDerived(project: EditorProject, path: string, sample: DerivedSampleAsset): Promise<void> {
  if (folderOf(path) && !project.folders.includes(folderOf(path))) await project.createFolder(folderOf(path));
  await project.writeFile(path, `${JSON.stringify(derivedSampleToJson(sample), null, 2)}\n`);
  docVersion.value++;
}
