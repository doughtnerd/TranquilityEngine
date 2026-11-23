// The output device's audio offset, set in the device menu (per device, per user), handed to the Studio's runtime
// through the public `Audio.calibration` (seconds) whenever the runtime can play. A device never calibrated in the
// Studio leaves the engine's own stored value alone.
import { effect } from "@preact/signals";
import { isCalibrated, offsetsFor } from "../components/deviceOffsets";
import type { StudioAudioHost } from "../runtime/studioAudioHost";
import { outputDevice } from "./outputDevice";
import { deviceOffsets } from "./studioServices";

export function installCalibration(host: StudioAudioHost): () => void {
  return effect(() => {
    if (!host.playable.value) return;
    const store = deviceOffsets.value;
    const device = outputDevice().value;
    if (!isCalibrated(store, device.id)) return;
    try {
      host.audio.calibration = offsetsFor(store, device.id).audio / 1000;
    } catch (err) {
      console.warn(`[studio] couldn't set the audio offset: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
