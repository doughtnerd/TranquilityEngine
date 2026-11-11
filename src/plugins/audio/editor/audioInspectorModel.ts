// What the audio Inspector sections say (ADR 0162 E2, api-and-models §1.2, §1.5, §7), as pure functions over live
// components and the parsed `audio` settings: the occluder's colliders and its warnings (no collider, no 3D physics
// service, another occluder overriding), the material read-out, the zone's cost line and its notices, and which
// AudioSource fields an ambisonic clip greys. The components are thin views over these.
import { AudioOccluder, nearestOccluder } from "../runtime/AudioOccluder";
import { AudioReverbZone } from "../runtime/AudioReverbZone";
import type { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider } from "../../physics/runtime";
import { getComponentClass } from "../../../engine/core/registry";
import type { ComponentClass } from "../../../engine/core/registry";
import { componentNotes } from "../../../editor/sdk";
import { compileHit, type HitCost } from "../../../engine/audio/occlusionMaterials";
import { parseAudioSettings, type AudioSettings } from "../../../engine/audio/settings";
import type { GameObject } from "../../../engine";
import { zoneMemory, zoneSlots, zoneWarnings } from "./audioSettingsModel";

/** The project's `audio` section, read leniently (defaults when absent). */
export const audioOfProject = (settings: { audio?: unknown } | undefined): AudioSettings => parseAudioSettings(settings?.audio).settings;

/** The 3D `Collider` base class the Physics plugin registered, or null while it is off. The audio plugin doesn't depend on Physics, so it finds the class through the registry (every 3D collider's parent). */
export function colliderClass(): ComponentClass<Collider> | null {
  const box = getComponentClass("engine.BoxCollider");
  return box ? (Object.getPrototypeOf(box) as ComponentClass<Collider>) : null;
}

/** The kind of 3D collider a component is (its registered id), for drawing; null for any other. */
export const COLLIDER_KINDS = { "engine.BoxCollider": "box", "engine.SphereCollider": "sphere", "engine.CapsuleCollider": "capsule", "engine.MeshCollider": "mesh", "engine.CharacterController": "character" } as const;
export type ColliderShapes = { box: BoxCollider; sphere: SphereCollider; capsule: CapsuleCollider; mesh: MeshCollider };

/**
 * Whether a 3D physics service can run in the project: the Physics plugin is on and a 3D backend is available. Occlusion
 * casts its rays through that service, so without it every occluder is inert (the audio core notes "no 3D physics
 * service"). The editor World runs no physics outside Play, so this asks the Add Component notes, where the Physics
 * plugin says "(no physics backend)" for its 3D components while none is registered.
 */
export function physics3dAvailable(): boolean {
  return getComponentClass("engine.BoxCollider") !== undefined && !componentNotes.list().some((n) => n.note("engine.BoxCollider"));
}

// --- occluders -------------------------------------------------------------------------------------------------------

/** Every 3D collider on `node` and below it, the node's first. */
export function subtreeColliders(node: GameObject): Collider[] {
  const out: Collider[] = [];
  const base = colliderClass();
  if (!base) return out;
  const visit = (n: GameObject) => {
    for (const c of n.getBehaviors(base)) out.push(c);
    for (const child of n.children) visit(child);
  };
  visit(node);
  return out;
}

/** The colliders an occluder applies to: those of its node and of descendants without an occluder of their own (`nearestOccluder`). */
export const coveredColliders = (occluder: AudioOccluder): Collider[] => subtreeColliders(occluder.node).filter((c) => nearestOccluder(c.node) === occluder);

/** A collider that can never be hit by an occlusion ray: disabled, a trigger (sensors don't occlude), or on a layer outside `audio.occlusion.layers`. */
export function colliderIsInert(c: Collider, audio: Pick<AudioSettings, "occlusion">): boolean {
  if (!c.isActiveAndEnabled || c.isTrigger) return true;
  const layers = audio.occlusion.layers;
  return layers !== null && !layers.includes(c.layer);
}

export type OccluderWarningCode = "disabled" | "noService" | "noCollider" | "overlap" | "twoOnNode" | "inert" | "unknownMaterial";

export interface OccluderWarning {
  code: OccluderWarningCode;
  /** Plain language, ready to show. */
  text: string;
}

/** Another occluder that takes some of this one's colliders: the node it sits on, its material, how many of the colliders below this node it takes. */
export interface OccluderOverride {
  node: string;
  material: string;
  colliders: number;
}

export interface OccluderReport {
  /** The colliders this occluder applies to. */
  covered: Collider[];
  /** The occluders that override this one below it. */
  overrides: OccluderOverride[];
  warnings: OccluderWarning[];
}

