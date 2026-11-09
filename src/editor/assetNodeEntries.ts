// The scene entries files of the core asset kinds become (ADR 0026, 0140: a kind's `addToScene`), and
// the node ids they get. Pure: imports only types, so the core asset kinds (`assetKinds.ts`) can use it
// wherever they are registered, the Vitest setup included.
import type { NodeEntry, SceneDocument } from "./document";

/** The file name of a project path: `images/bird.png` → `bird.png`. */
export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A node id from a file name: `pipe-pair.prefab.json` → `pipe-pair`, `flappyBird.png` → `flappy-bird`. */
export function idBase(path: string): string {
  const base = fileName(path).replace(/\.(scene|prefab)\.json$/i, "").replace(/\.[^.]+$/, "");
  const id = base
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "node";
}

/** `base`, or `base-2`, `base-3`… whichever isn't used in the document yet. */
export function uniqueId(doc: SceneDocument, base: string): string {
  if (!doc.has(base)) return base;
  for (let n = 2; ; n++) if (!doc.has(`${base}-${n}`)) return `${base}-${n}`;
}

type Vec3 = readonly [number, number, number];

/**
 * The scene entry for an instance of a prefab or scene file. With `position`, the instance gets
 * a Transform override placing it there (a prefab's own position applies otherwise).
 */
export function prefabInstanceEntry(doc: SceneDocument, prefabPath: string, position?: Vec3): NodeEntry {
  const entry: NodeEntry = { id: uniqueId(doc, idBase(prefabPath)), prefab: prefabPath };
  if (position) entry.overrides = [{ component: "engine.Transform", field: "position", value: [...position] }];
  return entry;
}

/** An audio node: a Transform at `position` and an AudioSource playing the clip. */
export function audioNodeEntry(doc: SceneDocument, audioPath: string, position: Vec3 = [0, 0, 0]): NodeEntry {
  const name = fileName(audioPath).replace(/\.[^.]+$/, "");
  return {
    id: uniqueId(doc, idBase(audioPath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.AudioSource", data: { clip: `asset:${audioPath}` } },
    ],
  };
}

/**
 * A sprite node showing an image, or a slice of one (`images/sheet.png#walk_0`, named after the
 * slice): a Transform at `position` and a SpriteRenderer sized by pixels per unit.
 */
export function spriteNodeEntry(doc: SceneDocument, imagePath: string, position: readonly [number, number, number] = [0, 0, 0]): NodeEntry {
  const hash = imagePath.indexOf("#");
  const slice = hash >= 0 ? imagePath.slice(hash + 1) : null;
  const name = slice ?? fileName(imagePath).replace(/\.[^.]+$/, "");
  return {
    id: uniqueId(doc, slice !== null ? idBase(`${slice}.x`) : idBase(imagePath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.SpriteRenderer", data: { sprite: `asset:${imagePath}` } },
    ],
  };
}
