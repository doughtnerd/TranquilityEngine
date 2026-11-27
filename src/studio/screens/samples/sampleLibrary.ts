// The Samples panel's model (ADR 0342 "Samples are assets"): the project's audio files and derived samples
// (`*.sample.json`) by folder, the search's flat list with paths, the meta line and the file chip of a row, and the
// playlists that use a sample ("Used by", the Delete prompt). Pure: the view
// passes the project's paths and parsed files.
import { isDerivedSamplePath } from "../../../engine/audio/sample/format";
import type { DerivedSampleAsset, SampleEdits, SampleKind } from "../../../engine/audio/sample/types";
import { parsePlaylist } from "../../../engine/audio/playlist/format";
import { referencedPaths } from "../../../engine/audio/playlist/references";
import { isSidecarPath } from "../../../engine/scene/importSettings";
import { contentFolders } from "../../components/projectFolders";
import { isAudioPath } from "./importPlan";

/** True for a flattened render (`<stem>.flat<n>.wav`, ADR 0342 Flatten): a source version of its sample, not a sample. */
export const isFlatRender = (path: string): boolean => /\.flat\d+\.wav$/i.test(path);

/**
 * True for a file the Samples panel lists: an audio file or a derived sample. A flattened render isn't one: the version
 * menu lists it under its sample (E-06).
 */
export const isSamplePath = (p: string): boolean => !isSidecarPath(p.toLowerCase()) && !isFlatRender(p) && (isAudioPath(p) || isDerivedSamplePath(p));

/**
 * The folders the Samples tree and its folder pickers (Move to…, Import's Into folder, Fork's and Save snippet's
 * Folder) offer: the project's folders without the game's own content folders (scenes, scripts, plugins) and hidden
 * ones, unless a sample is in them (UI pass T5, `contentFolders`).
 */
export const audioFolders = (folders: readonly string[], files: readonly string[]): string[] => contentFolders(folders, files, isSamplePath);

export const folderOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const nameOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
/** A sample as the tree names it: its file name, a derived sample's without `.sample.json` ("brake_skid_fork"). */
export const sampleName = (p: string): string => nameOf(p).replace(/\.sample\.json$/i, "");
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

export interface LibraryFolder {
  readonly path: string;
  readonly name: string;
  readonly folders: LibraryFolder[];
  readonly samples: string[];
}

/**
 * The tree: folders holding a sample somewhere inside, and empty folders (a folder just made, before anything moves
 * in), sorted by name; samples sorted naturally.
 */
export function libraryTree(files: readonly string[], folders: readonly string[]): LibraryFolder {
  const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  // By name without the extension, so a fork ("door_fork") sorts after what it came from ("door.wav").
  const stem = (p: string) => (isDerivedSamplePath(p) ? sampleName(p) : nameOf(p).replace(/\.[^.]+$/, ""));
  const samples = files.filter(isSamplePath);
  const nonEmpty = new Set(files.map(folderOf));
  const keep = new Set<string>();
  for (const s of samples) for (let f = folderOf(s); f !== ""; f = folderOf(f)) keep.add(f);
  for (const f of folders) {
    if (!nonEmpty.has(f) && !folders.some((g) => g !== f && folderOf(g) === f) && !f.startsWith(".") && !f.includes("/.")) {
      for (let g = f; g !== ""; g = folderOf(g)) keep.add(g);
    }
  }
  const make = (path: string): LibraryFolder => ({
    path,
    name: path === "" ? "" : nameOf(path),
    folders: [...keep].filter((f) => folderOf(f) === path).sort(natural.compare).map(make),
    samples: samples.filter((s) => folderOf(s) === path).sort((a, b) => natural.compare(stem(a), stem(b)) || natural.compare(nameOf(a), nameOf(b))),
  });
  return make("");
}

/** Every sample in the tree, depth first (the tree's keyboard order and the "Search N samples" count). */
export const allSamples = (root: LibraryFolder): string[] => [...root.samples, ...root.folders.flatMap(allSamples)];

/** Search: samples whose name holds `query` (case-insensitive), as a flat list with their folders. */
export function searchSamples(files: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return files.filter((f) => isSamplePath(f) && nameOf(f).toLowerCase().includes(q)).sort();
}

