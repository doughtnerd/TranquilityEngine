// The Scene view's tools (the prototype's palette and placement, S:1479-1489, 1565-1571): Select, then a tool per kind
// of object. A placing tool puts its object where you click with the prototype's defaults and goes back to Select; a
// Moving emitter opens its path for editing; 2D sound adds at once (it has no place). Esc ends path editing, then goes
// back to Select, then clears the selection.
//
// Pure: no DOM, no signals.
import type { AudioTestScene, MovingEmitter, SceneBox, StaticEmitter, Test2dSound, TestAudioZone, TestListener, TestObstacle, TestReverbZone } from "../../../engine/audio/spatial/testSceneTypes";
import { uniqueName } from "../../../engine/core/uniqueName";
import { snap, snapPoint, type P2 } from "./geometry";
import { activeListener, addObject, freshId, ID_PREFIX, type EditResult, type SceneObject } from "./sceneEdits";

export type Tool = "select" | "emitter" | "moving" | "listener" | "obstacle" | "reverbZone" | "audioZone" | "sound2d";

export interface ToolInfo {
  readonly id: Tool;
  readonly label: string;
  /** A short glyph for the palette button. */
  readonly glyph: string;
  readonly hint: string;
}

/** The palette, top to bottom. */
export const TOOLS: readonly ToolInfo[] = [
  { id: "select", label: "Select", glyph: "↖", hint: "Select and move (Esc)" },
  { id: "emitter", label: "Emitter", glyph: "◉", hint: "Click in the scene to place an emitter" },
  { id: "moving", label: "Moving emitter", glyph: "⤳", hint: "Click to place an emitter that travels a path" },
  { id: "listener", label: "Listener", glyph: "☺", hint: "Click to place a listener" },
  { id: "obstacle", label: "Obstacle", glyph: "▮", hint: "Click to place an obstacle that blocks sound" },
  { id: "reverbZone", label: "Reverb zone", glyph: "▢", hint: "Click to place a reverb zone" },
  { id: "audioZone", label: "Audio zone", glyph: "≋", hint: "Click to place an area that plays a sound" },
  { id: "sound2d", label: "2D sound", glyph: "♪", hint: "Add a sound heard without a place (music, a bed)" },
];

export interface ToolState {
  readonly tool: Tool;
  /** The moving emitter whose path is being edited (null: none). */
  readonly pathEdit: string | null;
}

export const INITIAL_TOOLS: ToolState = { tool: "select", pathEdit: null };

/** Pick a tool: a placing tool ends path editing; Select keeps it. */
export const pickTool = (s: ToolState, tool: Tool): ToolState => ({ tool, pathEdit: tool === "select" ? s.pathEdit : null });

/** Whether a tool places by clicking in the scene. */
export const placesByClick = (tool: Tool): boolean => tool !== "select" && tool !== "sound2d";

/** After placing: back to Select; a moving emitter's path opens for editing. */
export const afterPlace = (tool: Tool, id: string): ToolState => ({ tool: "select", pathEdit: tool === "moving" ? id : null });

/** Esc: end path editing; else back to Select; else clear the selection (`deselect`). */
export function escape(s: ToolState): { state: ToolState; deselect: boolean } {
  if (s.pathEdit) return { state: { ...s, pathEdit: null }, deselect: false };
  if (s.tool !== "select") return { state: INITIAL_TOOLS, deselect: false };
  return { state: s, deselect: true };
}

// --- placement -------------------------------------------------------------------------------------------------------

/** Defaults the prototype places with. */
export const PLACEMENT = {
  /** Moving emitter: speed m/s, start fraction, height above the listener, route half-length. */
  moving: { speed: 8, start: 0.5, above: 4, half: 12 },
  obstacle: { width: 10, depth: 4, height: 6 },
  reverbZone: { width: 20, depth: 14, height: 10, preset: "forest", priority: 2, wet: -16 },
  audioZone: { width: 20, depth: 8, height: 10, feather: 5 },
  sound2d: { volume: -6 },
} as const;

export interface PlaceContext {
  /** The bottom of the elevation slab (boxes start there). */
  readonly slabLow: number;
  /** The occlusion material a new obstacle gets (the project's default). */
  readonly material: string;
  /** The project's buses, for a 2D sound's output. */
  readonly buses: readonly string[];
}