/** The name a material shows under: empty is the project's default, said so. */
export const materialLabel = (audio: Pick<AudioSettings, "occlusion">, material: string): string => (material === "" ? `${audio.occlusion.defaultMaterial} (the project's default)` : material);

/** What an occluder does and what is wrong with it. */
export function analyzeOccluder(occluder: AudioOccluder, context: { physics3d: boolean; audio: Pick<AudioSettings, "occlusion"> }): OccluderReport {
  const { physics3d, audio } = context;
  const all = subtreeColliders(occluder.node);
  const covered: Collider[] = [];
  const taken = new Map<AudioOccluder, number>();
  for (const c of all) {
    const o = nearestOccluder(c.node);
    if (o === occluder) covered.push(c);
    else if (o && o.node !== occluder.node && isBelow(o.node, occluder.node)) taken.set(o, (taken.get(o) ?? 0) + 1);
  }
  const overrides = [...taken].map(([o, colliders]) => ({ node: o.node.name || "(unnamed)", material: materialLabel(audio, o.material), colliders }));
  const warnings: OccluderWarning[] = [];
  if (!occluder.isActiveAndEnabled) warnings.push({ code: "disabled", text: "This occluder is disabled (or its node is inactive): it is skipped, and its colliders count as open air unless another occluder above them applies." });
  if (!physics3d) warnings.push({ code: "noService", text: "This project has no 3D physics service, so occlusion is inert: no sound is muffled by any wall. Turn the Physics plugin on and pick a 3D backend (Project Settings > Plugins, Physics)." });
  if (all.length === 0) warnings.push({ code: "noCollider", text: "There is no collider on this node or below it, so this wall has nothing to muffle with. Add a Box, Sphere, Capsule or Mesh Collider to the node or to one of its children." });
  if (occluder.node.getBehaviors(AudioOccluder).length > 1) warnings.push({ code: "twoOnNode", text: "This node has more than one AudioOccluder: only the first counts. Remove the extra ones." });
  for (const o of overrides) {
    warnings.push({ code: "overlap", text: `"${o.node}" has an AudioOccluder of its own (material ${o.material}), which overrides this one for ${o.colliders === 1 ? "its collider" : `its ${o.colliders} colliders`}. This occluder does not apply to them.` });
  }
  if (occluder.material !== "" && !audio.occlusion.materials.some((m) => m.name === occluder.material)) {
    warnings.push({ code: "unknownMaterial", text: `There is no material named "${occluder.material}" in Project Settings > Audio > Occlusion: this wall lets sound through untouched. Pick a material from the list.` });
  }
  if (all.length > 0 && covered.length > 0 && covered.every((c) => colliderIsInert(c, audio))) {
    warnings.push({ code: "inert", text: "None of the colliders this occluder applies to can be hit: triggers never occlude, disabled colliders are skipped, and layers outside Project Settings > Audio > Occlusion's list are ignored." });
  }
  return { covered, overrides, warnings };
}

