# 0306. Audio settings limits are written once: the settings section handle stores what the parse makes of an edit

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0253, 0272, 0097, 0157, 0158, 0162, 0166, 0175

## Context

Each limit of the audio section lived in three places. The parse (`engine/audio/settings.ts`: `wholeNumber`, `rangedNumber`) clamped every scalar key to its `*_LIMITS` constant. About fifteen setters in `plugins/audio/editor/audioSettingsModel.ts` (`setMusicRings`, `setRhythmMode`, `setBackground`, `setClipMemory`, `setLimiterLookahead`, `setClipFormat`, `setCodec`, `setSpatial`, `setBackend`, `setVoices`, `setBed`, `setMaxClips`, `setOcclusion`, `setZones`, `setDoppler`) each read the section, clamped with the same constants, compared and wrote it back (`setBackend` skipped the comparison, so a no-op edit made an undo step). The views passed the constants again as input bounds, and the Doppler max speed hard-coded `min={1}` where the parse's rule is "above 0". No divergence was found, only the copies.

The settings section handle (0253) already had a generic `set(draft, path, value)`, but it wrote the value as given, so callers that wanted the canonical value had to clamp it themselves.

The event editor's node fields (`plugins/audio/editor/event/nodeFields.ts`) were a second copy of the same kind, of `parseAudioEvent`'s node limits, and had drifted: `startOffset`, `reset` and `loopRegion` were capped at `1e6` and a blend child's `range` at `±1e6`, where the parse has no cap.

## Decision

We will write each limit once, in the parse's declaration, and let edits store what the parse makes of them.

- **A third edit mode on the handle.** `SettingsSectionSpec.edits` gains `"canonical"`. `set(draft, path, value)` sets the value in the parsed section, parses that section again with the spec's `parse`, and writes the parse's settings: a value out of range is stored clamped (or rounded), a rejected one as the parse's fallback, exactly as the same value in `project.json` would be read. When the parsed section comes out as it was, `set` gives back the draft itself, so a no-op edit makes no undo step. The audio handle (`audioDraft.ts`, `audioSettings`) is canonical.
- **Other sections keep their mode.** Navigation stays `"parsed"`: its parse replaces a bad value by the default rather than clamping it, so storing the canonical value would turn a typo into the default silently; the panel keeps showing it as a problem until fixed (0253's rule). Physics stays `"written"`: values never set keep following the engine's defaults, and a blank layer name stays visible as a problem by field (0272). Neither changes behaviour.
- **One declaration of the audio number keys.** `AUDIO_NUMBERS` in `engine/audio/settings.ts` maps each scalar number key's dotted path (`"music.rings"`, `"voices.mixed"`, `"zones.maxIrSeconds"`, `"doppler.maxSpeed"`…) to its `range`, whether it is `whole` and whether `min` is exclusive (`above`). The parse reads its bounds from it; the runtime's `initParams.ts` and `limiterLatency.ts` too. `VOICE_LIMITS`, `CLIP_MEMORY_LIMITS`, `MUSIC_RINGS_LIMITS`, `BED_LIMITS`, `AMBISONIC_LIMITS`, `OCCLUSION_LIMITS`, `ZONE_LIMITS`, `SPEED_OF_SOUND_LIMITS` and `LIMITER_LOOKAHEAD_LIMITS` are gone. Keys with rules of their own keep their constants (`BED_PRIORITY_LIMITS` per bus, `LOUDNESS_TARGET_LIMITS`, the materials' `MATERIAL_LIMITS`).
- **Scalar setters become path writes.** The setters above are deleted; the Audio settings views set the key by path on the handle (`audioSettings.set(draft, "zones.standby", n)`), and a number input (`KeyNum`) takes its bounds and tooltip range from `AUDIO_NUMBERS`. `applyVoicesPreset` is a sequence of path writes; `toggleOcclusionLayer` writes `occlusion.layers`. Edits with real rules stay functions: bus, effect, snapshot, ducking and automation ops (they go through `MixOp`s), loudness targets, materials, parameters and the voices preset.
- **The event node fields read the parse's declaration.** `eventFormat.ts` declares `NODE_NUMBERS` (each number key's range and default) and `NODE_PAIRS` (the `[low, high]` keys); `parseAudioEvent`'s node parse and `nodeFields.ts` both read them, so `startOffset`, `reset`, `loopRegion` and `range` lose the `1e6` cap the parse never had (an open end is `Infinity`; the field shows a number box without a slider, as it did).

## Alternatives considered

- **Make `"parsed"` canonical for every section:** one mode fewer, but navigation's parse turns a rejected value into its default, so typing a bad tile size would silently reset it, and physics would lose its sparse writes. Opt-in keeps both sections as they are.
- **Keep the setters and import the limits from one place:** the limits already came from one set of constants; the copies were the read-clamp-compare-write bodies, which only the parse needs.
- **A rejected value leaves the draft unchanged** (what most setters did for NaN): the handle can't tell a rejected value from a clamped one without reading the parse's problems, and the views never send one (number inputs commit finite numbers only). A rejected value now takes the parse's fallback, as it would in the file.

## Consequences

**Positive**
- A limit change is one edit: the declaration. The views, the parse and the runtime can't disagree.
- Setter tests shrink to path writes through the handle plus the parse's own tests; `setBackend`'s missing no-change check is fixed for every key.
- The event node fields follow the parse; the `1e6` drift is fixed.

**Negative / costs**
- `audioSettings.set` takes a path string and an `unknown` value: a typo in a path is caught by the parse (an unknown key is ignored) rather than the compiler. `KeyNum` takes an `AudioNumberPath`, so the number inputs are typed.
- A rejected value (NaN, a Doppler max speed of 0, an unknown default material) now becomes the parse's fallback instead of being ignored.
- Each canonical edit parses the section once more (microseconds).

## Deprecates

The scalar setters listed in Context, `setVoices`, `OcclusionPatch`, `ZonesPatch`, `DopplerPatch` and `clampInt` in `audioSettingsModel.ts`; the nine `*_LIMITS` constants listed above (moved into `AUDIO_NUMBERS`); the hard-coded node limits in `nodeFields.ts`. All removed.

## Open questions

- Should navigation's parse clamp out-of-range numbers (as audio's does) so its handle can become canonical too? Not needed today; navigation is being ported.

## References

- Architecture review 2026-11-21, candidate 6 and small fix 7.
- `src/editor/settingsSection.ts`, `src/engine/audio/settings.ts`, `src/plugins/audio/editor/audioDraft.ts`, `audioSettingsModel.ts`, `AudioSettingsSection.tsx`, `src/engine/audio/eventFormat.ts`, `src/plugins/audio/editor/event/nodeFields.ts`; tests `editor/settingsSection.test.ts`, `plugins/audio/editor/audioSettingsModel.test.ts`, `audioZoneModel.test.ts`, `event/nodeFields.test.ts`.
