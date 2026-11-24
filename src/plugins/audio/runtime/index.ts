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
import { AudioZone, AUDIO_ZONE_SYSTEM } from "./AudioZone";
import { AUDIO_SERVICE } from "./core/service";
import { AUDIO_SYSTEMS } from "./audioSystem";
import { AudioPackageLoader } from "./media/AudioPackageLoader";
import { AUDIO_PACKAGES_SERVICE } from "./media/service";
import { AudioSpeaker } from "./dialogue/AudioSpeaker";

export { Audio, type OneShotOptions } from "./Audio";
// ADR 0344: `Audio.snapshot(name)`'s handle.
export type { AudioSnapshot } from "./Audio";
// ADR 0166 §1 (Q2): the interactive music types (the engine's `musicTypes.ts`) and the `Calibration` namespace.
export { Calibration } from "./music/calibration";
export type { AudioLatency, CalibrationResult, GridPoint, GridSpec, MusicEvent, MusicHandle, MusicKind, MusicPositionAt, MusicSeekResult } from "../../../engine/audio/musicTypes";
export type { AudioBedDebug, AudioDebugInfo, AudioEventHandle, AudioPlaylistHandle, AudioMarkerEvent, AudioMarkerType, AudioHandle, AudioM3Counters, AudioMemoryDebug, AudioOcclusionDebug, AudioPanner, AudioReason, AudioStatus, AudioVoiceM3Debug, AudioZoneDebug, MusicDebugPending, MusicDebugRow, MusicDebugState, MusicDebugTotals, SendCurve } from "./backend";
// ADR 0171 §1.2, §1.3 (K0): the capture surface and the M5 debug shapes.
export type { AudioCpuDebug, AudioMixCaps, AudioMixDebug, AudioMixSlotDebug, AudioRecorderDebug } from "./backend";
export type { AudioCapture, AudioCaptureState } from "./capture/capture";
export type { AudioTake, AudioTakeState } from "./capture/take";
export type { TakeExtensionRecord } from "../../../engine/audio/take/extensions";

/**
 * @internal ADR 0348: what a plugin needs of a take file to decode its own records (types 0x40..0x7e): the project and
 * duration META names, and the records in file order. Loads the capture reader only when called. Rejects with the reader's
 * message when the file isn't a take it can read.
 */
export async function readTakeExtensions(file: Uint8Array): Promise<{ project: string; duration: number; extensions: import("../../../engine/audio/take/extensions").TakeExtensionRecord[] }> {
  const { openTakeFile } = await import("./capture/takeFile");
  const opened = await openTakeFile(file);
  return { project: opened.take.meta.project, duration: opened.take.duration, extensions: opened.extensions };
}
export { DEFAULT_SEND_CURVE } from "./backend";
export type { EventOptions } from "./playlists/options";
export { AudioSource, type Rolloff } from "./AudioSource";
export { AudioOccluder } from "./AudioOccluder";
export { AudioReverbZone, ZONE_PRESETS } from "./AudioReverbZone";
// ADR 0347: audio zones.
export { AudioZone, AUDIO_ZONE_HEARD, type AudioZoneHeard } from "./AudioZone";
export { AudioListener } from "./AudioListener";
export type { Bus } from "../../../engine/audio/mixer";
/** @internal B2: the decoder worker's client (B5 wires the clip registry to it). Not part of the public API (`src/myco.ts` does not export it). */
export { createDecoderClient, type DecoderClient, type DecodedClip } from "./decoder/decoderClient";
export { hintFromName } from "./decoder/protocol";

// ADR 0351 §9: audio packages (`Audio.package(name)`) and the component that loads them with a scene.
export { AudioPackageLoader } from "./media/AudioPackageLoader";
export type { AudioPackage } from "./media/packages";

// ADR 0354, 0355, 0357: localised audio, voice-over lines, captions and dynamic dialogue.
export type { AudioLanguage, SetLanguageOptions, AudioLanguageDebug } from "./localisation/languageState";
export type { AudioLineHandle, AudioLineEvent, LineOptions, LineEnd } from "./localisation/lines";
export type { AudioViseme } from "./localisation/viseme";
export type { AudioCaptionEvent } from "./localisation/captions";
export type { SayOptions, AudioDialogue, AudioDialogueDebug } from "./dialogue/dialogueSystem";
export type { DialogueMemory } from "./dialogue/memory";
export { AudioSpeaker };

export const audioRuntimePlugin: RuntimePlugin = {
  manifest: audioManifest,
  activate(context) {
    context.registerComponents([AudioSource, AudioListener, AudioOccluder, AudioReverbZone, AudioZone, AudioPackageLoader, AudioSpeaker]);
    context.registerEngineSystems([...AUDIO_SYSTEMS, AUDIO_ZONE_SYSTEM]);
    context.registerWorldService(AUDIO_SERVICE);
    context.registerWorldService(AUDIO_PACKAGES_SERVICE);
    // ADR 0376, 0403 (C4): the debug link's `audio` topic; its code loads by `import()` only when a build's link starts.
    context.debugLink.topic("audio", () => import("./debugLink/topic").then((m) => m.audioTopic));
  },
};
