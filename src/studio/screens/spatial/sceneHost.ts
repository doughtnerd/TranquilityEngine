// What the Scene view needs from its owner (the screen over the real page, or a story's local state): the scene and the
// screen's view state, and the actions it calls. The view draws and turns pointer and key input into these calls; the
// rules are the pure models (`pointerModel.ts`, `tools.ts`, `elevation.ts`, `viewTransform.ts`).
import type { BaseSceneImport } from "../../../engine/audio/spatial/baseScene";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import type { TestSceneMotionRow, TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import type { Slab } from "./elevation";
import type { P2 } from "./geometry";
import type { EditResult } from "./sceneEdits";
import type { Tool, ToolState } from "./tools";
import type { Size, View } from "./viewTransform";

export interface SceneHost {
  readonly scene: AudioTestScene;
  /** The scene's base game scene as imported (drawn read-only under the scene), or null when it names none. */
  readonly base?: BaseSceneImport | null;
  /** The scene file (the view's `data-asset-document`, so the History popover and Ctrl+Z follow it). */
  readonly path: string;
  readonly readOnly: boolean;
  readonly selected: string | null;
  select(id: string | null): void;
  readonly tools: ToolState;
  setTools(t: ToolState): void;
  readonly view: View;
  setView(v: View): void;
  setSize(s: Size): void;
  fit(): void;
  readonly slab: Slab;
  setSlab(s: Slab): void;
  readonly sideView: boolean;
  setSideView(on: boolean): void;
  /** An object hovered in the elevation strip's menu (highlighted on the plan). */
  readonly hover: string | null;
  setHover(id: string | null): void;
  /** The node being renamed in place. */
  readonly renaming: string | null;
  setRenaming(id: string | null): void;
  /** The audition: playing, the readout, and whether an object is silenced (muted or not soloed). */
  readonly playing: boolean;
  readonly voices: readonly TestSceneVoiceRow[];
  /** Where each emitter is now while playing (`liveMotion.ts`); empty or absent when stopped (moving emitters at their start). */
  readonly motion?: readonly TestSceneMotionRow[];
  silenced(id: string): boolean;
  readonly solo: string | null;
  /** Apply a scene edit as one labelled step (`drag`: coalesce until `endDrag`). */
  edit(label: string, edit: (s: AudioTestScene) => EditResult<AudioTestScene>, drag?: boolean): boolean;
  endDrag(): void;
  place(tool: Exclude<Tool, "select">, at: P2, slabLow: number): void;
  remove(id: string): void;
  soloToggle(id: string): void;
  muteToggle(id: string): void;
  editAttenuation(id: string): void;
  /** Why Edit attenuation… can't open for emitter `id` (its tooltip), or null when it can (`whyNotEditAttenuation`). */
  whyNotEditAttenuation(id: string): string | null;
  playAll(listener: string): void;
  listenHere(listener: string): void;
}
