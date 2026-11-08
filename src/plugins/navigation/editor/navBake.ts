// Baking navigation in the editor (ADR 0065): Bake on a NavChunk and Bake All in the Project panel's
// Navigation section.
//
// A bake collects the chunk's geometry from a World (the open scene's Editor World, or a scratch World the
// scene is instantiated into for Bake All), posts it to the bake worker (navBake.worker.ts, which keeps one
// baker per chunk so rebakes are incremental), writes `<scene>.nav.bin` beside the scene, points the
// NavChunk's `bake` field at it (an undoable edit) and records what it baked from in
// `.myco/nav/<asset>.json`: the report and a signature of the inputs, so a chunk whose inputs changed since
// is flagged as stale.
import { signal } from "@preact/signals";
import { World } from "../../../engine/core/World";
import { instantiateDocument, destroyNow } from "../../../engine/editor";
import { bakeChunk, releaseBakeCaches, type NavBakeChunk, type NavBakeMesh, type NavBakeResult } from "../../../engine/nav/bake";
import {
  collectNavGeometry,
  findNavChunks,
  loadNavGeometryMeshes,
  NAV_CHUNK,
  navBakeChunk,
  navChunkOf,
  navInputSignature,
} from "../../../engine/nav/geometry";
import { parseNavigationSettings, type NavigationSettings } from "../../../engine/nav/settings";
import type { GameObject } from "../../../engine/scene/GameObject";
import { SetField } from "../../../editor/document";
import type { SceneFile } from "../../../engine/scene/SceneLoader";
import { errorStatus } from "../../../editor/messages";
import { editorSettings, isScenePath, joinPath, type EditorProject } from "../../../editor/projects";
import { openScene, openScenes, status, type OpenScene } from "../../../editor/state";
import { assetPathOf, chunkIdOf, navAssetFor, navBakeRecord, navBakeSummary, navRecordPath, withBakeReference, type NavBakeRecord } from "./navBakeFiles";

export { navBakeSummary, navPolyCount, type NavBakeRecord } from "./navBakeFiles";

/** What the worker bakes: one chunk's geometry and settings. */
export interface NavBakeRequest {
  meshes: NavBakeMesh[];
  settings: NavigationSettings;
  scenePath: string;
  chunkNodeId: string;
  chunk: NavBakeChunk;
}

/** Where a bake is: collecting geometry, loading the module, baking, writing the file. */
export type NavBakeStage = "collecting" | "loading" | "baking" | "writing";
export const NAV_STAGE_LABELS: Record<NavBakeStage, string> = {
  collecting: "Collecting geometry…",
  loading: "Loading the navigation module…",
  baking: "Baking…",
  writing: "Writing the bake file…",
};

export interface NavChunkBakeState {
  stage: NavBakeStage | null;
  error: string | null;
  /** The last bake (this session's, or read from `.myco/nav/`); undefined until looked up. */
  record: NavBakeRecord | null | undefined;
  /** The signature of the chunk's inputs now, once checked. */
  currentSignature: string | null;
}

/** Bumped whenever a chunk's bake state changes, so the Inspector re-renders. */
export const navBakeVersion = signal(0);
/** Bake All's progress: "2 of 5: scenes/a.scene.json", or null. */
export const navBakeAllProgress = signal<string | null>(null);

const states = new Map<string, NavChunkBakeState>();
const keyOf = (scenePath: string, chunkNodeId: string) => `${scenePath}\n${chunkNodeId}`;

/** A chunk's bake state (a blank one if it has none yet). */
export function navChunkState(scenePath: string, chunkNodeId: string): NavChunkBakeState {
  const key = keyOf(scenePath, chunkNodeId);
  let s = states.get(key);
  if (!s) states.set(key, (s = { stage: null, error: null, record: undefined, currentSignature: null }));
  return s;
}

function update(scenePath: string, chunkNodeId: string, patch: Partial<NavChunkBakeState>): void {
  Object.assign(navChunkState(scenePath, chunkNodeId), patch);
  navBakeVersion.value++;
}

/** Forget every chunk's state (another project opened; tests). */
export function resetNavBakeStates(): void {
  states.clear();
  recordCache.clear();
  navBakeVersion.value++;
}

