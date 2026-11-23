// `audio` track keys (ADR 0371) through the audio plugin's public API (`Audio.play`, ADR 0343), when `myco.audio` is
// active for this activation (ADR 0374: read at activation by `register.ts`). The key's audio asset (a playlist or a
// sample) plays at the node the track names (relative to the Animator's node; the Animator's node when it names none),
// so a spatial playlist sounds from there. The key's params map onto `Audio.play`'s options: `volume`, `pitch`, `bus`,
// `priority`, `offset`, `minDistance`, `maxDistance` by name, `parameters` (an object) and any other number or string
// as the playlist's local parameters. The clip's weight scales the volume (D29: audio keys fire at any weight above 0
// and carry it), so a clip fading out sounds fainter.
import { Audio } from "../../../../audio/runtime";
import type { GameObject } from "../../../../../engine/scene/GameObject";

let active = false;

/** @internal Whether `audio` keys play: set at each activation. */
export function setAudioTracks(on: boolean): void {
  active = on;
}

const OPTION_KEYS = new Set(["volume", "pitch", "bus", "priority", "offset", "minDistance", "maxDistance"]);
type PlayOptions = NonNullable<Parameters<typeof Audio.play>[1]>;

/** `Audio.play`'s options for a key's params JSON and the clip's weight, positioned at `node`. */
function audioOptions(params: unknown, weight: number, node: GameObject): PlayOptions {
  const options: Record<string, unknown> = {};
  const parameters: Record<string, number | string> = {};
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (OPTION_KEYS.has(k)) options[k] = v;
      else if (k === "parameters" && typeof v === "object" && v !== null && !Array.isArray(v)) {
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) if (typeof pv === "number" || typeof pv === "string") parameters[pk] = pv;
      } else if (typeof v === "number" || typeof v === "string") parameters[k] = v;
    }
  }
  const volume = typeof options.volume === "number" && Number.isFinite(options.volume) ? options.volume : 1;
  options.volume = volume * (Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 1);
  if (Object.keys(parameters).length) options.parameters = parameters;
  const p = node.isValid ? node.transform?.worldPosition : undefined;
  if (p) options.position = { x: p.x, y: p.y, z: p.z };
  return options as PlayOptions;
}

/** @internal Plays one audio key (`asset`: the key's audio asset reference). */
export function playAudioKey(asset: string, params: unknown, weight: number, node: GameObject): void {
  if (!active || !asset) return;
  Audio.play(asset, audioOptions(params, weight, node));
}
