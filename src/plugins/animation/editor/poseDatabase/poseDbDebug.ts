// The pose database debug view in the scene view (ADR 0373; T55): the viewport tool `myco.animation.matchDebug`. While the
// editor plays and the view is on (the toggle in the Pose Database tool, remembered per user), every play World draws the
// selected Animator's predicted trajectory, its matched frame's trajectory and a cross at the character, from the
// registered `MatchDebugSource` (`debugLogic.ts` says why a source has to be given). Off, it draws and costs nothing.
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { World } from "../../../../engine/core/World";
import { Quaternion } from "../../../../engine/core/math";
import { GameObject } from "../../../../engine";
import { addEditorOverlay, listNodes, removeEditorOverlay, type EditorOverlay } from "../../../../engine/editor";
import { editor, persisted, type ViewportToolContribution } from "../../../../editor/sdk";
import { Animator } from "../../runtime/components/Animator";
import { matchDebugWires, type CharacterPose, type MatchDebugSource, type MatchDebugState } from "./debugLogic";

/** The tool's id. */
export const MATCH_DEBUG_TOOL_ID = "myco.animation.matchDebug";

/** Whether the debug view is on (remembered per user). */
export const matchDebugView = persisted<boolean>("myco.animation.matchDebugView", false);

const source = signal<MatchDebugSource | null>(null);

/** The debugger (T52) or a core host change gives the view its data here (null: none). */
export function setMatchDebugSource(next: MatchDebugSource | null): void {
  source.value = next;
}

/** The source now, as a signal (the tool's note reads whether there is one). */
export const matchDebugSource: ReadonlySignal<MatchDebugSource | null> = source;

const PREDICTED = 0x4fc3f7;
const MATCHED = 0x9ccc65;
const CHARACTER = 0xffffff;

/** The character's pose: its node's world position and the yaw of its +Z axis. */
function characterPose(node: GameObject): CharacterPose | null {
  const t = node.transform;
  if (!t) return null;
  const p = t.worldPosition;
  const f = Quaternion.rotate(t.worldRotation, [0, 0, 1]);
  return { position: [p.x, p.y, p.z], yaw: Math.atan2(f.x, f.z) };
}

/** The nodes of `world` showing the selected nodes (by scene-file id), the selection mapped from the Editor World into a play World. */
function selectedIn(world: World): GameObject[] {
  const ids = new Set(editor.scene.selection.nodes().map((s) => s.path[s.path.length - 1]!));
  return listNodes(world).filter((n) => ids.has(n.id)).map((n) => n.node);
}

/** What one play World draws: each selected Animator that has match state. */
function worldOverlay(world: World, from: MatchDebugSource | null, on: boolean): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  if (!on || !from) return overlay;
  for (const node of selectedIn(world)) {
    if (!node.getComponent(Animator)) continue;
    const pose = characterPose(node);
    const state: MatchDebugState | null = pose ? from.read(node) : null;
    if (!pose || !state) continue;
    const wires = matchDebugWires(pose, state);
    for (const points of wires.predicted) overlay.lines.push({ points, closed: false, color: PREDICTED });
    for (const points of wires.matched) overlay.lines.push({ points, closed: false, color: MATCHED });
    for (const points of wires.character) overlay.lines.push({ points, closed: false, color: CHARACTER });
  }
  return overlay;
}

/** Draws the overlay in every World of the play session. Returns the function that removes it. */
function installMatchDebugOverlay(): () => void {
  let worlds: readonly World[] = [];
  const stop = effect(() => {
    for (const w of worlds) removeEditorOverlay(w, MATCH_DEBUG_TOOL_ID);
    worlds = editor.scene.playWorlds;
    for (const w of worlds) addEditorOverlay(w, MATCH_DEBUG_TOOL_ID, () => worldOverlay(w, source.peek(), matchDebugView.peek()), "other");
  });
  return () => {
    stop();
    for (const w of worlds) removeEditorOverlay(w, MATCH_DEBUG_TOOL_ID);
    worlds = [];
  };
}

/** The scene view's pose database debug tool: trajectories and the matched frame of the selected Animator while playing. */
export const matchDebugTool: ViewportToolContribution = {
  id: MATCH_DEBUG_TOOL_ID,
  install: () => installMatchDebugOverlay(),
};