const KIND_NAMES: Readonly<Record<SampleKind, string>> = { oneshot: "One-shot", loop: "Loop", sustain: "Loop · while held", music: "Music" };

/** Seconds as a short length: "340 ms", "2.6 s", "1:12". */
export function shortLength(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds - m * 60)).padStart(2, "0")}`;
}

/** A row's meta line: "One-shot · 0.34 s", "Music · 12 bars", "Snippet · 0.8 s", "Fork of brake_skid.wav". */
export function metaLine(path: string, edits: SampleEdits | null, length: number | null, derived?: DerivedSampleAsset | null): string {
  if (derived) {
    const { lineage, range } = derived;
    if (lineage.kind === "snippet" && range) return `Snippet · ${shortLength(range[1] - range[0])}`;
    return `${lineage.kind === "fork" ? `Fork (${lineage.mode === "follow" ? "follows" : "pinned"})` : "Duplicate"} of ${nameOf(lineage.parent)}`;
  }
  const kind = edits?.kind ?? "oneshot";
  const parts = [KIND_NAMES[kind]];
  if (length !== null) {
    if (kind === "music" && edits?.tempo) {
      const beats = Number(edits.tempo.meter.split("/")[0]) || 4;
      parts.push(`${Math.round((length * edits.tempo.bpm) / 60 / beats)} bars`);
    } else parts.push(shortLength(length));
  }
  return parts.join(" · ");
}

/** The file chip of a row: what the WAV gave ("2 cues · 1 loop · tempo"), or null when nothing came from it. */
export function fileChip(edits: SampleEdits | null): string | null {
  if (!edits) return null;
  const cues = edits.markers.filter((m) => m.file?.chunk === "cue").length;
  const regions = edits.markers.filter((m) => m.file?.chunk === "ltxt").length;
  const loops = edits.loops.filter((l) => l.file).length;
  const parts: string[] = [];
  if (cues) parts.push(`${cues} cue${cues === 1 ? "" : "s"}`);
  if (regions) parts.push(`${regions} region${regions === 1 ? "" : "s"}`);
  if (loops) parts.push(`${loops} loop${loops === 1 ? "" : "s"}`);
  if (edits.tempo?.source === "file") parts.push("tempo");
  if (edits.root?.source === "file") parts.push("root");
  return parts.length ? parts.join(" · ") : null;
}

export interface Use {
  /** The playlist's path. */
  readonly path: string;
  /** How many times it names the sample. */
  readonly count: number;
}

/** The playlists naming `sample` (directly, as a Clip entry or a sequence clip), and the derived samples made from it. */
export function usesOf(sample: string, files: readonly string[], read: (path: string) => unknown): Use[] {
  const out: Use[] = [];
  for (const f of files) {
    if (f.toLowerCase().endsWith(".playlist.json")) {
      const { playlist } = parsePlaylist(read(f), f);
      const n = referencedPaths(playlist, "sample").filter((p) => p === sample).length;
      if (n) out.push({ path: f, count: n });
    } else if (isDerivedSamplePath(f) && f !== sample) {
      const raw = read(f) as { source?: unknown; lineage?: { parent?: unknown } } | undefined;
      if (raw && (raw.source === sample || raw.lineage?.parent === sample)) out.push({ path: f, count: 1 });
    }
  }
  return out;
}

const folderCrumbs = (path: string) => (path ? path.split("/").join(" › ") : "Top level");

/** A typed folder path cleaned: trimmed parts, no empty ones, "›" read as "/". */
export const cleanPath = (text: string): string => text.replace(/\s*›\s*/g, "/").split("/").map((p) => p.trim()).filter(Boolean).join("/");

/**
 * What the folder combo lists for `query`: with none, Top level ("") and every folder; typing, the folders whose path
 * holds it ("hover", "Vehicles › Hover"), and a new folder to make when none is the typed path.
 */
export function folderChoices(folders: readonly string[], query: string): { folders: string[]; create: string | null } {
  const q = query.trim().toLowerCase();
  if (!q) return { folders: ["", ...[...folders].sort()], create: null };
  const typed = cleanPath(query);
  const hits = [...folders].sort().filter((f) => f.toLowerCase().includes(q) || folderCrumbs(f).toLowerCase().includes(q));
  return { folders: hits, create: typed && !folders.some((f) => f.toLowerCase() === typed.toLowerCase()) ? typed : null };
}
