/**
 * Contract (ADR 0347): a spatial test scene, `*.audioscene.json` (`myco.audioscene@1`), a Studio asset. The Studio plays
 * one by building a headless World from it with the engine's own audio components. Coordinates are metres in the
 * engine's world space (x right, y up, z forward; the Studio's top-down view shows x/z, height is y).
 *
 * Pure; no plugin, no DOM.
 */

import type { OcclusionCurves } from "../occlusionCurves";

export const AUDIO_SCENE_FORMAT = "myco.audioscene@1";
export const AUDIO_SCENE_SUFFIX = ".audioscene.json";

export interface Vec3 { x: number; y: number; z: number }

/** Shared by every object in a scene. */
export interface SceneObjectBase {
  id: string;
  name: string;
  hidden: boolean;
  locked: boolean;
}

export interface TestListener extends SceneObjectBase { position: Vec3; /** Yaw in degrees, 0 = facing +z. */ yaw: number }

export interface StaticEmitter extends SceneObjectBase {
  kind: "static";
  position: Vec3;
  /** A playlist or sample path. */
  sound: string;
  /** dB. */
  volume: number;
  /** The Mixer bus it plays on (picked here, routed in the Mixer); absent plays on its sound's own (a playlist's output, else Master). */
  output?: string;
}
export interface MovingEmitter extends SceneObjectBase {
  kind: "moving";
  /** Waypoints on the ground plane (y ignored); at least 2. */
  route: Vec3[];
  /** Height above the route, m. */
  height: number;
  /** m/s. */
  speed: number;
  /** 0..1 along the route at start. */
  start: number;
  loop: boolean;
  sound: string;
  volume: number;
  /** As `StaticEmitter.output`. */
  output?: string;
}
export type TestEmitter = StaticEmitter | MovingEmitter;

/** A rotated box: centre, size (width x, depth z), yaw (deg), bottom/top heights. */
export interface SceneBox { center: Vec3; width: number; depth: number; yaw: number; bottom: number; top: number }

export interface TestObstacle extends SceneObjectBase { box: SceneBox; /** An occlusion material name (audio.json settings). */ material: string }
export interface TestReverbZone extends SceneObjectBase { box: SceneBox; preset: string; /** dB. */ wet: number; priority: number; levelDefault: boolean }
export interface TestAudioZone extends SceneObjectBase { box: SceneBox; sound: string; heard: "edge" | "inside"; feather: number; volume: number }
export interface Test2dSound extends SceneObjectBase { sound: string; volume: number; output: string }

export interface AudioTestScene {
  format: typeof AUDIO_SCENE_FORMAT;
  /** Folder path in the Scenes tree, "" = top level. */
  folder: string;
  listeners: TestListener[];
  /** The listener that hears the scene. */
  activeListener: string;
  emitters: TestEmitter[];
  obstacles: TestObstacle[];
  reverbZones: TestReverbZone[];
  audioZones: TestAudioZone[];
  sounds2d: Test2dSound[];
  /** A game scene whose audio components and colliders load read-only underneath. */
  base: string | null;
  /** A/B replacement of a base scene's sounds: component path → playlist or sample. */
  replace: Record<string, string>;
  /**
   * ADR 0362 item 6: the scene's own settings. `occlusion.curves` (how blocked a path is → volume and low-pass) stand in
   * for the project's while the scene plays. Absent: the project's settings.
   */
  settings?: { occlusion?: { curves?: OcclusionCurves } };
}

export interface AudioTestSceneParse { scene: AudioTestScene; problems: string[] }
