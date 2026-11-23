// The Outline panel's model (the prototype's outline, B.3): the scene's objects in groups by kind (alphabetical by group
// name, as the prototype lists them), each with its count, filtered by name or group, and what the plan shows: hidden
// objects vanish from it except the listener that hears the scene.
//
// Pure: no DOM, no signals.
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { activeListener, allObjects, type ObjectKind, type SceneObject } from "./sceneEdits";

export const GROUP_TITLE: Readonly<Record<ObjectKind, string>> = {
  sound2d: "2D sounds",
  audioZone: "Audio zones",
  emitter: "Emitters",
  listener: "Listeners",
  obstacle: "Obstacles",
  reverbZone: "Reverb zones",
};

export interface OutlineRow {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly locked: boolean;
  /** The listener that hears the scene. */
  readonly active: boolean;
  /** A moving emitter. */
  readonly moving: boolean;
}

export interface OutlineGroup {
  readonly kind: ObjectKind;
  readonly title: string;
  /** Objects of this kind in the scene (before the filter). */
  readonly count: number;
  readonly rows: readonly OutlineRow[];
}

/** The groups in the prototype's (alphabetical) order, each filtered by `filter` (name or group title); empty groups drop while filtering. */
export function outlineGroups(scene: AudioTestScene, filter = ""): OutlineGroup[] {
  const q = filter.trim().toLowerCase();
  const active = activeListener(scene).id;
  const all = allObjects(scene);
  const kinds = (Object.keys(GROUP_TITLE) as ObjectKind[]).sort((a, b) => GROUP_TITLE[a].localeCompare(GROUP_TITLE[b]));
  const out: OutlineGroup[] = [];
  for (const kind of kinds) {
    const mine = all.filter((o) => o.kind === kind);
    const title = GROUP_TITLE[kind];
    const groupHit = q !== "" && title.toLowerCase().includes(q);
    const rows = mine
      .filter((o) => q === "" || groupHit || o.obj.name.toLowerCase().includes(q))
      .map((o): OutlineRow => ({ id: o.obj.id, name: o.obj.name, hidden: o.obj.hidden, locked: o.obj.locked, active: o.obj.id === active, moving: o.kind === "emitter" && o.obj.kind === "moving" }));
    if (q !== "" && rows.length === 0) continue;
    out.push({ kind, title, count: mine.length, rows });
  }
  return out;
}

/** Whether the plan draws an object: not hidden, or the listener that hears the scene. */
export const shownInPlan = (scene: AudioTestScene, o: SceneObject): boolean => !o.obj.hidden || o.obj.id === activeListener(scene).id;