/** True when `node` is a strict descendant of `ancestor`. */
function isBelow(node: GameObject, ancestor: GameObject): boolean {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** What a hit on this wall costs a ray, at the occluder's current fields: the material's row with the trims and openness applied. */
export function occluderCost(occluder: Pick<AudioOccluder, "material" | "transmissionTrimDb" | "cutoffScale" | "openness">, audio: Pick<AudioSettings, "occlusion">, openness = occluder.openness): HitCost & { material: string; known: boolean } {
  const name = occluder.material === "" ? audio.occlusion.defaultMaterial : occluder.material;
  const row = audio.occlusion.materials.find((m) => m.name === name);
  return { ...compileHit(row, occluder.transmissionTrimDb, occluder.cutoffScale, openness, { transmissionDb: 0, cutoffHz: 0, wetOcclusion: 0 }), material: name, known: !!row };
}

/** "-30 dB, 800 Hz low-pass" (a cutoff at or above 20 kHz reads as no filtering). */
export function describeCost(cost: HitCost): string {
  const db = `${Math.round(cost.transmissionDb * 10) / 10 || 0} dB`;
  const hz = cost.cutoffHz >= 20000 ? "no low-pass" : `${Math.round(cost.cutoffHz)} Hz low-pass`;
  return `${db}, ${hz}, ${Math.round(cost.wetOcclusion * 100)}% of the reverb send removed`;
}

// Tints for the gizmo (hex colours). Built-in materials get their own; a custom material's hue comes from its name.
const MATERIAL_TINTS: Record<string, number> = {
  concrete: 0x9aa4ad,
  wood: 0xc9954a,
  glass: 0x6fd0e8,
  metal: 0xb7c2d6,
  cloth: 0xb98ad6,
  none: 0x5b6670,
};

/** HSL (hue in degrees, fixed saturation and lightness) as a hex colour, for custom materials. */
function hue(h: number): number {
  const s = 0.55, l = 0.6;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** The gizmo tint of a material name (empty is the project's default material). */
export function materialTint(audio: Pick<AudioSettings, "occlusion">, material: string): number {
  const name = material === "" ? audio.occlusion.defaultMaterial : material;
  const builtin = MATERIAL_TINTS[name];
  if (builtin !== undefined) return builtin;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return hue(h);
}

/** Blend `color` toward `toward` by `t` (0 none, 1 all), channel by channel: dims a tint toward the scene's background. */
export function blendColor(color: number, toward: number, t: number): number {
  const mix = (shift: number) => Math.round(((color >> shift) & 255) * (1 - t) + ((toward >> shift) & 255) * t);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

// --- reverb zones ----------------------------------------------------------------------------------------------------

export interface ZoneNotice {
  kind: "warning" | "info";
  text: string;
}

const mb = (n: number): string => `${n < 10 ? n.toFixed(1) : Math.round(n)} MB`;

/**
 * The zone's memory cost line, from the project's zone slots (Project Settings > Audio > Zones): each active zone holds
 * one slot whose size follows `maxIrSeconds`. Null while the slots are off (zones are inert; a notice says so).
 */
export function zoneCostLine(audio: Pick<AudioSettings, "zones">): string | null {
  const slots = zoneSlots(audio.zones);
  if (slots === 0) return null;
  const cost = zoneMemory(audio);
  return `Each playing zone takes one reverb slot, about ${mb(cost.totalMB / slots)} (an impulse response is cut at ${audio.zones.maxIrSeconds} s). The project reserves ${mb(cost.totalMB)} for its ${slots} slots (${audio.zones.maxActive} active, ${audio.zones.standby} standby); change them in Project Settings > Audio > Zones.`;
}

/** What is worth telling about a zone: the Babylon backend, zones turned off, an unknown output bus, an impulse response outside the project. */
export function zoneNotices(zone: Pick<AudioReverbZone, "output" | "ir" | "preset">, audio: AudioSettings, projectFiles: readonly string[] | null): ZoneNotice[] {
  const out: ZoneNotice[] = [];
  if (audio.backend === "babylon") out.push({ kind: "warning", text: "This project's audio backend is Babylon, which has no reverb zones: they are inert and every source sounds dry. Switch the backend to Core in Project Settings > Audio." });
  else if (zoneWarnings(audio).some((w) => w.code === "zonesOff")) out.push({ kind: "warning", text: "Reverb zones are off in this project (Max active is 0 in Project Settings > Audio > Zones), so this zone does nothing." });
  if (zone.output !== "" && !audio.buses.some((b) => b.name === zone.output)) out.push({ kind: "warning", text: `There is no bus named "${zone.output}" in Project Settings > Audio: the reverb returns to Master instead.` });
  const ir = zone.ir.replace(/^asset:/, "");
  if (ir !== "" && projectFiles && !projectFiles.includes(ir)) out.push({ kind: "warning", text: `The impulse response "${ir}" is not in the project, so the ${zone.preset} preset plays instead.` });
  return out;
}

/** Which reverb this zone uses: an impulse response (it overrides the preset) or the preset. */
export const zoneReverbLine = (zone: Pick<AudioReverbZone, "ir" | "preset">): string => {
  const ir = zone.ir.replace(/^asset:/, "");
  return ir !== "" ? `Reverb: the impulse response ${ir} (it overrides the ${zone.preset} preset).` : `Reverb: the ${zone.preset} preset.`;
};

// --- AudioSource -----------------------------------------------------------------------------------------------------

/** The AudioSource fields an ambisonic clip ignores (§1.2): the Inspector greys them. */
export const AMBISONIC_IGNORED_FIELDS: readonly string[] = ["spatial", "minDistance", "maxDistance", "rolloff", "occlusion", "dopplerLevel"];

/** `AudioSource.reverbSendCurve` as the curve editor holds it (finite keys, sorted); the default when it isn't a curve. */
export function sendCurveOf(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [[0, 1], [1, 0.5]];
  const keys = value.filter((k): k is [number, number] => Array.isArray(k) && Number.isFinite(k[0]) && Number.isFinite(k[1])).map((k) => [k[0], k[1]] as [number, number]);
  return keys.length === 0 ? [[0, 1], [1, 0.5]] : keys.sort((a, b) => a[0] - b[0]);
}
