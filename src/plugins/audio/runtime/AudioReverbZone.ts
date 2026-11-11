/**
 * A reverb zone (ADR 0162 M3, api-and-models §1.5, R10, R17): a box or sphere volume with its own reverb. Spatial
 * sources inside it (or within `blendDistance` of it) send to its reverb, weighted per source as Wwise rooms are; the
 * zone's wet signal returns into its `output` bus before that bus's effects. The reverb is a built-in preset (`room`,
 * `corridor`, `hall`, `cave`, `open`) unless an impulse response asset is set. It exists in the editor World and in play;
 * the audio plugin's zone manager (`core/zones.ts`) plans it in the World that has the listener. `enabled = false`
 * skips the zone. On the Babylon fallback zones are inert.
 */
import { Component } from "../../../engine/core/Component";
import { Vector3 } from "../../../engine/core/math";
import { AssetRef, component, field } from "../../../engine/core/registry";

/** The built-in reverbs a zone can use without an impulse response (R10; parameters in api-and-models §2.3). */
export const ZONE_PRESETS = ["room", "corridor", "hall", "cave", "open"] as const;
/** One of `ZONE_PRESETS`. */
export type ZonePreset = (typeof ZONE_PRESETS)[number];

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
}
