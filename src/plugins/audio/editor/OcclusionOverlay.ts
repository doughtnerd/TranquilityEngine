// The occlusion overlay (ADR 0162 E4, api-and-models §7), the Audio plugin's viewport tool `myco.audio.occlusion`: while
// the game plays, a line from each occluded AudioSource to the listener (the ray the occlusion pass casts) with a small
// cross where it meets a wall, coloured by how much the walls muffle it: the theme's success colour for open, warning
// for about half, danger for silent. The voices and their occlusion gain come from `Audio.debug()`; the voice's node
// comes from the playing AudioSource whose voice id it is (a one-shot or event voice has no node and isn't drawn); the
// hit point is a fresh ray from the same query the pass uses, since the debug row carries only the collider's name.
// Toggled from the Audio Debug panel (`occlusionOverlayOn`, remembered per user). Off, it draws and costs nothing.
import { effect } from "@preact/signals";
import type { ReadonlySignal } from "@preact/signals";
import type { GameObject } from "../../../engine";
import type { World } from "../../../engine/core/World";
import { rayGroupsFor, raycastInto, type WorldRayInto, type WorldRayQuery } from "../../../engine/core/worldServices";
import { mixer } from "../../../engine/audio/mixer";
import { addEditorOverlay, removeEditorOverlay, type EditorOverlay } from "../../../engine/editor";
import { Camera } from "../../../engine/render/components";
import { Audio } from "../runtime/Audio";
import type { AudioDebugInfo } from "../runtime/backend";
import { AudioListener, listenerPose } from "../runtime/AudioListener";
import { AudioSource, worldKeyOf } from "../runtime/AudioSource";
import type { PlaySession } from "../../../editor/playMode";
import { playing as playSession } from "../../../editor/state";
import { type ViewportToolContribution, mix, parseHex, persisted, theme, type ThemeTokens } from "../../../editor/sdk";

/** The tool's id. */
export const OCCLUSION_TOOL_ID = "myco.audio.occlusion";

/** The overlay's id on each play World. */
const PLAY_ID = "audio-occlusion";

/** Whether the overlay is drawn: the Audio Debug panel's checkbox. */
export const occlusionOverlayOn = persisted<boolean>("myco.editor.audioOcclusionOverlay", false);

/** At most this many rays are drawn per World (the voices with the lowest occlusion gain first). */
export const MAX_RAYS = 48;

/** A voice is "occluded" when walls took more than this much of its gain (about 0.01 dB). */
const OPEN_GAIN = 0.9995;

type Vec = readonly [number, number, number];
type DebugVoice = AudioDebugInfo["voices"][number];

/** The three colours of the gradient, 0xRRGGBB. */
export interface OcclusionColors {
  open: number;
  half: number;
  closed: number;
}

const hexOf = (c: string): number => {
  const rgb = parseHex(c) ?? [255, 0, 255];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
};

/** The overlay's colours from the theme's tokens (so it follows Settings > Appearance). */
export const occlusionColors = (t: ThemeTokens): OcclusionColors => ({ open: hexOf(t.success), half: hexOf(t.warning), closed: hexOf(t.danger) });

/** The colour for an occlusion gain: open (1) to half (0.5) to closed (0). */
export function gainColor(gain: number, colors: OcclusionColors): number {
  const g = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
  const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  const t = 1 - g;
  const c = t < 0.5 ? mix(hex(colors.open), hex(colors.half), t * 2) : mix(hex(colors.half), hex(colors.closed), (t - 0.5) * 2);
  return hexOf(c);
}

/** What the overlay needs from the world, so the drawing can be tested without one. */
export interface OcclusionScene {
  /** The World's key as the audio core knows it (`AudioDebugInfo.voices[].world` is its decimal string). */
  worldKey: number;
  /** Where the voice's source is, or null when it has none (a one-shot, an event voice, a source that has gone). */
  sourceOf(voiceId: number): Vec | null;
  /** The listener's position. */
  listener: Vec;
  /** Where a ray from `from` to `to` first meets a wall, or null. */
  hitOf(voiceId: number, from: Vec, to: Vec): Vec | null;
}

