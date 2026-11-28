// The occlusion overlay (ADR 0162 E4, api-and-models §7), the Audio plugin's viewport tool `myco.audio.occlusion`: while
// the game plays, a line from each occluded AudioSource to the listener (the ray the occlusion pass casts) with a small
// cross where it meets a wall, coloured by how much the walls muffle it: the theme's success colour for open, warning
// for about half, danger for silent. The voices and their occlusion gain come from `Audio.debug()`; the voice's node
// comes from the playing AudioSource whose voice id it is (a one-shot or event voice has no node and isn't drawn); the
// hit point is a fresh ray from the same query the pass uses, since the debug row carries only the collider's name.
// Toggled from the Scene toolbar's Audio popover (`occlusionOverlayOn`, remembered per user). Off, it draws and costs nothing.
// What is drawn from the voices is `occlusionRays.ts`; this module gives it the play Worlds (`editor.scene.playWorlds`, ADR 0232).
import { effect } from "@preact/signals";
import type { ReadonlySignal } from "@preact/signals";
import type { GameObject } from "../../../engine";
import type { World } from "../../../engine/core/World";
import { rayGroupsFor, raycastInto, type WorldRayInto, type WorldRayQuery } from "../../../engine/core/worldServices";
import { mixer } from "../../../engine/audio/mixer";
import { addEditorOverlay, removeEditorOverlay, type EditorOverlay } from "../../../engine/editor";
import { Audio } from "../runtime/Audio";
import { listenerNode } from "../runtime/AudioListener";
import { AudioSource, worldKeyOf } from "../runtime/AudioSource";
import { type ViewportToolContribution, editor, persisted, theme } from "../../../editor/sdk";
import { occludedVoices, occlusionColors, occlusionOverlay, type OcclusionColors } from "./occlusionRays";

/** The tool's id. */
export const OCCLUSION_TOOL_ID = "myco.audio.occlusion";

/** The overlay's id on each play World. */
const PLAY_ID = "audio-occlusion";

/** Whether the overlay is drawn: the Scene toolbar Audio popover's checkbox (`AudioOverlayForm`). */
export const occlusionOverlayOn = persisted<boolean>("myco.editor.audioOcclusionOverlay", false);

// --- The play World's scene -------------------------------------------------------------------------------------

/** The node and its descendants. */
function subtree(node: GameObject, into: Set<GameObject> = new Set()): Set<GameObject> {
  into.add(node);
  for (const c of node.children) subtree(c, into);
  return into;
}

/** The overlay of one play World now, from `Audio.debug()`; empty while the toggle is off or the World has no listener. */
function worldOcclusionOverlay(world: World, colors: OcclusionColors, enabled: boolean): EditorOverlay {
  const none: EditorOverlay = { lines: [], handles: [] };
  if (!enabled) return none;
  const listener = listenerNode(world); // ADR 0462: the listener the audio system uses (always with a transform)
  const key = worldKeyOf(world);
  if (!listener || key === 0) return none;
  const info = Audio.debug();
  const voices = occludedVoices(info.voices, key);
  if (voices.length === 0) return none;
  const sources = new Map<number, AudioSource>();
  for (const s of world._componentsOfType(AudioSource)) if (s._voiceId !== 0) sources.set(s._voiceId, s);
  let groups: number | undefined;
  try {
    groups = rayGroupsFor(world, mixer.audioSettings.occlusion.layers ?? undefined);
  } catch {
    groups = undefined; // a layer the project doesn't define: the pass reports it; the overlay just casts at every layer
  }
  const out: WorldRayInto = { node: null, distance: 0, point: { x: 0, y: 0, z: 0 } };
  const pos = listener.transform!.worldPosition;
  return occlusionOverlay(
    voices,
    {
      worldKey: key,
      sourceOf(id) {
        const t = sources.get(id)?.node.transform;
        if (!t) return null;
        const p = t.worldPosition;
        return [p.x, p.y, p.z];
      },
      listener: [pos.x, pos.y, pos.z],
      hitOf(id, from, to) {
        const source = sources.get(id);
        if (!source) return null;
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const len = Math.hypot(dx, dy, dz);
        if (!(len > 1e-6)) return null;
        const exclude = subtree(source.node);
        exclude.add(listener);
        const query: WorldRayQuery = { groups, excludeNodes: exclude, includeSensors: false };
        const ok = raycastInto(world, out, { x: from[0], y: from[1], z: from[2] }, { x: dx / len, y: dy / len, z: dz / len }, len, query);
        return ok ? [out.point.x, out.point.y, out.point.z] : null;
      },
    },
    colors,
  );
}

/** Draws the overlay in every World of the play session while `enabled` is on. Returns the function that removes it. */
function installOcclusionOverlay(enabled: ReadonlySignal<boolean>): () => void {
  let playWorlds: readonly World[] = [];
  const stop = effect(() => {
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    playWorlds = editor.scene.playWorlds;
    for (const w of playWorlds) addEditorOverlay(w, PLAY_ID, () => worldOcclusionOverlay(w, occlusionColors(theme.peek()), enabled.peek()), "other");
  });
  return () => {
    stop();
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    playWorlds = [];
  };
}

/** The scene view's occlusion tool: rays to occluded sources while playing, toggled from the Scene toolbar's Audio popover. */
export const occlusionTool: ViewportToolContribution = {
  id: OCCLUSION_TOOL_ID,
  install: () => installOcclusionOverlay(occlusionOverlayOn),
};
