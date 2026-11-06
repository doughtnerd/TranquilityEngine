/**
 * ADR 0080: what a scene load warms up. Everything the scene can show, derived from its content
 * (nodes, nested prefab instances, prefabs its component data references), the prefabs and materials
 * the project's scripts name in string literals, and the scene's own `settings.preload` list, as the
 * meshes the render backend draws once, hidden, so their shader pipelines exist before the game needs them.
 */
import { Assets } from "./Assets";
import { loadSceneFile, type ComponentEntry } from "./SceneLoader";
export { scriptAssetRefs } from "./scriptAssetRefs";

/** One mesh to warm: what a MeshRenderer with this data draws, in every pass the frame puts it in. */
export interface WarmMesh {
  mesh: string;
  material: string;
  castShadows: boolean;
  receiveShadows: boolean;
  /**
   * Also warm its alpha-blended variant: a script can fade the renderer (`setMaterialProperty("color")`
   * with alpha below 1 switches a material to blending), so it's assumed for any node with a script.
   */
  blended: boolean;
}

/** The meshes a scene's load warms, and the prefab files they came from (whose textures and models load first). */
export interface WarmSet {
  meshes: WarmMesh[];
  prefabs: string[];
}

const ASSET_FILE = /\.(prefab|material)\.json$/;
/** Prefab and material files the loaded scripts name (`scriptAssetRefs`), set by whoever loads them. */
let scriptRefs: readonly string[] = [];

/** @internal Editor and player script loading: the prefab and material files the project's scripts name. */
export function _setScriptAssetRefs(paths: readonly string[]): void {
  scriptRefs = [...new Set(paths.map((p) => p.replace(/^asset:/, "")))];
}

/** @internal Tests and the warm-up: the files the loaded scripts name. */
export function _scriptAssetRefs(): readonly string[] {
  return scriptRefs;
}

const bare = (p: string) => p.replace(/^asset:/, "");
const has = (p: string) => Assets.has(p) || Assets.has(`asset:${p}`);

/**
 * The warm set of the scene at `path`: its content, the files its `settings.preload` lists, the files
 * the loaded scripts name, and `extra` (from `SceneManager.preload`). Missing or broken files are skipped;
 * whatever they'd have drawn shows in the development report instead.
 */
export function warmSet(path: string | null, extra: readonly string[] = []): WarmSet {
  const meshes = new Map<string, WarmMesh>();
  const prefabs = new Set<string>();
  const seen = new Set<string>();
  const addMesh = (m: WarmMesh) => {
    const key = `${m.mesh}|${m.material}|${m.castShadows}|${m.receiveShadows}`;
    const had = meshes.get(key);
    if (!had || (m.blended && !had.blended)) meshes.set(key, m);
  };
  const walkData = (v: unknown, out: string[]): void => {
    if (typeof v === "string") {
      if (v.startsWith("asset:") && v.endsWith(".prefab.json")) out.push(bare(v));
    } else if (Array.isArray(v)) v.forEach((x) => walkData(x, out));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walkData(x, out));
  };
  const walkFile = (file: string): void => {
    const p = bare(file);
    if (seen.has(p)) return;
    seen.add(p);
    if (!has(p)) return;
    if (p.endsWith(".material.json")) {
      // A material on its own: what it looks like on a sphere (the layout of most built-in meshes).
      addMesh({ mesh: "builtin:sphere", material: `asset:${p}`, castShadows: true, receiveShadows: true, blended: true });
      return;
    }
    let scene;
    try {
      scene = loadSceneFile(p);
    } catch {
      return;
    }
    if (p.endsWith(".prefab.json")) prefabs.add(p);
    const referenced: string[] = [];
    for (const node of scene.nodes) {
      const components: ComponentEntry[] = node.components ?? [];
      const scripted = components.some((c) => !c.type.startsWith("engine."));
      for (const c of components) {
        const data = (c.data ?? {}) as Record<string, unknown>;
        if (c.type === "engine.MeshRenderer") {
          addMesh({
            mesh: typeof data.mesh === "string" ? data.mesh : "builtin:cube",
            material: typeof data.material === "string" ? data.material : "",
            castShadows: data.castShadows !== false,
            receiveShadows: data.receiveShadows !== false,
            blended: scripted,
          });
        }
        walkData(data, referenced);
      }
      walkData(node.overrides, referenced);
      if (node.prefab) referenced.push(node.prefab);
    }
    for (const r of referenced) walkFile(r);
  };
  if (path) walkFile(path);
  let listed: unknown = undefined;
  try {
    listed = path ? loadSceneFile(bare(path)).settings?.preload : undefined;
  } catch {
    /* reported by the load itself */
  }
  for (const p of [...(Array.isArray(listed) ? listed : []), ...extra, ...scriptRefs]) {
    if (typeof p === "string" && ASSET_FILE.test(p)) walkFile(p);
  }
  return { meshes: [...meshes.values()], prefabs: [...prefabs] };
}
