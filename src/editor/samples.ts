// Sample projects (ADR 0031): served beside the editor at samples/ (the dev server, or the copy in
// the editor build), never compiled into it. `samples/index.json` lists them; opening one fetches
// its files into a read-only project, whose scripts load like any project's (ADR 0030). The
// desktop editor can also copy a sample into a folder to edit it.
import type { FileSystem } from "../engine/platform/FileSystem";
import { isProjectFile, loadProjectFiles } from "../engine/scene/projectFiles";
import { isScriptPath, isTextAsset, joinPath } from "./projectPaths";
import type { EditorProject } from "./projects";

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
  const sizes = new Map(sample.files.map((f) => [f.path, f.size]));
  const readText = async (path: string) => (await fetchOk(urlOf(sample.id, path))).text();
  const scripts = new Map<string, string>();
  const [{ values, texts, problems }] = await Promise.all([
    loadProjectFiles(sample.files.map((f) => f.path).filter(isProjectFile), { readText, url: (path) => urlOf(sample.id, path) }),
    ...sample.files.filter((f) => isScriptPath(f.path)).map(async ({ path }) => scripts.set(path, await readText(path))),
  ]);
  if (problems.length > 0) throw new Error(`Some JSON files in the sample "${sample.id}" don't parse: ${problems.map((p) => `${p.path} (${p.message})`).join(", ")}`);
  const { readOnlyProject } = await import("./projects"); // the engine, which the Projects window (ADR 0059) doesn't load
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
