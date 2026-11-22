/**
 * ADR 0270: one backend frame, in the order every caller runs (ADR 0162 K4). The audio system (`audioSystem.ts`) calls it once
 * per frame in the World with the view; the loopback and recording rigs (`testing.ts`) call it for each main-thread frame, so a
 * loopback test runs the frame a game runs. Adding or moving a stage is an edit here and nowhere else.
 *
 * The order, by what the backend can do:
 *
 * - **The core** (`StagedFrameHost`, `core/spatial.ts`): 1. attenuation (`frameAttenuate`: frame start, gain, direction,
 *   `audibility0`), then `collectSpatialVoices`, 2. Doppler, 3. zones, 4. occlusion (main's passes over `spatialVoices`),
 *   5. audibility × smoothed occlusion and selection (`frameSelect`), 6. panner pick, 7. fx staging, 8. listener,
 *   9. music plan (`musicPlanStep`: nothing without music), then the BATCH (`frameCommit`). The stage methods are this
 *   module's contract with the core; nothing else calls them.
 * - **The Babylon fallback** (`SpatialPassHost` only, F1): the same passes (zones inert, F2), the music plan, then the
 *   backend's own `update(dt)`, which pans and commits.
 * - **A plain backend** (the pending backend, test fakes): the music plan, then its `update(dt)` when it has one.
 *
 * `frame` is the caller's listener frame, already `set` for this frame (the audio system's has the World with the view; a
 * rig's has none, so the listener-bound passes are inert there, as in a World without a listener). `settings` are the
 * mixer's that configured the backend (the page mixer's in a game; a rig's own mixer's in a test).
 */
import type { AudioSettings } from "../../../engine/audio/settings";
import type { AudioBackend } from "./backend";
import { isSpatialPassHost, isStagedFrameHost, type ListenerFrame } from "./core/spatial";
import { musicPlanStep } from "./music/musicSystem";
import { takeTap } from "./capture/takeTap";

/** ADR 0270: runs one backend frame in the production order (see the header). Allocates nothing. */
export function runAudioFrame(backend: AudioBackend, frame: ListenerFrame, dt: number, settings: AudioSettings): void {
  // ADR 0334: a recording take reads the listener's and the emitters' poses once per frame (30 Hz, changes only).
  if (takeTap.sink) takeTap.sink.frame(frame.node ? frame : null);
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
    musicPlanStep(backend, dt); // 9. music plan (ADR 0166): nothing without music
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
  musicPlanStep(backend, dt); // 9. music plan, before the backend's own frame commits
  backend.update?.(dt);
}
