// Asset thumbnails for the open project (ADR 0061): the Assets panel and the Inspector ask here.
// One service per project, kept in `.myco/thumbnails/` for a writable project folder and in memory
// otherwise; the engine's thumbnail renderer is loaded the first time something needs drawing.
import { effect } from "@preact/signals";
import { createThumbnailRenderer, type ThumbnailKind, type ThumbnailRenderer } from "../../engine/editor";
import type { EditorProject } from "../projects";
import { currentProject } from "../state";
import { type AudioSummary, decodeAudioSummary } from "./audio";
import { previewKind } from "./keys";
import { ThumbnailService, type Thumbnail, type ThumbnailProject } from "./service";
import { memoryStore, projectStore, type ThumbnailStore } from "./store";

export type { AudioSummary } from "./audio";
export type { Thumbnail } from "./service";
export { previewKind, type PreviewKind } from "./keys";

let renderer: Promise<ThumbnailRenderer> | null = null;
const getRenderer = () => (renderer ??= createThumbnailRenderer());

let current: { project: EditorProject; service: ThumbnailService } | null = null;
/** Thumbnails drawn this session (end-to-end tests check a reopened project reads its cache instead). */
let renders = 0;

/** The open project as the thumbnail service reads it. */
function adapt(project: EditorProject): ThumbnailProject {
  // JSON stamps: a number per file that changes when its text does. The text comparison is by
  // identity in practice (the project keeps the same string until the file is rewritten), so a
  // stamp costs a map lookup rather than joining whole files into the key's stamp string.
  const versions = new Map<string, { text: string; n: number }>();
  let counter = 0;
  let filesRef: readonly string[] | null = null;
  let fileSet = new Set<string>();
  const has = (p: string) => {
    if (filesRef !== project.files) {
      filesRef = project.files;
      fileSet = new Set(filesRef);
    }
    return fileSet.has(p);
  };
  return {
    get files() {
      return project.files;
    },
    text: (p) => (p.endsWith(".json") ? project.textOf(p) : undefined),
    async bytes(p) {
      const text = p.endsWith(".json") ? project.textOf(p) : undefined;
      if (text !== undefined) return new TextEncoder().encode(text);
      const url = project.assets.get(p);
      if (typeof url !== "string") throw new Error(`Couldn't read ${p}.`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't read ${p}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    stamp(p) {
      if (!has(p)) return undefined;
      // JSON: its text's version. Binaries: their URL (new when rewritten) and size.
      const text = p.endsWith(".json") ? project.textOf(p) : undefined;
      if (text !== undefined) {
        let v = versions.get(p);
        if (!v || v.text !== text) versions.set(p, (v = { text, n: ++counter }));
        return `j${v.n}`;
      }
      try {
        return `${String(project.assets.get(p))}|${project.sizeOf(p) ?? ""}`;
      } catch {
        return undefined;
      }
    },
  };
}

function storeFor(project: EditorProject): ThumbnailStore {
  return project.canSave && project.root && project.fileSystem ? projectStore(project.fileSystem, project.root) : memoryStore();
}

/** The open project's service, made (and the last one's let go) when the project changes. */
function service(): ThumbnailService | null {
  const project = currentProject.peek();
  if (current?.project !== project) {
    current?.service.dispose();
    // Another project: the same path can be a different file, so the renderer loads textures afresh.
    void renderer?.then((r) => r.clearCaches(), () => undefined);
    current = project
      ? {
          project,
          service: new ThumbnailService(adapt(project), storeFor(project), {
            render: async (kind, path) => {
              renders++;
              return (await getRenderer()).render(kind, path);
            },
            decodeAudio: decodeAudioSummary,
          }),
        }
      : null;
  }
  return current?.service ?? null;
}

/** An asset's thumbnail (an object URL), or null for assets without one. Pass `signal` to drop it if the tile goes away. */
export function thumbnailFor(path: string, signal?: AbortSignal): Promise<Thumbnail | null> {
  return service()?.thumbnailFor(path, signal) ?? Promise.resolve(null);
}

/** An audio clip's waveform peaks, length, channels and sample rate, or null. */
export function audioSummaryFor(path: string): Promise<AudioSummary | null> {
  return service()?.audioSummaryFor(path) ?? Promise.resolve(null);
}

/** Whether an asset's tile animates on hover (particle effects, shader graphs that use Time). */
export async function canAnimate(path: string): Promise<boolean> {
  const kind = previewKind(path);
  if (!kind || kind === "audio") return false;
  if (kind !== "particles" && kind !== "shadergraph" && kind !== "material") return false;
  return (await getRenderer()).canAnimate(kind as ThumbnailKind, path);
}

/**
 * Animate an asset in `canvas` (its tile, on hover) until the returned function is called, another
 * animation starts, or the canvas leaves the page. One at a time.
 */
export function animateThumbnail(path: string, canvas: HTMLCanvasElement): () => void {
  const kind = previewKind(path);
  if (!kind || kind === "audio") return () => undefined;
  let stop: (() => void) | null = null;
  let cancelled = false;
  void getRenderer().then((r) => {
    if (!cancelled) stop = r.animate(kind as ThumbnailKind, path, canvas);
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

/**
 * Follow the open project: start its service, and prune unused thumbnails a few seconds after it
 * opens (idle time). Returns a function that stops. Also installs the `window.thumbnails` debug and
 * end-to-end hook.
 */
export function installThumbnails(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopEffect = effect(() => {
    currentProject.value; // follow the open project
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // service() also lets the last project's service go when none is open (its URLs and caches).
    const s = service();
    if (s && s.store.where) {
      const idle = (cb: () => void) => ((globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 0)))(cb);
      timer = setTimeout(() => idle(() => void s.prune().catch(() => undefined)), 5000);
    }
  });
  if (typeof window !== "undefined") {
    Object.assign(window, {
      thumbnails: {
        thumbnailFor,
        audioSummaryFor,
        keyFor: (path: string) => service()?.keyFor(path) ?? Promise.resolve(null),
        prune: () => service()?.prune() ?? Promise.resolve(0),
        where: () => service()?.store.where ?? null,
        renders: () => renders,
        /** Drop the service, as reopening the project would: the next request reads the cache afresh. */
        reset: () => {
          current?.service.dispose();
          current = null;
        },
      },
    });
  }
  return () => {
    stopEffect();
    if (timer !== null) clearTimeout(timer);
  };
}
