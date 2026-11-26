// The Spatial screen's edits of a test scene (ADR 0347 `*.audioscene.json`; the prototype's editing, S:1525-1626): find
// an object by id, move it (a moving emitter slides along its route), reshape and turn boxes, rename, hide, lock,
// delete, duplicate and paste, the active listener and route edits. Every edit a user can get refused returns
// `{ next } | { refused }` (ADR 0307, 0313) and the screen applies it as one labelled undo step on the scene document.
//
// Pure: no DOM, no signals.
import { AUDIO_SCENE_LIMITS } from "../../../engine/audio/spatial/testScene";
import type {
  AudioTestScene,
  MovingEmitter,
  SceneBox,
  SceneObjectBase,
  StaticEmitter,
  Test2dSound,
  TestAudioZone,
  TestEmitter,
  TestListener,
  TestObstacle,
  TestReverbZone,
  Vec3,
} from "../../../engine/audio/spatial/testSceneTypes";
import { uniqueName } from "../../../engine/core/uniqueName";
import { insertWaypoint, moveBox, moveWaypoint, projectOnRoute, removeWaypoint, shiftRoute, snap, snapPoint, type P2, type RouteEdit } from "./geometry";

export type EditResult<T> = { readonly next: T } | { readonly refused: string };
const accept = <T>(next: T): EditResult<T> => ({ next });
const refuse = (refused: string): { readonly refused: string } => ({ refused });

/** The lists of a scene, one per kind of object. */
export type ObjectKind = "listener" | "emitter" | "obstacle" | "reverbZone" | "audioZone" | "sound2d";

export type SceneObject =
  | { readonly kind: "listener"; readonly obj: TestListener }
  | { readonly kind: "emitter"; readonly obj: TestEmitter }
  | { readonly kind: "obstacle"; readonly obj: TestObstacle }
  | { readonly kind: "reverbZone"; readonly obj: TestReverbZone }
  | { readonly kind: "audioZone"; readonly obj: TestAudioZone }
  | { readonly kind: "sound2d"; readonly obj: Test2dSound };

const LISTS = { listener: "listeners", emitter: "emitters", obstacle: "obstacles", reverbZone: "reverbZones", audioZone: "audioZones", sound2d: "sounds2d" } as const;
type ListKey = (typeof LISTS)[ObjectKind];

/** What each kind is called in labels and messages. */
export const KIND_NOUN: Readonly<Record<ObjectKind, string>> = {
  listener: "listener",
  emitter: "emitter",
  obstacle: "obstacle",
  reverbZone: "reverb zone",
  audioZone: "audio zone",
  sound2d: "2D sound",
};

/** "an emitter", "a listener". */
export const aKind = (kind: ObjectKind): string => `${/^[aeiou]/.test(KIND_NOUN[kind]) ? "an" : "a"} ${KIND_NOUN[kind]}`;

/** Every object of a scene, kind by kind. */
export function allObjects(scene: AudioTestScene): SceneObject[] {
  return [
    ...scene.listeners.map((obj) => ({ kind: "listener", obj }) as const),
    ...scene.emitters.map((obj) => ({ kind: "emitter", obj }) as const),
    ...scene.obstacles.map((obj) => ({ kind: "obstacle", obj }) as const),
    ...scene.reverbZones.map((obj) => ({ kind: "reverbZone", obj }) as const),
    ...scene.audioZones.map((obj) => ({ kind: "audioZone", obj }) as const),
    ...scene.sounds2d.map((obj) => ({ kind: "sound2d", obj }) as const),
  ];
}

/** The object with id `id`, or null. */
export function findObject(scene: AudioTestScene, id: string): SceneObject | null {
  return allObjects(scene).find((o) => o.obj.id === id) ?? null;
}

/** The listener that hears the scene. */
export const activeListener = (scene: AudioTestScene): TestListener => scene.listeners.find((l) => l.id === scene.activeListener) ?? scene.listeners[0]!;

/** A box-shaped object's box, or null. */
export function boxOf(o: SceneObject): SceneBox | null {
  return o.kind === "obstacle" || o.kind === "reverbZone" || o.kind === "audioZone" ? o.obj.box : null;
}