/** Half the length of a hit marker's arms, world units. */
const HIT_ARM = 0.15;

/** The voices the overlay draws: in this World, with an occlusion row that muffles or hit something, most muffled first. */
export function occludedVoices(voices: readonly DebugVoice[], worldKey: number): DebugVoice[] {
  const key = String(worldKey);
  return voices
    .filter((v) => v.world === key && v.occlusion !== undefined && (v.occlusion.gain < OPEN_GAIN || v.occlusion.hits > 0))
    .sort((a, b) => a.occlusion!.gain - b.occlusion!.gain || a.id - b.id)
    .slice(0, MAX_RAYS);
}

/** What to draw: each occluded voice's ray from its source to the listener, and a cross at the hit point. */
export function occlusionOverlay(voices: readonly DebugVoice[], scene: OcclusionScene, colors: OcclusionColors): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  for (const v of occludedVoices(voices, scene.worldKey)) {
    const from = scene.sourceOf(v.id);
    if (!from) continue;
    const color = gainColor(v.occlusion!.gain, colors);
    overlay.lines.push({ points: [[from[0], from[1], from[2]], [scene.listener[0], scene.listener[1], scene.listener[2]]], closed: false, color });
    const hit = scene.hitOf(v.id, from, scene.listener);
    if (!hit) continue;
    for (let a = 0; a < 3; a++) {
      const lo: [number, number, number] = [hit[0], hit[1], hit[2]];
      const hi: [number, number, number] = [hit[0], hit[1], hit[2]];
      lo[a] -= HIT_ARM;
      hi[a] += HIT_ARM;
      overlay.lines.push({ points: [lo, hi], closed: false, color });
    }
  }
  return overlay;
}

// --- The play World's scene -------------------------------------------------------------------------------------

/** The node and its descendants. */
function subtree(node: GameObject, into: Set<GameObject> = new Set()): Set<GameObject> {
  into.add(node);
  for (const c of node.children) subtree(c, into);
  return into;
}

/** The listener the audio system uses for `world`: the first enabled AudioListener, else the lowest-depth enabled Camera. */
function listenerNode(world: World): GameObject | null {
  for (const l of world._componentsOfType(AudioListener)) if (l.isActiveAndEnabled) return l.node;
  let best: Camera | null = null;
  for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
  return best?.node ?? null;
}

/** The overlay of one play World now, from `Audio.debug()`; empty while the toggle is off or the World has no listener. */
export function worldOcclusionOverlay(world: World, colors: OcclusionColors, enabled: boolean): EditorOverlay {
  const none: EditorOverlay = { lines: [], handles: [] };
  if (!enabled) return none;
  const listener = listenerNode(world);
  const key = worldKeyOf(world);
  if (!listener?.transform || key === 0) return none;
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
  const pos = listenerPose(listener).position;
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
export function installOcclusionOverlay(playing: ReadonlySignal<PlaySession | null>, enabled: ReadonlySignal<boolean>): () => void {
  let playWorlds: World[] = [];
  const stop = effect(() => {
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    const session = playing.value;
    playWorlds = session ? session.engine.worlds().flatMap((h) => session.engine._world(h.name) ?? []) : [];
    for (const w of playWorlds) addEditorOverlay(w, PLAY_ID, () => worldOcclusionOverlay(w, occlusionColors(theme.peek()), enabled.peek()), "other");
  });
  return () => {
    stop();
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    playWorlds = [];
  };
}

/** The scene view's occlusion tool: rays to occluded sources while playing, toggled from the Audio Debug panel. */
export const occlusionTool: ViewportToolContribution = {
  id: OCCLUSION_TOOL_ID,
  install: () => installOcclusionOverlay(playSession, occlusionOverlayOn),
};
