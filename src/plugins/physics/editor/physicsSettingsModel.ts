// The Physics settings section's model (ADR 0038, 0116, 0151): `project.json`'s `physics` key, which the
// Physics plugin's settings section owns: gravity, the layers and their collision matrix, as pure edits of
// the Project panel's draft, and the problems that keep it from being saved. Moved here from the shell's
// `projectSettingsModel.ts` when settings sections began declaring their keys.
import { physicsBackendProblems, resolvePhysicsSettings } from "../../../engine/core/settings";
import { settingsSection, type NamedList, type SettingsDraft, type SettingsProblem } from "../../../editor/sdk";
import { uniqueName } from "../../../engine/core/uniqueName";

/** Physics layers are bits in a 16-bit collision mask. */
export const MAX_LAYERS = 16;

/**
 * `project.json`'s `physics` key in the settings draft: read with the engine's defaults, checked by field, and edited
 * value by value in what's written (`"written"`), so a value never set keeps following its default.
 */
export const physicsSettings = settingsSection({
  key: "physics",
  parse: (written) => ({ settings: resolvePhysicsSettings(written as SettingsDraft["physics"]) }),
  edits: "written",
  problems: physicsProblems,
});

const layersOf = (d: SettingsDraft): string[] => physicsSettings.read(d).layers;

/** The physics Components with a `layer` field: every collider type and both character controllers (a script's own `layer` field is left alone). */
export const LAYERED_COMPONENTS = [
  "engine.BoxCollider2D", "engine.CircleCollider2D", "engine.PolygonCollider2D", "engine.EdgeCollider2D", "engine.TilemapCollider2D", "engine.CharacterController2D",
  "engine.BoxCollider", "engine.SphereCollider", "engine.CapsuleCollider", "engine.MeshCollider", "engine.CharacterController",
] as const;

/** The physics layers as a named list (ADR 0262): renaming one renames the `layer` of every physics Component that names it. */
export const physicsLayers: NamedList = {
  id: "physics.layers",
  noun: "physics layer",
  names: layersOf,
  fields: [{ component: LAYERED_COMPONENTS, field: "layer" }],
};

/** Pair key for two layer names, order-free. */
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Every colliding pair (by name). With no matrix, every layer collides with every layer, itself included. */
function pairsOf(draft: SettingsDraft): Set<string> {
  const layers = layersOf(draft);
  const matrix = draft.physics?.collisionMatrix;
  const pairs = new Set<string>();
  if (!matrix) {
    for (let i = 0; i < layers.length; i++) for (let j = i; j < layers.length; j++) pairs.add(pairKey(layers[i], layers[j]));
    return pairs;
  }
  for (const [a, list] of Object.entries(matrix)) if (Array.isArray(list)) for (const b of list) pairs.add(pairKey(a, b));
  return pairs;
}

/** Whether layers `a` and `b` collide (the engine's rule: the matrix is symmetric). */
export function collides(draft: SettingsDraft, a: string, b: string): boolean {
  return pairsOf(draft).has(pairKey(a, b));
}

/** The matrix for a set of pairs: each pair listed under its earlier layer, or none at all when every pair collides. */
function matrixOf(layers: readonly string[], pairs: Set<string>): Record<string, string[]> | undefined {
  let all = true;
  const out: Record<string, string[]> = {};
  for (let i = 0; i < layers.length; i++) {
    for (let j = i; j < layers.length; j++) {
      if (!pairs.has(pairKey(layers[i], layers[j]))) {
        all = false;
        continue;
      }
      (out[layers[i]] ??= []).push(layers[j]);
    }
  }
  return all ? undefined : out;
}

const withLayers = (draft: SettingsDraft, layers: string[], pairs: Set<string>): SettingsDraft =>
  physicsSettings.set(physicsSettings.set(draft, "layers", layers), "collisionMatrix", matrixOf(layers, pairs));

export function setCollides(draft: SettingsDraft, a: string, b: string, on: boolean): SettingsDraft {
  const pairs = pairsOf(draft);
  if (on) pairs.add(pairKey(a, b));
  else pairs.delete(pairKey(a, b));
  return physicsSettings.set(draft, "collisionMatrix", matrixOf(layersOf(draft), pairs));
}

