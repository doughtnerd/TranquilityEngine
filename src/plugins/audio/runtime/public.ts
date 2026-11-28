// The Audio plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { Audio, type OneShotOptions, type AudioSnapshot } from "./Audio";
export { AudioSource, type Rolloff } from "./AudioSource";
export { AudioListener } from "./AudioListener";
export { AudioOccluder } from "./AudioOccluder";
export { AudioReverbZone } from "./AudioReverbZone";
export { AudioZone, type AudioZoneHeard } from "./AudioZone";
export { DEFAULT_SEND_CURVE, type AudioHandle, type AudioPlaylistHandle, type AudioMarkerEvent, type AudioMarkerType, type AudioEventHandle, type AudioStatus, type AudioReason, type AudioPanner, type SendCurve, type AudioDebugInfo, type AudioBedDebug, type AudioZoneDebug, type AudioOcclusionDebug, type AudioMemoryDebug, type AudioVoiceM3Debug, type AudioM3Counters, type MusicDebugRow, type MusicDebugPending, type MusicDebugState, type MusicDebugTotals, type AudioCpuDebug, type AudioMixCaps, type AudioMixDebug, type AudioMixSlotDebug, type AudioRecorderDebug } from "./backend";
export type { EventOptions } from "./playlists/options";
export type { Bus } from "../../../engine/audio/mixer";
export { AudioPackageLoader } from "./media/AudioPackageLoader";
export type { AudioPackage } from "./media/packages";
export { AudioSpeaker } from "./dialogue/AudioSpeaker";
export type { AudioLanguage } from "./localisation/languageState";
export type { AudioLineHandle, AudioLineEvent, LineOptions } from "./localisation/lines";
export type { AudioViseme } from "./localisation/viseme";
export type { AudioCaptionEvent } from "./localisation/captions";
export type { SayOptions } from "./dialogue/dialogueSystem";
export type { DialogueMemory } from "./dialogue/memory";
export { Calibration } from "./music/calibration";
export type { GridSpec, GridPoint, MusicEvent, MusicKind, MusicHandle, MusicPositionAt, MusicSeekResult, CalibrationResult, AudioLatency } from "../../../engine/audio/musicTypes";
export type { AudioCapture, AudioCaptureState } from "./capture/capture";
export type { AudioTake, AudioTakeState } from "./capture/take";
// Interactive-music types, as types only (ADR 0168): a script can name them in annotations; nothing reaches the bundle.
export type { MusicEventHandle, CalibrationApi } from "../../../engine/audio/musicTypes";
