# 0462. One rule picks the audio listener

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0074, 0162, 0343, 0347, 0355

## Context

ADR 0074 says the first enabled `AudioListener` hears for a World, else the main camera (the active, enabled Camera with
the lowest depth). Seven places wrote that rule out themselves: `audioSystem.ts`, `AudioZone.ts`, `dialogue/AudioSpeaker.ts`,
`playlists/playlistSystem.ts`, `playlists/instance.ts`, `localisation/captions.ts` and the editor's `OcclusionOverlay.ts`.
They disagreed on a listener whose node has no transform. `listenerPose` did `node.transform!`, so with such a listener
enabled beside a camera, `AudioSpeaker` skipped it and used the camera, captions returned no listener (pan 0), and
`AudioZone`, both playlist copies and the audio system threw a TypeError every frame. The playlist copies also read
`World.active` rather than the World the instance plays in.

## Decision

We will keep the rule in `runtime/AudioListener.ts`, and every caller uses it:

- `activeListener(world): AudioListener | null`: the first active, enabled `AudioListener` whose node has a transform.
- `listenerNode(world): GameObject | null`: that listener's node, else the active, enabled Camera with a transform and
  the lowest depth (the first on a tie). Always a node with a transform.
- `listenerPoseIn(world): ListenerPose | null`: the pose of `listenerNode(world)` (position, forward +Z, up +Y).
- `listenerPose(node): ListenerPose | null`: a node's pose, null without a transform (`AudioZone` still uses it for the
  zone's own facing).

A playlist instance finds its World with `playlistHost().worldOf(key)`: the World noted for its key (the audio system
notes it each frame), null when that World has gone, and the active World for key 0 (no core share: Babylon or a test
backend, where keys don't tell Worlds apart) or a key not yet noted.

## Consequences

**Positive**
- A listener on a node with no transform is passed over the same way everywhere: the next listener or the camera hears.
  No more TypeError from the audio system, zones or playlists.
- Playlist distance (steal-farthest, curve attenuation) and caption pan use the instance's own World's listener under the
  core backend, where each World has its own key.

**Negative / costs**
- Behaviour change: a transform-less enabled listener used to make captions report no listener and the others throw; now
  the camera (or a later listener) hears. A Camera on a node without a transform is now skipped too.

## Deprecates

The six private listener functions (`listenerIn`, two `listenerPosition`s per playlist module, `listener` in captions,
`listenerPosition` in `AudioSpeaker`, `listenerNode` in `OcclusionOverlay`) and the audio system's inline loop: removed.

## As built

- `src/plugins/audio/runtime/AudioListener.ts` (the rule), `playlists/host.ts` `worldOf`; `noteWorld` now takes a `World`.
- Tests: `src/engine/tests/spatialAudio.test.ts` "passes over an enabled AudioListener on a node with no transform" (threw
  `TypeError` before); `playlists/host.test.ts` "worldOf names the World a key was noted for".