let stateProject: EditorProject | null = null;

/** Start over when another project is opened: states and records are per project. */
function forProject(project: EditorProject): void {
  if (stateProject === project) return;
  if (stateProject !== null) {
    states.clear();
    recordCache.clear();
    releaseBakers(); // another project's caches could match this one's scene paths and node ids
  }
  stateProject = project;
}

/** True when a chunk's last bake was made from different inputs than it has now. */
export function isNavBakeStale(s: NavChunkBakeState): boolean {
  return !!s.record && s.currentSignature !== null && s.record.inputSignature !== s.currentSignature;
}

// --- the bake runner (worker, or in-thread where there are no workers) ------------------------------

export type NavBakeRunner = (request: NavBakeRequest, onStage: (stage: NavBakeStage) => void) => Promise<NavBakeResult>;

/** Bakes on this thread (Node, tests). */
export const inThreadRunner: NavBakeRunner = async (r, onStage) => {
  onStage("baking");
  return bakeChunk(r.meshes, r.settings, r.scenePath, r.chunkNodeId, r.chunk);
};

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, { request: NavBakeRequest; resolve: (r: NavBakeResult) => void; reject: (e: Error) => void; onStage: (s: NavBakeStage) => void }>();

function bakeWorker(): Worker | null {
  if (worker || workerFailed || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./navBake.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; type: string; stage?: NavBakeStage; result?: NavBakeResult; message?: string }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      if (e.data.type === "stage") job.onStage(e.data.stage!);
      else {
        pending.delete(e.data.id);
        if (e.data.type === "done") job.resolve(e.data.result!);
        else job.reject(new Error(e.data.message ?? "The bake failed."));
      }
    };
    worker.onerror = (e) => {
      // A worker that can't start (or crashed): bake what was sent to it on this thread instead, and every bake
      // from now on (workerRunner posts copies of the meshes, so the requests here still have them).
      e.preventDefault?.();
      workerFailed = true;
      worker?.terminate();
      worker = null;
      console.warn(`[editor] the navigation bake worker stopped (${e.message || "it couldn't load"}); baking on the main thread.`);
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) inThreadRunner(job.request, job.onStage).then(job.resolve, job.reject);
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** Bakes in the bake worker; falls back to this thread where workers aren't available. */
export const workerRunner: NavBakeRunner = (request, onStage) => {
  const w = bakeWorker();
  if (!w) return inThreadRunner(request, onStage);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    // Copied rather than transferred, so the request can still be baked on this thread if the worker fails.
    pending.set(id, { request, resolve, reject, onStage });
    w.postMessage({ id, type: "bake", request });
  });
};

let runner: NavBakeRunner = workerRunner;

/** Frees every chunk's incremental bake caches, in the worker and on this thread. */
function releaseBakers(): void {
  worker?.postMessage({ id: nextId++, type: "release" });
  releaseBakeCaches();
}

/** Use another runner (tests bake in-thread); returns the previous one. */
export function setNavBakeRunner(next: NavBakeRunner): NavBakeRunner {
  const previous = runner;
  runner = next;
  return previous;
}

// --- records ----------------------------------------------------------------------------------------

const recordCache = new Map<string, NavBakeRecord | null>();

async function readRecord(project: EditorProject, asset: string): Promise<NavBakeRecord | null> {
  if (recordCache.has(asset)) return recordCache.get(asset)!;
  let record: NavBakeRecord | null = null;
  if (project.fileSystem && project.root) {
    try {
      const path = joinPath(project.root, navRecordPath(asset));
      if (await project.fileSystem.exists(path)) {
        const parsed = JSON.parse(await project.fileSystem.readText(path)) as NavBakeRecord;
        if (parsed?.format === "myco.navbake@1") record = parsed;
      }
    } catch {
      record = null; // unreadable: as if never baked here
    }
  }
  recordCache.set(asset, record);
  return record;
}

