// Sample projects (ADR 0031): served beside the editor at samples/ (the dev server, or the copy in
// the editor build), never compiled into it. `samples/index.json` lists them; opening one fetches
// its files into a read-only project, whose scripts load like any project's (ADR 0030). The
// desktop editor can also copy a sample into a folder to edit it.
import type { FileSystem } from "../engine/platform/FileSystem";
import { isTextAsset, joinPath, readOnlyProject, type EditorProject } from "./projects";
import { isScriptPath } from "./scriptLoader";

/** A sample as `samples/index.json` lists it (see `sampleManifest` in vite.shared.ts). */
export interface SampleInfo {
  id: string;
  name: string;
  description?: string;
  files: { path: string; size: number }[];
}

/** Where a sample's file is served, relative to the editor page. */
const urlOf = (id: string, path: string) => new URL(`samples/${id}/${path.split("/").map(encodeURIComponent).join("/")}`, document.baseURI).href;

const isText = (path: string) => isTextAsset(path) || path.endsWith(".ts");

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}`);
  return res;
}

/** The samples served beside the editor; none if there's no list (it failed to load, or none ship). */
export async function listSamples(): Promise<SampleInfo[]> {
  try {
    const res = await fetch(new URL("samples/index.json", document.baseURI).href);
    if (!res.ok) return [];
    return ((await res.json()) as { samples: SampleInfo[] }).samples;
  } catch {
    return [];
  }
}

/** A sample by id, or an error naming the ones there are. */
export async function findSample(id: string): Promise<SampleInfo> {
  const all = await listSamples();
  const sample = all.find((s) => s.id === id);
  if (!sample) throw new Error(`There's no sample "${id}"${all.length > 0 ? ` (samples: ${all.map((s) => s.id).join(", ")})` : ""}.`);
  return sample;
}

/** Open a sample as a read-only project: its text files are fetched, images and audio load from their URLs. */
export async function openSampleProject(sample: SampleInfo): Promise<EditorProject> {
  const values = new Map<string, unknown>();
  const texts = new Map<string, string>();
  const scripts = new Map<string, string>();
  const sizes = new Map<string, number>();
  await Promise.all(
    sample.files.map(async ({ path, size }) => {
      sizes.set(path, size);
      if (!isText(path)) return values.set(path, urlOf(sample.id, path));
      const text = await (await fetchOk(urlOf(sample.id, path))).text();
      if (path.endsWith(".ts")) {
        if (isScriptPath(path)) scripts.set(path, text);
        return;
      }
      texts.set(path, text);
      values.set(path, path.endsWith(".json") ? JSON.parse(text) : text);
    }),
  );
  return readOnlyProject(`${sample.name} (sample, read-only)`, { values, texts, scripts, sizes });
}

/** Write a sample's files into the folder `root` (which shouldn't hold a project yet). */
export async function copySample(sample: SampleInfo, fs: FileSystem, root: string): Promise<void> {
  if (await fs.exists(joinPath(root, "project.json"))) throw new Error(`"${root}" already holds a project; choose an empty folder.`);
  const folders = new Set(sample.files.map((f) => f.path.split("/").slice(0, -1).join("/")).filter(Boolean));
  for (const folder of [...folders].sort()) await fs.mkdir(joinPath(root, folder));
  for (const { path } of sample.files) {
    const res = await fetchOk(urlOf(sample.id, path));
    if (isText(path)) await fs.writeText(joinPath(root, path), await res.text());
    else await fs.writeBinary(joinPath(root, path), new Uint8Array(await res.arrayBuffer()));
  }
}
