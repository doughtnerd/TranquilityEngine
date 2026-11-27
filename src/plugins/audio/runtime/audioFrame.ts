/**
 * ADR 0434: one main-thread audio frame, in the order every caller runs (`stepAudioFrame`): the mixer's update (its heard
 * clock, ramps, ducking and listeners), then the backend frame (ADR 0270, `runAudioFrame` below), then the playlist runtime's
 * frame (ADR 0343). The audio system (`audioSystem.ts`) calls it once per frame in the World with the view, after resolving
 * the listener into the frame; the loopback and recording rigs (`testing.ts`) call it for each main-thread frame, so a
 * loopback test runs the frame a game runs. Adding or moving a step is an edit here and nowhere else.
 *
 * The backend frame's order (ADR 0270, 0162 K4), by what the backend can do:
 *
 * - **The core** (`StagedFrameHost`, `core/spatial.ts`): 1. attenuation (`frameAttenuate`: frame start, gain, direction,
 *   `audibility0`), then `collectSpatialVoices`, 2. Doppler, 3. zones, 4. occlusion (main's passes over `spatialVoices`),
 *   5. audibility × smoothed occlusion and selection (`frameSelect`), 6. panner pick, 7. fx staging, 8. listener,
 *   then the BATCH (`frameCommit`; ADR 0166's music plan step went with the music player, ADR 0343). The stage methods are this
 *   module's contract with the core; nothing else calls them.
 * - **The Babylon fallback** (`SpatialPassHost` only, F1): the same passes (zones inert, F2), then the
 *   backend's own `update(dt)`, which pans and commits.
 * - **A plain backend** (the pending backend, test fakes): its `update(dt)` when it has one.
 *
 * `frame` is the caller's listener frame, already `set` for this frame (the audio system's has the World with the view; a
 * rig's has none, so the listener-bound passes are inert there, as in a World without a listener). `settings` are the
 * mixer's that configured the backend (the page mixer's in a game; a rig's own mixer's in a test).
 */
import type { Mixer } from "../../../engine/audio/mixer";
import type { AudioSettings } from "../../../engine/audio/settings";
import type { AudioBackend } from "./backend";
import { isSpatialPassHost, isStagedFrameHost, type ListenerFrame } from "./core/spatial";
import { takeTap } from "./capture/takeTap";

/** What the playlist runtime's frame needs (ADR 0343: `PlaylistHost.update`, the instances and the fallback's automation). */
export interface PlaylistFrame {
  update(dt: number): void;
}

/** ADR 0434: what one main-thread audio frame runs over. A caller keeps one and updates it, so a frame allocates nothing. */
export interface AudioFrameParts {
  /** The mixer that configured `backend` (the page mixer in a game; a rig's own in a test). Its settings drive the passes. */
  mixer: Mixer;
  /** The playlist runtime (`playlistHost()`), or null where none runs (a rig on its own mixer). */
  playlists: PlaylistFrame | null;
  backend: AudioBackend;
  /** The caller's listener frame, already `set` for this frame (see the header). */
  frame: ListenerFrame;
}

/**
 * ADR 0434: one main-thread audio frame in the production order: `mixer.update`, the backend frame (`runAudioFrame`), the
 * playlist runtime's frame. Allocates nothing.
 */
export function stepAudioFrame(parts: AudioFrameParts, dt: number): void {
  const { mixer, backend } = parts;
  mixer.update(dt);
  runAudioFrame(backend, parts.frame, dt, mixer.audioSettings);
  parts.playlists?.update(dt);
}

/**
 * ADR 0270: runs one backend frame in the production order (see the header). Allocates nothing. `stepAudioFrame` runs it
 * between the mixer and the playlists; the rigs' `tick` runs it alone, for a test that drives the mixer itself.
 */
export function runAudioFrame(backend: AudioBackend, frame: ListenerFrame, dt: number, settings: AudioSettings): void {
  // ADR 0348: a recording take reads the listener's and the emitters' poses once per frame (30 Hz, changes only).
  // and, when it takes pictures, the canvas the World renders into (none headless).
  if (takeTap.sink) takeTap.sink.frame(frame.node ? frame : null, frame.world?.render?.canvas ?? null);
  if (isStagedFrameHost(backend)) {
    const view = backend.spatialVoices;
    backend.frameAttenuate(dt); // 1. attenuation
    backend.collectSpatialVoices();
    backend.doppler.run(frame, view, settings); // 2. Doppler
    backend.zones.run(frame, view, settings); // 3. zones
    backend.occlusion.run(frame, view, settings); // 4. occlusion
    backend.frameSelect(); // 5. audibility × smoothed occlusion, selection
    backend.framePickPanners(); // 6. panner pick
    backend.frameStageFx(); // 7. fx staging
    backend.frameStageListener(frame); // 8. listener
    backend.frameCommit();
    return;
  }
  if (isSpatialPassHost(backend)) {
    const view = backend.spatialVoices;
    backend.collectSpatialVoices();
    backend.doppler.run(frame, view, settings);
    backend.zones.run(frame, view, settings);
    backend.occlusion.run(frame, view, settings);
  }
  backend.update?.(dt);
}