/** Where an object is on the plan (a moving emitter at its start; a 2D sound nowhere). */
export function positionOf(o: SceneObject, at?: number): Vec3 | null {
  switch (o.kind) {
    case "listener":
      return o.obj.position;
    case "emitter":
      if (o.obj.kind === "static") return o.obj.position;
      return routePosition(o.obj, at ?? o.obj.start);
    case "sound2d":
      return null;
    default:
      return o.obj.box.center;
  }
}

function routePosition(e: MovingEmitter, u: number): Vec3 {
  // Arc-length walk, as `routePose` (kept here so this module's callers needn't build the out-object).
  let total = 0;
  for (let i = 1; i < e.route.length; i++) total += Math.hypot(e.route[i]!.x - e.route[i - 1]!.x, e.route[i]!.z - e.route[i - 1]!.z);
  const first = e.route[0] ?? { x: 0, y: 0, z: 0 };
  if (!(total > 0)) return { x: first.x, y: e.height, z: first.z };
  let left = Math.min(1, Math.max(0, u)) * total;
  for (let i = 1; i < e.route.length; i++) {
    const a = e.route[i - 1]!, b = e.route[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len <= 0) continue;
    if (left <= len || i === e.route.length - 1) {
      const t = Math.min(1, left / len);
      return { x: a.x + (b.x - a.x) * t, y: e.height, z: a.z + (b.z - a.z) * t };
    }
    left -= len;
  }
  const last = e.route[e.route.length - 1]!;
  return { x: last.x, y: e.height, z: last.z };
}

/** The plan points that frame a scene (Fit): every object's place, box corners and route; 2D sounds have none. */
export function framePoints(scene: AudioTestScene): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (const o of allObjects(scene)) {
    const b = boxOf(o);
    if (b) {
      out.push({ x: b.center.x - b.width / 2, z: b.center.z - b.depth / 2 }, { x: b.center.x + b.width / 2, z: b.center.z + b.depth / 2 });
      continue;
    }
    if (o.kind === "emitter" && o.obj.kind === "moving") out.push(...o.obj.route);
    const p = positionOf(o);
    if (p) out.push(p);
  }
  return out;
}

/** Replace object `id` with `update(obj)` in whichever list holds it. */
export function updateObject(scene: AudioTestScene, id: string, update: (o: SceneObject) => SceneObjectBase | EditResult<SceneObjectBase>): EditResult<AudioTestScene> {
  const found = findObject(scene, id);
  if (!found) return refuse("it isn't in the scene any more");
  const r = update(found);
  const nextObj = "refused" in r ? r : "next" in r ? r : accept(r);
  if ("refused" in nextObj) return nextObj;
  if (nextObj.next === found.obj) return accept(scene);
  const key: ListKey = LISTS[found.kind];
  return accept({ ...scene, [key]: (scene[key] as SceneObjectBase[]).map((x) => (x.id === id ? nextObj.next : x)) } as AudioTestScene);
}

const lockedRefusal = (o: SceneObject) => (o.obj.locked ? refuse(`${o.obj.name} is locked`) : null);

/**
 * Object `id` moved so its anchor is at `p` (snapped): a listener or static emitter's position, a box's centre, a moving
 * emitter's start (the nearest point of its route: it stays on its path). Locked objects don't move; 2D sounds have no place.
 */
export function moveObjectTo(scene: AudioTestScene, id: string, p: P2): EditResult<AudioTestScene> {
  return updateObject(scene, id, (o) => {
    const locked = lockedRefusal(o);
    if (locked) return locked;
    const s = snapPoint(p);
    switch (o.kind) {
      case "listener":
        return { ...o.obj, position: { ...o.obj.position, x: s.x, z: s.z } };
      case "emitter":
        if (o.obj.kind === "static") return { ...o.obj, position: { ...o.obj.position, x: s.x, z: s.z } };
        return { ...o.obj, start: Math.round(projectOnRoute(o.obj.route, p) * 1000) / 1000 };
      case "sound2d":
        return refuse("a 2D sound has no place in the scene");
      default:
        return { ...o.obj, box: moveBox(o.obj.box, p) } as unknown as SceneObjectBase;
    }
  });
}

