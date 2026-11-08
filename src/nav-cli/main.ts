/**
 * `npm run nav:bake`: bake a project's navigation in Node, for builds (ADR 0065).
 *
 * ```sh
 * npm run nav:bake -- <projectDir> [scene…]
 * ```
 *
 * Reads the project folder headlessly (as the dedicated server does), instantiates each scene (every
 * `*.scene.json`, or the ones named) into a World with no renderer where nothing runs, collects each
 * NavChunk's geometry with the editor's own rules (`collectNavGeometry`), bakes it (`bakeChunk`), and
 * writes the bake beside the scene (`scenes/main.nav.bin`) with its record in `.myco/nav/`. A NavChunk
 * whose `bake` field is unset gets it in the scene file. Project scripts aren't loaded: navigation only
 * reads engine components.
 *
 * Exits 0 when every chunk baked, 1 if a scene or chunk couldn't be baked, 2 for bad arguments.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Assets } from "../myco"; // registers every built-in Component, the plugins' too (the bake reads colliders and nav volumes)
import { World } from "../engine/core/World";
import { destroyNow, instantiateDocument } from "../engine/editor";
import { bakeChunk } from "../engine/nav/bake";
import { collectNavGeometry, findNavChunks, loadNavGeometryMeshes, navBakeChunk, navChunkOf, navInputSignature } from "../engine/nav/geometry";
import { parseNavigationSettings } from "../engine/nav/settings";
import type { SceneFile } from "../engine/scene/SceneLoader";
import { assetPathOf, chunkIdOf, navAssetOf, navBakeRecord, navBakeSummary, navRecordPath, withBakeReference } from "../plugins/navigation/editor/navBakeFiles";
import { readProject, ServerError } from "../server/project";

export const USAGE = `Usage: npm run nav:bake -- <projectDir> [scene…]

Bakes the navigation of every NavChunk in the project's scenes (or the scenes named,
project-relative like scenes/main.scene.json) and writes each bake beside its scene.

Options:
  -h, --help       Show this help`;

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): { projectDir: string; scenes: string[] } | "help" {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return "help";
    if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
    positional.push(arg);
  }
  if (positional.length === 0) throw new UsageError("Give the project folder to bake.");
  const [projectDir, ...scenes] = positional;
  return { projectDir, scenes: scenes.map((s) => s.replace(/\\/g, "/").replace(/^\.?\//, "")) };
}

export interface NavBakeCliResult {
  baked: { scene: string; asset: string; summary: string }[];
  failed: string[];
}

/** Bake a project's chunks. `log` hears a line per scene and chunk. */
export async function bakeProject(projectDir: string, scenes: readonly string[] = [], log: (line: string) => void = () => {}): Promise<NavBakeCliResult> {
  const project = await readProject(projectDir);
  const settings = parseNavigationSettings((project.settings as { navigation?: unknown }).navigation);
  for (const p of settings.problems) log(`warning: ${p}`);
  const all = project.files.filter((f) => f.endsWith(".scene.json"));
  const missing = scenes.filter((s) => !all.includes(s));
  if (missing.length) throw new ServerError(`No such scene in "${project.root}": ${missing.join(", ")}.`);
  const result: NavBakeCliResult = { baked: [], failed: [] };
  Assets.clearSources();
  Assets.addSource(project.assets);
  try {
    for (const path of scenes.length ? scenes : all) {
      let file = project.assets.get(path) as SceneFile;
      const world = new World("editor", { ...project.settings, autoload: [] });
      let scene;
      try {
        scene = World._runIn(world, () => instantiateDocument(world, file, path, { onProblem: () => {} }));
      } catch (err) {
        result.failed.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
        log(`${path}: couldn't load: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const chunks = findNavChunks(scene);
      if (chunks.length === 0) log(`${path}: no NavChunk; skipped.`);
      let sceneChanged = false;
      for (const chunk of chunks) {
        const id = chunkIdOf(chunk);
        try {
          await loadNavGeometryMeshes(world, chunk, settings.settings);
          const geometry = collectNavGeometry(world, chunk, settings.settings);
          const signature = navInputSignature(geometry, settings.settings, path, id);
          const asset = navAssetOf(path, chunk);
          const baked = await bakeChunk(geometry.meshes, settings.settings, path, id, navBakeChunk(geometry));
          const out = join(project.root, ...asset.split("/"));
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, baked.bytes);
          const report = { ...baked.report, warnings: [...geometry.warnings, ...(geometry.pending.length ? [`Models that didn't load weren't baked: ${geometry.pending.join(", ")}.`] : []), ...baked.report.warnings] };
          const record = navBakeRecord(path, id, asset, signature, baked.ms, report);
          const recordFile = join(project.root, ...navRecordPath(asset).split("/"));
          await mkdir(dirname(recordFile), { recursive: true });
          await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);
          const comp = navChunkOf(chunk);
          if (comp && assetPathOf((comp as unknown as { bake: unknown }).bake) !== asset) {
            const next = withBakeReference(file, chunk.id, asset);
            if (next) {
              file = next;
              sceneChanged = true;
            }
          }
          const summary = navBakeSummary(record);
          result.baked.push({ scene: path, asset, summary });
          log(`${path} (${chunk.name}): ${asset}: ${summary}`);
          for (const w of report.warnings) log(`  warning: ${w}`);
        } catch (err) {
          result.failed.push(`${path} (${chunk.name}): ${err instanceof Error ? err.message : String(err)}`);
          log(`${path} (${chunk.name}): failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (sceneChanged) {
        await writeFile(join(project.root, ...path.split("/")), `${JSON.stringify(file, null, 2)}\n`);
        log(`${path}: set the NavChunk's bake reference.`);
      }
      destroyNow(scene);
    }
  } finally {
    Assets.clearSources();
  }
  return result;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`nav:bake: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await bakeProject(options.projectDir, options.scenes, (line) => console.log(line));
    console.log(`Baked ${result.baked.length} chunk${result.baked.length === 1 ? "" : "s"}${result.failed.length ? `; ${result.failed.length} failed` : ""}.`);
    return result.failed.length ? 1 : 0;
  } catch (err) {
    if (err instanceof ServerError) {
      console.error(`nav:bake: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
