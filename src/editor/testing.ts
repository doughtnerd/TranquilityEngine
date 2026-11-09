// Test helpers for editor tests (not part of the editor build): the Flappy sample's files, with
// its types registered (sampleTypes.ts), and the core asset kinds (`useCoreAssetKinds`).
import type { AssetSource, ProjectSettingsInput } from "../engine";
import { afterAll, beforeAll } from "vitest";
import "./sampleTypes";
import { registerCoreAssetKinds } from "./assetKinds.builtin";
import { MemoryFileSystem } from "./memoryFs";
import { editorSettings, joinPath, openFolderProject, readOnlyProject, type EditorProject } from "./projects";
import { currentProject, status } from "./state";
import { select } from "./inspectorTarget";

export { MemoryFileSystem };

export const ROOT = "C:\\Games\\flappy";
/** The Flappy sample's JSON files (ADR 0031), keyed by their path from here. */
export const raw = import.meta.glob("../../samples/flappy/**/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const SAMPLE = "../../samples/flappy/";

export function demoFolder(): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  for (const [key, text] of Object.entries(raw)) fs.files.set(joinPath(ROOT, key.slice(SAMPLE.length)), text);
  for (const img of ["PipeDown.png", "PipeUp.png", "background.png", "flappyBird.png", "ground.jpg"]) {
    fs.files.set(joinPath(ROOT, `images/${img}`), new Uint8Array([137, 80, 78, 71]));
  }
  for (const mp3 of ["foo.mp3", "town.mp3"]) fs.files.set(joinPath(ROOT, `music/${mp3}`), new Uint8Array([1, 2, 3]));
  fs.files.set(joinPath(ROOT, "behaviors/Bird.ts"), "// not an asset");
  fs.files.set(joinPath(ROOT, "node_modules/pkg/package.json"), "{}");
  fs.files.set(joinPath(ROOT, ".git/config.json"), "{}");
  return fs;
}

/**
 * The Flappy sample as a read-only project (its JSON parsed, images and audio as their paths),
 * without its scripts: its types are registered already (sampleTypes.ts).
 */
export function sampleProject(): EditorProject {
  const values = new Map<string, unknown>();
  const texts = new Map<string, string>();
  for (const [key, text] of Object.entries(raw)) {
    const path = key.slice(SAMPLE.length);
    if (path === "tsconfig.json" || path.startsWith(".")) continue;
    texts.set(path, text);
    values.set(path, JSON.parse(text));
  }
  const binaries = import.meta.glob("../../samples/flappy/**/*.{png,jpg,jpeg,mp3}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  for (const [key, url] of Object.entries(binaries)) values.set(key.slice(SAMPLE.length), url);
  return readOnlyProject("Flappy sample", { values, texts });
}

let sample: EditorProject | null = null;
const cachedSample = () => (sample ??= sampleProject());

/** The sample's assets. */
export function demoAssets(): AssetSource {
  return cachedSample().assets;
}

/** The sample's settings for an Editor World. */
export function demoSettings(): ProjectSettingsInput {
  return editorSettings(cachedSample());
}

export const DEMO_SCENE = "scenes/main.scene.json";

/**
 * A writable project in memory holding `files` (project-relative paths; an empty `project.json`
 * unless given), opened as the editor's project, so `editor.project.current` (ADR 0147) is it.
 * Pair it with `closeTestProject` in `afterEach`.
 */
export async function openTestProject(files: Readonly<Record<string, string | Uint8Array>> = {}): Promise<{ project: EditorProject; fs: MemoryFileSystem }> {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  for (const [path, data] of Object.entries(files)) fs.files.set(joinPath(ROOT, path), data);
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { project, fs };
}

/** Close the editor's project and clear the status bar and the node selection (the editor state tests share). */
export function closeTestProject(): void {
  currentProject.value = null;
  status.value = null;
  select([]);
}

/**
 * Register the core asset kinds (ADR 0143) for every test in the calling file, as `main.tsx` does
 * at boot: call it at the top of a test file (or a `describe`) that resolves kinds.
 */
export function useCoreAssetKinds(): void {
  let undo: (() => void) | null = null;
  beforeAll(() => {
    undo = registerCoreAssetKinds();
  });
  afterAll(() => {
    undo?.();
    undo = null;
  });
}
