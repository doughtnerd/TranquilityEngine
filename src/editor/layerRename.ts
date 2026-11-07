// Renaming a physics or sorting layer in the Project panel updates what names it (ADR 0116):
// colliders' `layer` and sprites' `sortingLayer`, in every scene and prefab (including prefab
// instance overrides), plus the open scene as one undo step. Like moving an asset (assetOps.ts),
// the open scene's change is unsaved until saved, and other files are written at once.
import { ReplaceDocument, type SceneFile } from "./document";
import { instancesOf } from "./prefabs";
import { writeSceneFile } from "./project";
import { isScenePath, type EditorProject } from "./projects";
import { layersOf, sortingLayersOf, type SettingsDraft } from "./projectSettingsModel";
import { openScene } from "./state";

export type LayerKind = "physics" | "sorting";

export interface LayerRename {
  kind: LayerKind;
  from: string;
  to: string;
}

/** The component field that names a layer of each kind. */
const FIELD: Record<LayerKind, string> = { physics: "layer", sorting: "sortingLayer" };

/** Physics layers belong to colliders (`engine.BoxCollider2D`, `engine.MeshCollider`...); a script's own `layer` field is left alone. */
const holdsLayer = (kind: LayerKind, componentType: unknown) => kind === "sorting" || (typeof componentType === "string" && /Collider/.test(componentType));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `json` (a scene or prefab file, or its document) with layer `from` renamed to `to` wherever a
 * component field or a prefab override names it. Returns the same object when nothing changed.
 */
export function withRenamedLayer<T>(json: T, kind: LayerKind, from: string, to: string): { value: T; changed: boolean; count: number } {
  let count = 0;
  const field = FIELD[kind];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    // A component entry: { type, data: { layer } }.
    if (isRecord(out.data) && holdsLayer(kind, out.type) && out.data[field] === from) {
      out.data = { ...out.data, [field]: to };
      count++;
    }
    // A prefab override entry: { target, component, field, value }.
    if (out.field === field && out.value === from && "target" in out && holdsLayer(kind, out.component)) {
      out.value = to;
      count++;
    }
    return out;
  };
  const value = walk(json) as T;
  return count > 0 ? { value, changed: true, count } : { value: json, changed: false, count: 0 };
}

/** The scene and prefab files (other than the open scene) that name the layer, as paths. */
export function layerUsers(project: EditorProject, kind: LayerKind, name: string): string[] {
  const open = openScene.peek();
  const users: string[] = [];
  for (const path of project.files) {
    if (!isScenePath(path) || path === open?.path) continue;
    const text = project.textOf(path);
    if (text === undefined || !text.includes(`"${name}"`)) continue;
    try {
      if (withRenamedLayer(JSON.parse(text), kind, name, `${name}\u0000`).changed) users.push(path);
    } catch {
      // not valid JSON: leave it alone
    }
  }
  if (open && withRenamedLayer(open.doc.toJSON(), kind, name, `${name}\u0000`).changed) users.unshift(open.path);
  return users;
}

/**
 * Rewrite every scene and prefab that names the old layer: files on disk now, the open scene as
 * one undo step. Returns the files updated (the open scene marked "(unsaved)").
 */
export async function renameLayerReferences(project: EditorProject, renames: readonly LayerRename[]): Promise<string[]> {
  const scene = openScene.value;
  const done: string[] = [];
  const apply = <T,>(json: T): { value: T; changed: boolean } => {
    let value = json, changed = false;
    for (const r of renames) {
      const next = withRenamedLayer(value, r.kind, r.from, r.to);
      if (next.changed) {
        value = next.value;
        changed = true;
      }
    }
    return { value, changed };
  };
  for (const path of project.files) {
    if (!isScenePath(path) || path === scene?.path) continue;
    const text = project.textOf(path);
    if (text === undefined || !renames.some((r) => text.includes(`"${r.from}"`))) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const result = apply(json);
    if (!result.changed) continue;
    await writeSceneFile(project, path, result.value as SceneFile);
    if (scene) scene.sync.apply(instancesOf(scene.doc, path).map((node) => ({ kind: "rebuild", node }) as const));
    done.push(path);
  }
  if (scene) {
    const result = apply(scene.doc.toJSON());
    if (result.changed) {
      const label = renames.length === 1 ? `Rename ${renames[0].kind} layer ${renames[0].from} to ${renames[0].to}` : "Rename layers";
      scene.stack.execute(new ReplaceDocument(result.value, label));
      done.push(`${scene.path} (unsaved)`);
    }
  }
  return done;
}

const unique = (names: readonly string[]) => names.every((n) => n.trim() !== "") && new Set(names).size === names.length;

/**
 * The layer renames that turn draft `before` into `after`: a list of the same length with exactly
 * one name changed (a rename, not an add, remove, move or an invalid duplicate). Used when the
 * Project panel's undo and redo jump between drafts.
 */
export function layerRenamesBetween(before: SettingsDraft, after: SettingsDraft): LayerRename[] {
  const out: LayerRename[] = [];
  for (const [kind, a, b] of [
    ["physics", layersOf(before), layersOf(after)],
    ["sorting", sortingLayersOf(before), sortingLayersOf(after)],
  ] as const) {
    if (a.length !== b.length || !unique(a) || !unique(b)) continue;
    const changed = a.flatMap((name, i) => (name !== b[i] ? [i] : []));
    if (changed.length === 1) out.push({ kind, from: a[changed[0]], to: b[changed[0]] });
  }
  return out;
}
