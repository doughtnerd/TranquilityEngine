// Test helpers for editor tests (not part of the editor build): the Flappy sample's files, with
// its types registered (sampleTypes.ts), the core asset kinds (`useCoreAssetKinds`) and the built-in panels
// (`useBuiltinPanels`).
import type { VNode } from "preact";
import type { AssetSource, Engine, ProjectSettingsInput } from "../engine";
import type { ComponentInfo, EditorOverlay } from "../engine/editor";
import { FakeRenderSurface } from "../engine/render/fakeViewport";
import { afterAll, beforeAll } from "vitest";
import "./sampleTypes";
import { registerCoreAssetKinds } from "./assetKinds.builtin";
import { resetLayout } from "./layout/store";
import { registerBuiltinPanels } from "./ui/panels.builtin";
import { MemoryFileSystem } from "./memoryFs";
import { editorSettings, joinPath, openFolderProject, readOnlyProject, type EditorProject } from "./projects";
import { settingsKeys, type SettingsDraft } from "./projectSettingsModel";
import { InspectorSections, type InspectorSectionProps } from "./ui/inspectorSections";
import type { LazyComponent } from "./ui/lazy";
import { currentProject, status } from "./state";
import { select } from "./inspectorTarget";
import { installViewportTools } from "./viewportTools";

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

/**
 * Register the built-in panels (ADR 0182) for every test in the calling file, as `corePanels.ts` does at
 * boot, and start from the default layout (the layout store read storage before they were registered).
 */
export function useBuiltinPanels(): void {
  let undo: (() => void) | null = null;
  beforeAll(() => {
    undo = registerBuiltinPanels();
    resetLayout();
  });
  afterAll(() => {
    undo?.();
    undo = null;
  });
}

/** A settings draft (the Project panel's sections of project.json) from parsed settings: each of `keys` that's set, copied. */
export function readDraft(settings: ProjectSettingsInput | Record<string, unknown>, keys: readonly string[] = settingsKeys()): SettingsDraft {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = structuredClone(value);
  }
  return out as SettingsDraft;
}

/** A draft's sections as one comparable string. */
export const sectionsKey = (draft: SettingsDraft, keys: readonly string[] = settingsKeys()) => JSON.stringify(keys.map((k) => draft[k] ?? null));

/** The sections the Inspector draws under a `type` component for a selection of `paths`, as it renders them (lazy views, none loaded yet). */
export function inspectorSectionsFor(type: string, paths: InspectorSectionProps["paths"]): LazyComponent<InspectorSectionProps>[] {
  const drawn = InspectorSections({ info: { type } as ComponentInfo, paths } as InspectorSectionProps) as VNode<{ children: VNode[] }>;
  return drawn.props.children.map((view) => view.type as unknown as LazyComponent<InspectorSectionProps>);
}

/** The scene view's canvas in `sceneViewTools`: the fake surface's canvas, with a cursor and pointer capture. */
export type SceneViewCanvas = HTMLCanvasElement & { readonly captured: number[] };

/** The editor's viewport tool host running on a scene view, as `sceneViewTools` starts it. */
export interface SceneViewTools {
  /** The scene view's surface (draws nothing; `surface.adapter.overlay` is what the tools draw). */
  readonly surface: FakeRenderSurface;
  readonly canvas: SceneViewCanvas;
  /** The page's `window`, where the host listens for keys. */
  readonly window: EventTarget;
  /** Whether a modal dialog (`.dialog`) is in the page. */
  dialogOpen: boolean;
  /** What the tools draw now. */
  overlay(): EditorOverlay;
  /** Remove the tools, the fake surface and the page stand-ins. */
  stop(): void;
}

/**
 * Start the editor's own viewport tool host (`installViewportTools`, as the session does) on
 * `engine`'s scene view, over a fake render surface, with the page's `window` and `document`
 * stood in for (Vitest runs without a DOM). It installs every registered viewport tool.
 */
export function sceneViewTools(engine: Engine): SceneViewTools {
  const surface = new FakeRenderSurface();
  const captured: number[] = [];
  const canvas = Object.assign(surface.canvas, { style: { cursor: "" }, captured, setPointerCapture: (id: number) => void captured.push(id) }) as unknown as SceneViewCanvas;
  const page = new EventTarget();
  const tools: SceneViewTools = {
    surface,
    canvas,
    window: page,
    dialogOpen: false,
    overlay: () => surface.adapter.overlay?.() ?? { lines: [], handles: [] },
    stop: () => {
      stopHost();
      engine.world.render = null;
      for (const [key, before] of saved) {
        if (before) Object.defineProperty(globalThis, key, before);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
  const stand: Record<string, unknown> = { window: page, document: { querySelector: (selector: string) => (selector === ".dialog" && tools.dialogOpen ? {} : null) } };
  const saved = Object.keys(stand).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Object.keys(stand)) Object.defineProperty(globalThis, key, { value: stand[key], configurable: true, writable: true });
  engine.world.render = surface;
  const stopHost = installViewportTools(engine);
  return tools;
}