/** Object `id`'s box replaced (a corner or the rotate knob dragged). */
export function setBox(scene: AudioTestScene, id: string, box: SceneBox): EditResult<AudioTestScene> {
  return updateObject(scene, id, (o) => {
    const locked = lockedRefusal(o);
    if (locked) return locked;
    if (!boxOf(o)) return refuse(`${aKind(o.kind)} has no box`);
    if (!(box.top - box.bottom >= AUDIO_SCENE_LIMITS.minHeight - 1e-9)) return refuse(`the bottom must be at least ${AUDIO_SCENE_LIMITS.minHeight} m below the top`);
    const [lo, hi] = AUDIO_SCENE_LIMITS.size;
    if (box.width < lo || box.depth < lo || box.width > hi || box.depth > hi) return refuse(`a box is ${lo}–${hi} m across`);
    return { ...o.obj, box } as unknown as SceneObjectBase;
  });
}

/** The height of a point object (a listener or static emitter's y, a moving emitter's path height). */
export function setHeight(scene: AudioTestScene, id: string, y: number): EditResult<AudioTestScene> {
  if (!Number.isFinite(y)) return refuse("a height is a number of metres");
  const [lo, hi] = AUDIO_SCENE_LIMITS.height;
  const h = Math.min(hi, Math.max(lo, snap(y, 0.1)));
  return updateObject(scene, id, (o) => {
    const locked = lockedRefusal(o);
    if (locked) return locked;
    if (o.kind === "listener") return { ...o.obj, position: { ...o.obj.position, y: h } };
    if (o.kind === "emitter") return o.obj.kind === "static" ? { ...o.obj, position: { ...o.obj.position, y: h } } : { ...o.obj, height: h };
    return refuse(`${aKind(o.kind)} has no single height`);
  });
}

/** A box's bottom and top; the bottom stays at least 0.5 m below the top. */
export function setBoxHeights(scene: AudioTestScene, id: string, bottom: number, top: number): EditResult<AudioTestScene> {
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return refuse("heights are numbers of metres");
  if (!(bottom < top - AUDIO_SCENE_LIMITS.minHeight + 1e-9)) return refuse(`the bottom must be at least ${AUDIO_SCENE_LIMITS.minHeight} m below the top`);
  const found = findObject(scene, id);
  const box = found && boxOf(found);
  if (!found || !box) return refuse("it has no box");
  return setBox(scene, id, { ...box, bottom: snap(bottom, 0.1), top: snap(top, 0.1) });
}

/** Rename object `id`; an empty name is refused. */
export function renameObject(scene: AudioTestScene, id: string, name: string): EditResult<AudioTestScene> {
  const clean = name.trim();
  if (clean === "") return refuse("a name can't be empty");
  return updateObject(scene, id, (o) => (o.obj.name === clean ? o.obj : { ...o.obj, name: clean }));
}

export const setHidden = (scene: AudioTestScene, id: string, hidden: boolean): EditResult<AudioTestScene> =>
  updateObject(scene, id, (o) => (o.obj.hidden === hidden ? o.obj : { ...o.obj, hidden }));

export const setLocked = (scene: AudioTestScene, id: string, locked: boolean): EditResult<AudioTestScene> =>
  updateObject(scene, id, (o) => (o.obj.locked === locked ? o.obj : { ...o.obj, locked }));

/** Hear the scene from listener `id`. */
export function setActiveListener(scene: AudioTestScene, id: string): EditResult<AudioTestScene> {
  if (!scene.listeners.some((l) => l.id === id)) return refuse("there's no such listener");
  return accept(scene.activeListener === id ? scene : { ...scene, activeListener: id });
}

/** Object `id` deleted. The last listener stays; deleting the active one makes the first other one active. */
export function deleteObject(scene: AudioTestScene, id: string): EditResult<AudioTestScene> {
  const found = findObject(scene, id);
  if (!found) return refuse("it isn't in the scene any more");
  if (found.kind === "listener" && scene.listeners.length <= 1) return refuse("a scene needs a listener");
  const key: ListKey = LISTS[found.kind];
  const next = { ...scene, [key]: (scene[key] as SceneObjectBase[]).filter((x) => x.id !== id) } as AudioTestScene;
  if (found.kind === "listener" && scene.activeListener === id) next.activeListener = next.listeners[0]!.id;
  return accept(next);
}

/** Every id in the scene. */
const idsOf = (scene: AudioTestScene): Set<string> => new Set(allObjects(scene).map((o) => o.obj.id));