async function writeRecord(project: EditorProject, record: NavBakeRecord): Promise<void> {
  recordCache.set(record.asset, record);
  if (!project.fileSystem || !project.root) return;
  const path = navRecordPath(record.asset);
  const folder = joinPath(project.root, path.slice(0, path.lastIndexOf("/")));
  try {
    if (!(await project.fileSystem.exists(folder))) await project.fileSystem.mkdir(folder);
    await project.fileSystem.writeText(joinPath(project.root, path), `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    console.warn(`[editor] couldn't keep the bake record ${path}: ${String(err)}`);
  }
}

// --- helpers ----------------------------------------------------------------------------------------

/** The project's navigation settings (the defaults without a section, or without a project). */
export function projectNavigation(project: EditorProject | null | undefined): NavigationSettings {
  return parseNavigationSettings((project?.settings as { navigation?: unknown } | undefined)?.navigation).settings;
}

/** Look up a chunk's last bake record (once), for the Inspector. */
export async function lookUpNavRecord(project: EditorProject, scenePath: string, chunkNode: GameObject): Promise<void> {
  forProject(project);
  const id = chunkIdOf(chunkNode);
  const s = navChunkState(scenePath, id);
  if (s.record !== undefined) return;
  const scene = chunkNode.scene;
  const asset = navAssetFor(scenePath, chunkNode, scene ? findNavChunks(scene) : []);
  const record = await readRecord(project, asset);
  update(scenePath, id, { record: record && record.chunkNodeId === id ? record : null });
}

/** Recompute the signature of a chunk's inputs (for the stale notice). */
export async function checkNavInputs(project: EditorProject, scenePath: string, world: World, chunkNode: GameObject): Promise<void> {
  forProject(project);
  const settings = projectNavigation(project);
  await loadNavGeometryMeshes(world, chunkNode, settings);
  if (!chunkNode.isValid) return;
  const id = chunkIdOf(chunkNode);
  const geometry = collectNavGeometry(world, chunkNode, settings);
  const signature = navInputSignature(geometry, settings, scenePath, id);
  if (navChunkState(scenePath, id).currentSignature !== signature) update(scenePath, id, { currentSignature: signature });
}

// --- baking -----------------------------------------------------------------------------------------

export interface NavBakeOutcome {
  asset: string;
  record: NavBakeRecord;
  /** True when the NavChunk's `bake` field didn't name the file yet. */
  needsReference: boolean;
}

/**
 * Bake one chunk of a World: collect, bake, write the file and the record. Doesn't touch the scene; the
 * caller points the NavChunk at the file. Throws for a read-only project or a failed bake (also kept in
 * the chunk's state).
 */
export async function bakeNavChunk(project: EditorProject, scenePath: string, world: World, chunkNode: GameObject): Promise<NavBakeOutcome> {
  forProject(project);
  const id = chunkIdOf(chunkNode);
  if (!project.canSave) throw new Error(`${project.name} is read-only: open a project folder to bake navigation.`);
  const s = navChunkState(scenePath, id);
  if (s.stage) throw new Error(`${chunkNode.name} is already baking.`);
  update(scenePath, id, { stage: "collecting", error: null });
  try {
    const settings = projectNavigation(project);
    await loadNavGeometryMeshes(world, chunkNode, settings);
    const geometry = collectNavGeometry(world, chunkNode, settings);
    const signature = navInputSignature(geometry, settings, scenePath, id);
    const scene = chunkNode.scene;
    const asset = navAssetFor(scenePath, chunkNode, scene ? findNavChunks(scene) : []);
    const comp = navChunkOf(chunkNode);
    const needsReference = !!comp && assetPathOf((comp as unknown as { bake?: unknown }).bake) !== asset;
    const request: NavBakeRequest = { meshes: geometry.meshes, settings, scenePath, chunkNodeId: id, chunk: navBakeChunk(geometry) };
    const result = await runner(request, (stage) => update(scenePath, id, { stage }));
    update(scenePath, id, { stage: "writing" });
    await project.writeBinary(asset, result.bytes);
    const report = { ...result.report, warnings: [...geometry.warnings, ...(geometry.pending.length ? [`Models still loading weren't baked: ${geometry.pending.join(", ")}.`] : []), ...result.report.warnings] };
    const record = navBakeRecord(scenePath, id, asset, signature, result.ms, report);
    await writeRecord(project, record);
    update(scenePath, id, { stage: null, record, currentSignature: signature });
    return { asset, record, needsReference };
  } catch (err) {
    update(scenePath, id, { stage: null, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Bake a NavChunk of the open scene (the Inspector's Bake button): the result is reported in the status bar. */
export async function bakeOpenSceneChunk(scene: OpenScene, nodeId: string, project: EditorProject): Promise<void> {
  const node = scene.sync.nodeFor([nodeId]);
  if (!node) return;
  try {
    const outcome = await bakeNavChunk(project, scene.path, scene.sync.world, node);
    if (outcome.needsReference && scene.doc.has(nodeId)) scene.stack.execute(new SetField(nodeId, NAV_CHUNK, "bake", `asset:${outcome.asset}`));
    status.value = { kind: "info", text: `Baked ${node.name}: ${outcome.asset} (${navBakeSummary(outcome.record)}).` };
  } catch (err) {
    status.value = errorStatus(`Couldn't bake ${node.name}`, err);
  }
}

// --- Bake All ---------------------------------------------------------------------------------------

/** A scene instantiated into a World of its own (no renderer, nothing runs), for Bake All. */
export function scratchSceneWorld(project: EditorProject, path: string, file: SceneFile): { world: World; scene: GameObject } {
  const world = new World("editor", editorSettings(project));
  const scene = World._runIn(world, () => instantiateDocument(world, file, path, { onProblem: () => {} }));
  return { world, scene };
}

/**
 * Bake every NavChunk of every scene in the project. The open scene bakes from its Editor World (unsaved
 * edits included); other open scenes from their documents; the rest from their files. Returns how many
 * chunks were baked and the failures.
 */
export async function bakeAllNavigation(project: EditorProject): Promise<{ baked: number; failed: string[] }> {
  const scenes = project.files.filter((f) => isScenePath(f) && f.endsWith(".scene.json"));
  const failed: string[] = [];
  let baked = 0;
  try {
    for (const [i, path] of scenes.entries()) {
      navBakeAllProgress.value = `${i + 1} of ${scenes.length}: ${path}`;
      const active = openScene.peek();
      const open = openScenes.peek().find((s) => s.path === path) ?? null;
      let world: World, root: GameObject | null, scratch: GameObject | null = null;
      if (active && active.path === path && active.sync.sceneNode) {
        world = active.sync.world;
        root = active.sync.sceneNode;
      } else {
        const file = (open ? open.doc.toJSON() : project.assets.get(path)) as SceneFile | undefined;
        if (!file) continue;
        try {
          ({ world, scene: scratch } = scratchSceneWorld(project, path, file));
        } catch (err) {
          failed.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        root = scratch;
      }
      try {
        for (const chunk of findNavChunks(root)) {
          try {
            const outcome = await bakeNavChunk(project, path, world, chunk);
            baked++;
            if (!outcome.needsReference) continue;
            const id = chunk.id;
            const target = open ?? (active?.path === path ? active : null);
            if (target && target.doc.has(id)) target.stack.execute(new SetField(id, NAV_CHUNK, "bake", `asset:${outcome.asset}`));
            else {
              const next = withBakeReference(project.assets.get(path) as SceneFile, id, outcome.asset);
              if (next) await project.writeText(path, `${JSON.stringify(next, null, 2)}\n`);
            }
          } catch (err) {
            failed.push(`${path} (${chunk.name}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        if (scratch) destroyNow(scratch);
      }
    }
  } finally {
    navBakeAllProgress.value = null;
  }
  return { baked, failed };
}

/** Bake All from the Project panel, reported in the status bar. */
export async function bakeAllFromPanel(project: EditorProject): Promise<void> {
  if (!project.canSave) {
    status.value = { kind: "error", text: `${project.name} is read-only: open a project folder to bake navigation.` };
    return;
  }
  const { baked, failed } = await bakeAllNavigation(project);
  if (failed.length) status.value = { kind: "error", text: `Baked ${baked} navigation chunk${baked === 1 ? "" : "s"}; ${failed.length} failed.`, detail: failed.join("\n") };
  else status.value = { kind: "info", text: baked === 0 ? "No scene has a NavChunk to bake." : `Baked ${baked} navigation chunk${baked === 1 ? "" : "s"}.` };
}
