// The Audio plugin's runtime half (ADR 0006, 0074, 0097, 0098, 0157): its Components, the audio engine system
// and the `myco.audio` World service. `myco` (`src/myco.ts`) exports the public parts from here. Runtime
// code: never imports from `src/editor/` or the plugin's `editor/` folder. The mixer and the `audio`
// settings stay core modules (`src/engine/audio/`).
import type { RuntimePlugin } from "../../runtimeContext";
import { audioManifest } from "../manifest";
import { AudioListener } from "./AudioListener";
import { AudioSource } from "./AudioSource";
import { AudioOccluder } from "./AudioOccluder";
import { AudioReverbZone } from "./AudioReverbZone";
import { AUDIO_SERVICE } from "./core/service";
import { AUDIO_SYSTEMS } from "./audioSystem";

export { Audio, type OneShotOptions } from "./Audio";
// ADR 0166 §1 (Q2): the interactive music types (the engine's `musicTypes.ts`) and the `Calibration` namespace.
export { Calibration } from "./music/calibration";
export type { AudioLatency, CalibrationResult, GridPoint, GridSpec, MusicEvent, MusicHandle, MusicKind, MusicPositionAt, MusicSeekResult } from "../../../engine/audio/musicTypes";
export type { AudioBedDebug, AudioDebugInfo, AudioEventHandle, AudioHandle, AudioM3Counters, AudioMemoryDebug, AudioOcclusionDebug, AudioPanner, AudioReason, AudioStatus, AudioVoiceM3Debug, AudioZoneDebug, MusicDebugPending, MusicDebugRow, MusicDebugState, MusicDebugTotals, SendCurve } from "./backend";
export { DEFAULT_SEND_CURVE } from "./backend";
export type { EventOptions } from "./events/eventRuntime";
export { AudioSource, type Rolloff } from "./AudioSource";
export { AudioOccluder } from "./AudioOccluder";
export { AudioReverbZone, ZONE_PRESETS } from "./AudioReverbZone";
export { AudioListener } from "./AudioListener";
export type { Bus } from "../../../engine/audio/mixer";
/** @internal B2: the decoder worker's client (B5 wires the clip registry to it). Not part of the public API (`src/myco.ts` does not export it). */
export { createDecoderClient, type DecoderClient, type DecodedClip } from "./decoder/decoderClient";
export { hintFromName } from "./decoder/protocol";

export const audioRuntimePlugin: RuntimePlugin = {
  manifest: audioManifest,
  activate(context) {
    context.registerComponents([AudioSource, AudioListener, AudioOccluder, AudioReverbZone]);
    context.registerEngineSystems(AUDIO_SYSTEMS);
    context.registerWorldService(AUDIO_SERVICE);
  },
};
