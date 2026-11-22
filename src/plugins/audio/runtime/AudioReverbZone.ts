/**
 * A reverb zone (ADR 0162 M3, api-and-models §1.5, R10, R17): a box or sphere volume with its own reverb. Spatial
 * sources inside it (or within `blendDistance` of it) send to its reverb, weighted per source as Wwise rooms are; the
 * zone's wet signal returns into its `output` bus before that bus's effects. The reverb is a built-in preset (`room`,
 * `corridor`, `hall`, `cave`, `open`, and ADR 0333's `smallStone`, `canyonHall`, `metalTunnel`, `forest`) unless an
 * impulse response asset is set. A `levelDefault` zone (ADR 0333) applies everywhere no higher-priority zone holds the
 * source, whatever its own volume: the level's ambient reverb. It exists in the editor World and in play; the audio
 * plugin's zone manager (`core/zones.ts`) plans it in the World that has the listener. `enabled = false` skips the zone.
 * On the Babylon fallback zones are inert.
 */
import { Component } from "../../../engine/core/Component";
import { Vector3 } from "../../../engine/core/math";
import { AssetRef, component, field } from "../../../engine/core/registry";
import { ZONE_PRESETS } from "./reverbPresets";

export { ZONE_PRESETS, type ZonePreset } from "./reverbPresets";

@component("engine.AudioReverbZone")
export class AudioReverbZone extends Component {
  @field(String, { choices: ["box", "sphere"], description: "The zone's shape." }) shape = "box";
  @field(Vector3, { description: "Offset of the volume from the node, local units." }) center = new Vector3(0, 0, 0);
  @field(Vector3, { description: "Box zones: edge lengths in local units, scaled by the node's world scale." }) size = new Vector3(10, 4, 10);
  @field(Number, { description: "Sphere zones: radius in local units, scaled by the node's largest scale axis." }) radius = 5;
  @field(String, { choices: ZONE_PRESETS, description: "Built-in reverb used when no impulse response is set." }) preset = "hall";
  @field(AssetRef, { kind: "audio", description: "An impulse response (mono or stereo WAV or FLAC). Overrides the preset. Past the preset's length limit it is cut with a fade." }) ir = "";
  @field(Number, { description: "Wet level, linear 0..2 (1 = the impulse response's calibrated level, as a reverb bus effect at send 1)." }) wet = 0.5;
  @field(Number, { description: "Distance outside the volume over which the zone fades in, world units. 0 is a hard edge." }) blendDistance = 2;
  @field(Number, { description: "Higher wins when more zones are in play than the preset has reverbs (0..100)." }) priority = 0;
  @field(String, { choices: (s) => ["", ...s.audio.buses.map((b) => b.name)], description: "The bus the reverb returns to (before its effects). Empty is Master." }) output = "";
  @field(Boolean, { description: "The level's default reverb: it holds every source no higher-priority zone holds, wherever it is (its volume is ignored)." }) levelDefault = false;
}

/**
 * @internal ADR 0333: a point's weights in the first `n` zones with the level-default zones filled in, in place, before
 * the weights are normalised. A default zone's weight is `1 −` the largest weight of a zone that is not a default and has
 * a higher priority, so it holds the point fully outside them and fades out over their blend edges. No allocation.
 */
export function applyLevelDefaults(w: Float32Array, zones: readonly { readonly comp: Pick<AudioReverbZone, "levelDefault" | "priority"> }[], n: number): void {
  for (let z = 0; z < n; z++) {
    const c = zones[z]!.comp;
    if (!c.levelDefault) continue;
    let covered = 0;
    for (let k = 0; k < n; k++) {
      const o = zones[k]!.comp;
      if (k !== z && !o.levelDefault && o.priority > c.priority && w[k]! > covered) covered = w[k]!;
    }
    w[z] = 1 - Math.min(1, covered);
  }
}