/** A fresh id: `<prefix><n>`, the first n not taken. */
export function freshId(scene: AudioTestScene, prefix: string): string {
  const taken = idsOf(scene);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** The id prefix of each kind (the format's ids are free text; these read well in the debug rows). */
export const ID_PREFIX: Readonly<Record<ObjectKind, string>> = { listener: "listener", emitter: "emitter", obstacle: "obstacle", reverbZone: "reverb", audioZone: "zone", sound2d: "sound" };

/** `obj` added to its kind's list (refused past the format's limit). */
export function addObject(scene: AudioTestScene, o: SceneObject): EditResult<AudioTestScene> {
  const key: ListKey = LISTS[o.kind];
  const list = scene[key] as SceneObjectBase[];
  if (list.length >= AUDIO_SCENE_LIMITS.objects) return refuse(`a scene has at most ${AUDIO_SCENE_LIMITS.objects} ${KIND_NOUN[o.kind]}s`);
  if (idsOf(scene).has(o.obj.id)) return refuse(`another object has the id ${o.obj.id}`);
  return accept({ ...scene, [key]: [...list, o.obj] } as AudioTestScene);
}

/** How far a paste or duplicate lands from the original, metres (x and z). */
export const PASTE_OFFSET = 3;

/** A copy of `o` for `scene`: a fresh id, "<name> copy" (unique), moved by `PASTE_OFFSET`, unlocked. */
export function copyOf(scene: AudioTestScene, o: SceneObject, offset = PASTE_OFFSET): SceneObject {
  const names = allObjects(scene).filter((x) => x.kind === o.kind).map((x) => x.obj.name);
  const base = { id: freshId(scene, ID_PREFIX[o.kind]), name: uniqueName(`${o.obj.name} copy`, names), hidden: false, locked: false };
  const shift = (p: Vec3): Vec3 => ({ x: p.x + offset, y: p.y, z: p.z + offset });
  const shiftBox = (b: SceneBox): SceneBox => ({ ...b, center: shift(b.center) });
  switch (o.kind) {
    case "listener":
      return { kind: o.kind, obj: { ...o.obj, ...base, position: shift(o.obj.position) } };
    case "emitter":
      return o.obj.kind === "static"
        ? { kind: o.kind, obj: { ...o.obj, ...base, position: shift(o.obj.position) } }
        : { kind: o.kind, obj: { ...o.obj, ...base, route: shiftRoute(o.obj.route, offset, offset) } };
    case "obstacle":
      return { kind: o.kind, obj: { ...o.obj, ...base, box: shiftBox(o.obj.box) } };
    case "reverbZone":
      return { kind: o.kind, obj: { ...o.obj, ...base, box: shiftBox(o.obj.box), levelDefault: false } };
    case "audioZone":
      return { kind: o.kind, obj: { ...o.obj, ...base, box: shiftBox(o.obj.box) } };
    case "sound2d":
      return { kind: o.kind, obj: { ...o.obj, ...base } };
  }
}

/** Paste `o` (copied from this or another scene) into `scene`; returns the new scene and the copy's id. */
export function pasteObject(scene: AudioTestScene, o: SceneObject): EditResult<{ scene: AudioTestScene; id: string }> {
  const copy = copyOf(scene, o);
  const r = addObject(scene, copy);
  return "refused" in r ? r : accept({ scene: r.next, id: copy.obj.id });
}

/** Duplicate object `id` beside itself. */
export function duplicateObject(scene: AudioTestScene, id: string): EditResult<{ scene: AudioTestScene; id: string }> {
  const found = findObject(scene, id);
  return found ? pasteObject(scene, found) : refuse("it isn't in the scene any more");
}

// --- routes ----------------------------------------------------------------------------------------------------------

function editRoute(scene: AudioTestScene, id: string, edit: (route: readonly Vec3[]) => RouteEdit): EditResult<AudioTestScene> {
  return updateObject(scene, id, (o) => {
    if (o.kind !== "emitter" || o.obj.kind !== "moving") return refuse("only a moving emitter has a path");
    const locked = lockedRefusal(o);
    if (locked) return locked;
    const r = edit(o.obj.route);
    return "refused" in r ? r : { ...o.obj, route: r.next };
  });
}

export const moveRoutePoint = (scene: AudioTestScene, id: string, i: number, p: P2) => editRoute(scene, id, (r) => moveWaypoint(r, i, p));
export const insertRoutePoint = (scene: AudioTestScene, id: string, segment: number) => editRoute(scene, id, (r) => insertWaypoint(r, segment, AUDIO_SCENE_LIMITS.routePoints));
export const removeRoutePoint = (scene: AudioTestScene, id: string, i: number) => editRoute(scene, id, (r) => removeWaypoint(r, i));

// --- typed field updates ---------------------------------------------------------------------------------------------

/** Fields of a static or moving emitter that aren't its place. */
export type EmitterPatch = Partial<Pick<StaticEmitter, "sound" | "volume" | "output">> & Partial<Pick<MovingEmitter, "speed" | "start" | "loop">>;

/** An emitter with `output` "" dropped (it plays on its sound's own bus). */
const tidyOutput = <T extends { output?: string }>(e: T): T => {
  if (e.output !== "") return e;
  const { output: _o, ...rest } = e;
  return rest as T;
};

export function patchEmitter(scene: AudioTestScene, id: string, patch: EmitterPatch): EditResult<AudioTestScene> {
  return updateObject(scene, id, (o) => {
    if (o.kind !== "emitter") return refuse("it isn't an emitter");
    if (o.obj.kind === "static") {
      const { speed: _s, start: _a, loop: _l, ...rest } = patch;
      return tidyOutput({ ...o.obj, ...rest });
    }
    return tidyOutput({ ...o.obj, ...patch });
  });
}

export const patchObstacle = (scene: AudioTestScene, id: string, patch: Partial<Pick<TestObstacle, "material">>) =>
  updateObject(scene, id, (o) => (o.kind === "obstacle" ? { ...o.obj, ...patch } : refuse("it isn't an obstacle")));

export const patchReverbZone = (scene: AudioTestScene, id: string, patch: Partial<Pick<TestReverbZone, "preset" | "wet" | "priority" | "levelDefault">>): EditResult<AudioTestScene> => {
  const r = updateObject(scene, id, (o) => (o.kind === "reverbZone" ? { ...o.obj, ...patch } : refuse("it isn't a reverb zone")));
  // One level default at a time: making a zone the level's default clears it on the others.
  if ("refused" in r || !patch.levelDefault) return r;
  return accept({ ...r.next, reverbZones: r.next.reverbZones.map((z) => (z.id !== id && z.levelDefault ? { ...z, levelDefault: false } : z)) });
};

export const patchAudioZone = (scene: AudioTestScene, id: string, patch: Partial<Pick<TestAudioZone, "sound" | "heard" | "feather" | "volume">>) =>
  updateObject(scene, id, (o) => (o.kind === "audioZone" ? { ...o.obj, ...patch } : refuse("it isn't an audio zone")));

export const patchSound2d = (scene: AudioTestScene, id: string, patch: Partial<Pick<Test2dSound, "sound" | "volume" | "output">>) =>
  updateObject(scene, id, (o) => (o.kind === "sound2d" ? { ...o.obj, ...patch } : refuse("it isn't a 2D sound")));

export const patchListener = (scene: AudioTestScene, id: string, patch: Partial<Pick<TestListener, "yaw">>) =>
  updateObject(scene, id, (o) => (o.kind === "listener" ? { ...o.obj, ...patch } : refuse("it isn't a listener")));

/** The sound an object plays ("" none; null for a listener, obstacle or reverb zone). */
export function soundOf(o: SceneObject): string | null {
  return o.kind === "emitter" || o.kind === "audioZone" || o.kind === "sound2d" ? o.obj.sound : null;
}

/** A game scene file (`*.scene.json`): what a test scene may name as its base. */
export const isGameScenePath = (path: string): boolean => path.endsWith(".scene.json") && !path.endsWith(".audioscene.json");

/**
 * ADR 0347's base game scene: play this test scene over a level of the project (`path`, a `*.scene.json`), whose audio
 * components and colliders are drawn read-only underneath and heard with the scene; null plays without one.
 */
export function setBaseScene(scene: AudioTestScene, path: string | null): EditResult<AudioTestScene> {
  if (path !== null && !isGameScenePath(path)) return { refused: `${path} isn't a game scene (a .scene.json file)` };
  if ((scene.base ?? null) === path) return accept(scene);
  return accept({ ...scene, base: path });
}