const namesOf = (list: readonly { name: string }[]) => list.map((x) => x.name);
const numbered = (stem: string, list: readonly { name: string }[]) => uniqueName(`${stem} ${list.length + 1}`, namesOf(list));
const box = (at: P2, width: number, depth: number, bottom: number, height: number): SceneBox => ({ center: { x: at.x, y: 0, z: at.z }, width, depth, yaw: 0, bottom: snap(bottom, 0.1), top: snap(bottom + height, 0.1) });

/** The object `tool` places at `at` (snapped), with the prototype's defaults. */
export function newObject(scene: AudioTestScene, tool: Exclude<Tool, "select">, at: P2, ctx: PlaceContext): SceneObject {
  const p = snapPoint(at);
  const ly = activeListener(scene).position.y;
  const base = (kind: SceneObject["kind"], name: string) => ({ id: freshId(scene, ID_PREFIX[kind]), name, hidden: false, locked: false });
  switch (tool) {
    case "emitter": {
      const obj: StaticEmitter = { ...base("emitter", numbered("Emitter", scene.emitters)), kind: "static", position: { x: p.x, y: ly, z: p.z }, sound: "", volume: 0 };
      return { kind: "emitter", obj };
    }
    case "moving": {
      const m = PLACEMENT.moving;
      const obj: MovingEmitter = {
        ...base("emitter", uniqueName(`Moving emitter ${scene.emitters.filter((e) => e.kind === "moving").length + 1}`, namesOf(scene.emitters))),
        kind: "moving",
        route: [{ x: p.x - m.half, y: 0, z: p.z }, { x: p.x, y: 0, z: p.z }, { x: p.x + m.half, y: 0, z: p.z }],
        height: snap(ly + m.above, 0.1), speed: m.speed, start: m.start, loop: true, sound: "", volume: 0,
      };
      return { kind: "emitter", obj };
    }
    case "listener": {
      const obj: TestListener = { ...base("listener", uniqueName(`Player ${scene.listeners.length + 1}`, namesOf(scene.listeners))), position: { x: p.x, y: ly, z: p.z }, yaw: 0 };
      return { kind: "listener", obj };
    }
    case "obstacle": {
      const d = PLACEMENT.obstacle;
      const obj: TestObstacle = { ...base("obstacle", numbered("Obstacle", scene.obstacles)), box: box(p, d.width, d.depth, ctx.slabLow, d.height), material: ctx.material };
      return { kind: "obstacle", obj };
    }
    case "reverbZone": {
      const d = PLACEMENT.reverbZone;
      const obj: TestReverbZone = { ...base("reverbZone", numbered("Zone", scene.reverbZones)), box: box(p, d.width, d.depth, ctx.slabLow, d.height), preset: d.preset, wet: d.wet, priority: d.priority, levelDefault: false };
      return { kind: "reverbZone", obj };
    }
    case "audioZone": {
      const d = PLACEMENT.audioZone;
      const obj: TestAudioZone = { ...base("audioZone", numbered("Audio zone", scene.audioZones)), box: box(p, d.width, d.depth, ctx.slabLow, d.height), sound: "", heard: "edge", feather: d.feather, volume: 0 };
      return { kind: "audioZone", obj };
    }
    case "sound2d": {
      // The first is the music; later ones are ambience beds (the prototype's), on those buses when the mix has them.
      const first = scene.sounds2d.length === 0;
      const want = first ? "Music" : "Ambience";
      const output = ctx.buses.includes(want) ? want : (ctx.buses[0] ?? "Master");
      const name = first ? uniqueName("Music", namesOf(scene.sounds2d)) : numbered("2D sound", scene.sounds2d);
      const obj: Test2dSound = { ...base("sound2d", name), sound: "", volume: PLACEMENT.sound2d.volume, output };
      return { kind: "sound2d", obj };
    }
  }
}

/** Place `tool`'s object at `at`: the next scene and the new object's id. */
export function place(scene: AudioTestScene, tool: Exclude<Tool, "select">, at: P2, ctx: PlaceContext): EditResult<{ scene: AudioTestScene; id: string }> {
  const o = newObject(scene, tool, at, ctx);
  const r = addObject(scene, o);
  return "refused" in r ? r : { next: { scene: r.next, id: o.obj.id } };
}

/** The undo label of placing with `tool` (the prototype's words). */
export const placeLabel = (tool: Exclude<Tool, "select">): string => `Add ${TOOLS.find((t) => t.id === tool)!.label.toLowerCase().replace("2d", "2D")}`;