/** Add a layer. It collides with everything until unchecked (with no matrix), or with nothing (with one). */
export function addLayer(draft: SettingsDraft): SettingsDraft {
  const layers = layersOf(draft);
  const name = uniqueName("Layer", layers);
  const pairs = pairsOf(draft);
  if (draft.physics?.collisionMatrix === undefined) for (const l of [...layers, name]) pairs.add(pairKey(name, l));
  return withLayers(draft, [...layers, name], pairs);
}

/** Rename a layer, in the matrix too. (The files that name it are updated by the shell's settings names module, from `physicsLayers`, ADR 0262.) */
export function renameLayer(draft: SettingsDraft, index: number, name: string): SettingsDraft {
  const layers = [...layersOf(draft)];
  const old = layers[index];
  if (old === undefined || old === name) return draft;
  layers[index] = name;
  const rename = (n: string) => (n === old ? name : n);
  const pairs = new Set([...pairsOf(draft)].map((k) => k.split("\u0000")).map(([a, b]) => pairKey(rename(a), rename(b))));
  return withLayers(draft, layers, pairs);
}

export function removeLayer(draft: SettingsDraft, index: number): SettingsDraft {
  const layers = layersOf(draft);
  const gone = layers[index];
  if (gone === undefined || layers.length <= 1) return draft;
  const pairs = new Set([...pairsOf(draft)].filter((k) => !k.split("\u0000").includes(gone)));
  return withLayers(draft, layers.filter((_, i) => i !== index), pairs);
}

/** Set one axis of gravity; z (3D physics, ADR 0045) is kept only while it's not 0. */
export function setGravity(draft: SettingsDraft, axis: 0 | 1 | 2, value: number): SettingsDraft {
  const g: number[] = [...physicsSettings.read(draft).gravity];
  while (g.length < 3) g.push(0);
  g[axis] = value;
  const gravity = g[2] === 0 ? [g[0], g[1]] : g.slice(0, 3);
  return physicsSettings.set(draft, "gravity", gravity);
}

/** What's wrong with the draft's `physics` key, by field (`"physics.layers.2"`): the section's `problems`. */
function physicsProblems(draft: SettingsDraft): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const p = (field: string, message: string) => problems.push({ field, message });
  const physics = draft.physics ?? {};
  if (physics.gravity !== undefined && !(Array.isArray(physics.gravity) && (physics.gravity.length === 2 || physics.gravity.length === 3) && physics.gravity.every((g) => typeof g === "number" && Number.isFinite(g)))) {
    p("physics.gravity", "Gravity must be two numbers, x and y, or three with z.");
  }
  if (physics.layers !== undefined) {
    const list: unknown = physics.layers;
    if (!Array.isArray(list)) p("physics.layers", "Physics layers must be a list of names.");
    else {
      if (list.length === 0) p("physics.layers", "There must be at least one Physics layer.");
      const seen = new Set<string>();
      list.forEach((name, i) => {
        if (typeof name !== "string" || name.trim() === "") p(`physics.layers.${i}`, `Physics layers: entry ${i + 1} needs a name.`);
        else if (seen.has(name)) p(`physics.layers.${i}`, `Physics layers: "${name}" is listed twice.`);
        else seen.add(name);
      });
    }
  }
  for (const message of physicsBackendProblems(physics)) p(message.startsWith("physics.backend2d") ? "physics.backend2d" : "physics.backend3d", message);
  const layers = layersOf(draft);
  if (Array.isArray(layers) && layers.length > MAX_LAYERS) p("physics.layers", `There can be at most ${MAX_LAYERS} physics layers.`);
  const matrix = physics.collisionMatrix;
  if (matrix !== undefined) {
    if (typeof matrix !== "object" || matrix === null || Array.isArray(matrix)) p("physics.collisionMatrix", "The collision matrix must be an object of layer lists.");
    else {
      const unknown = new Set<string>();
      for (const [a, list] of Object.entries(matrix)) {
        if (!layers.includes(a)) unknown.add(a);
        if (!Array.isArray(list)) p("physics.collisionMatrix", `The collision matrix entry for "${a}" must be a list of layers.`);
        else for (const b of list) if (!layers.includes(b)) unknown.add(String(b));
      }
      if (unknown.size > 0) p("physics.collisionMatrix", `The collision matrix names ${[...unknown].map((n) => `"${n}"`).join(", ")}, which ${unknown.size === 1 ? "isn't a physics layer" : "aren't physics layers"}.`);
    }
  }
  return problems;
}
