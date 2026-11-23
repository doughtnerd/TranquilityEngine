// Auditioning a test scene (ADR 0347: the Studio plays a test scene through the engine's own components): what the test
// scene player is given while the screen's Play is on, and how a scene edit reaches it. Solo and mute are audition
// state, not scene data: a silenced object's sound is left out of the scene the player builds. Edits that only move or
// reshape objects (and the active listener) go to the running player as `moveObject` poses, so the sound follows the
// drag; any other edit (a sound, a volume, an added or deleted object) rebuilds the player.
//
// Pure: no DOM, no signals.
import type { TestScenePose } from "../../../plugins/audio/runtime/testScene/player";
import type { AudioTestScene, SceneObjectBase } from "../../../engine/audio/spatial/testSceneTypes";
import { allObjects, boxOf, type SceneObject } from "./sceneEdits";

export interface AuditionState {
  /** The one object heard on its own (null: everything unmuted). */
  readonly solo: string | null;
  readonly muted: ReadonlySet<string>;
}

export const NO_AUDITION: AuditionState = { solo: null, muted: new Set() };

/** Whether object `id` is silent in the audition: muted, or another object is soloed. */
export const isSilenced = (a: AuditionState, id: string): boolean => a.muted.has(id) || (a.solo !== null && a.solo !== id);

/** Toggle mute on `id`. */
export function toggleMute(a: AuditionState, id: string): AuditionState {
  const muted = new Set(a.muted);
  if (muted.has(id)) muted.delete(id);
  else muted.add(id);
  return { ...a, muted };
}

/** Solo `id` (again: everything plays). */
export const toggleSolo = (a: AuditionState, id: string): AuditionState => ({ ...a, solo: a.solo === id ? null : id });

/** The scene the player builds: silenced emitters, audio zones and 2D sounds play nothing. */
export function auditionScene(scene: AudioTestScene, a: AuditionState): AudioTestScene {
  if (a.solo === null && a.muted.size === 0) return scene;
  const quiet = <T extends SceneObjectBase & { sound: string }>(list: T[]): T[] => list.map((o) => (isSilenced(a, o.id) ? { ...o, sound: "" } : o));
  return { ...scene, emitters: quiet(scene.emitters), audioZones: quiet(scene.audioZones), sounds2d: quiet(scene.sounds2d) };
}

/** How a running player catches up with an edit. */
export type LiveUpdate =
  | { readonly kind: "none" }
  | { readonly kind: "rebuild" }
  | { readonly kind: "poses"; readonly poses: readonly { readonly id: string; readonly pose: TestScenePose }[]; readonly listener: string | null };

/** An object with its place taken out: what must match for a pose to be enough. */
function shapeless(o: SceneObject): unknown {
  const { name: _n, hidden: _h, locked: _l, ...rest } = o.obj as unknown as SceneObjectBase & Record<string, unknown>;
  const r = rest as Record<string, unknown>;
  delete r.position; delete r.yaw; delete r.box; delete r.route; delete r.height; delete r.start;
  return { kind: o.kind, ...r };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The pose that brings the player's object from `a` to `b`, or null when its place didn't change. */
function poseOf(a: SceneObject, b: SceneObject): TestScenePose | null {
  if (a.kind === "listener" && b.kind === "listener") {
    const pose: { position?: TestScenePose["position"]; yaw?: number } = {};
    if (!same(a.obj.position, b.obj.position)) pose.position = b.obj.position;
    if (a.obj.yaw !== b.obj.yaw) pose.yaw = b.obj.yaw;
    return Object.keys(pose).length ? pose : null;
  }
  if (a.kind === "emitter" && b.kind === "emitter") {
    if (a.obj.kind === "static" && b.obj.kind === "static") return same(a.obj.position, b.obj.position) ? null : { position: b.obj.position };
    if (a.obj.kind === "moving" && b.obj.kind === "moving") {
      const pose: { route?: TestScenePose["route"]; height?: number; at?: number } = {};
      if (!same(a.obj.route, b.obj.route)) pose.route = b.obj.route;
      if (a.obj.height !== b.obj.height) pose.height = b.obj.height;
      if (a.obj.start !== b.obj.start) pose.at = b.obj.start;
      return Object.keys(pose).length ? pose : null;
    }
    return null;
  }
  const ba = boxOf(a), bb = boxOf(b);
  return ba && bb && !same(ba, bb) ? { box: bb } : null;
}

/** How the player playing `before` (as auditioned) catches up with `after`. */
export function liveUpdate(before: AudioTestScene, after: AudioTestScene): LiveUpdate {
  if (before === after) return { kind: "none" };
  if (before.base !== after.base || !same(before.replace, after.replace)) return { kind: "rebuild" };
  const a = allObjects(before), b = allObjects(after);
  if (a.length !== b.length) return { kind: "rebuild" };
  const poses: { id: string; pose: TestScenePose }[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.obj.id !== y.obj.id || x.kind !== y.kind) return { kind: "rebuild" };
    if (x.kind === "emitter" && y.kind === "emitter" && x.obj.kind !== y.obj.kind) return { kind: "rebuild" };
    if (!same(shapeless(x), shapeless(y))) return { kind: "rebuild" };
    const pose = poseOf(x, y);
    if (pose) poses.push({ id: y.obj.id, pose });
  }
  const listener = before.activeListener !== after.activeListener ? after.activeListener : null;
  if (poses.length === 0 && listener === null) return { kind: "none" };
  return { kind: "poses", poses, listener };
}
