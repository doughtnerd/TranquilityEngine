// New test scenes (ADR 0333; the prototype's New menu, S:1260): Blank (one listener, "Player 1"), From current test scene
// (a copy), From open game scene (a blank scene whose `base` names the game scene: its audio components and colliders
// load read-only underneath when it plays) and From take… (the listener and emitter positions at a moment of a take,
// from its POSE requests, each emitter playing what the take last started on it, ADR 0334).
//
// Pure: no DOM, no signals.
import { emptyAudioTestScene } from "../../../engine/audio/spatial/testScene";
import type { AudioTestScene, StaticEmitter } from "../../../engine/audio/spatial/testSceneTypes";
import { LISTENER_EMITTER, type TakeMeta, type TakeRequest } from "../../../engine/audio/take/types";
import { uniqueName } from "../../../engine/core/uniqueName";

export type NewSceneKind = "blank" | "current" | "game" | "take";

export const NEW_SCENE_MENU: readonly { readonly id: NewSceneKind; readonly label: string; readonly hint: string }[] = [
  { id: "blank", label: "Blank scene", hint: "A listener and nothing else" },
  { id: "current", label: "From current test scene", hint: "A copy of the open scene" },
  { id: "game", label: "From open game scene…", hint: "The game scene's emitters, colliders and zones underneath, read-only" },
  { id: "take", label: "From take…", hint: "Positions at a moment of a take" },
];

/** A blank scene: one listener at the origin, in `folder`. */
export const blankScene = (folder = ""): AudioTestScene => ({ ...emptyAudioTestScene(), folder });

/** A copy of `scene`, in `folder` (default its own). */
export const copyScene = (scene: AudioTestScene, folder = scene.folder): AudioTestScene => ({ ...structuredClone(scene), folder });

/** A blank scene over game scene `base`. */
export const gameScene = (base: string, folder = ""): AudioTestScene => ({ ...blankScene(folder), base });

/** Game scenes the project has (`*.scene.json`), for From open game scene. */
export const gameScenePaths = (files: readonly string[]): string[] => files.filter((f) => f.toLowerCase().endsWith(".scene.json")).sort();

/** What a take says at a moment, for From take. */
export interface TakeView {
  readonly meta: Pick<TakeMeta, "emitters">;
  /** The take's requests in time order. */
  readonly requests: readonly TakeRequest[];
}

/**
 * A scene with the take's listener and emitters where they were at `t` seconds: the last POSE of each at or before `t`
 * (the listener is emitter 0), each emitter as a static emitter playing the last sound the take started on it before
 * `t` ("" if none), named from the take's emitter names. Emitters with no pose by `t` are left out.
 */
export function sceneFromTake(take: TakeView, t: number, folder = ""): AudioTestScene {
  const poses = new Map<number, Extract<TakeRequest, { kind: "pose" }>>();
  const sounds = new Map<number, string>();
  for (const q of take.requests) {
    if (q.t > t) break;
    if (q.kind === "pose") poses.set(q.emitter, q);
    else if (q.kind === "play" && q.emitter !== null) sounds.set(q.emitter, q.path);
  }
  const scene = blankScene(folder);
  const listener = poses.get(LISTENER_EMITTER);
  if (listener) {
    const f = listener.forward;
    const yaw = f && (f.x !== 0 || f.z !== 0) ? Math.round((Math.atan2(f.x, f.z) * 180) / Math.PI) : 0;
    scene.listeners = [{ ...scene.listeners[0]!, position: { ...listener.position }, yaw }];
  }
  const names: string[] = [];
  const ids = [...poses.keys()].filter((id) => id !== LISTENER_EMITTER).sort((a, b) => a - b);
  scene.emitters = ids.map((id, i): StaticEmitter => {
    const pose = poses.get(id)!;
    const label = take.meta.emitters[id] ?? `Emitter ${id}`;
    const name = uniqueName(label.slice(label.lastIndexOf("/") + 1) || `Emitter ${id}`, names);
    names.push(name);
    return { id: `emitter${i + 1}`, name, hidden: false, locked: false, kind: "static", position: { ...pose.position }, sound: sounds.get(id) ?? "", volume: 0 };
  });
  return scene;
}

/** "0:41" for 41 s (the From take dialog's readout). */
export const takeClock = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
