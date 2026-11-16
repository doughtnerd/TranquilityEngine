# 0175. The bus capability rules live in one module, `Mixer.apply` owns the live-op pipeline, and the audio project section is parsed once

- **Status:** Accepted
- **Date:** 2026-11-15
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0097, 0151, 0171, 0172

## Context

**Bus capability rules.** Three rules decide what a bus tree may hold: at most `MAX_BUSES` (32) buses, at most 4 effects per bus on the audio core, at most one compressor per bus on the core. ADR 0172 R10: an over-limit effect edit is kept as authored and applies at the next Play, where the core runs the first 4 effects and the first compressor. Before this record each rule was decided in several places that agreed only by chance:

- `settings.ts`: `MAX_CORE_BUS_EFFECTS` and the parse's warnings, with their own text.
- `core/liveMix.ts`: `FIFTH_EFFECT`, `SECOND_COMPRESSOR`, `addsSecondCompressor`, three `effects.length >= BUS_SLOT_MAX_EFFECTS` checks, other text.
- `babylonBackend.applyOp`: its own `NEEDS_AUDIO_CORE` rule for level ducking.
- `mixOps.opRefusal`, `audioSettingsModel.addBus` and `AudioSettingsSection` (`a.buses.length >= MAX_BUSES`) for the bus count.
- `Mixer.apply` and both `MixOpTarget` adapters repeated a prologue (`opRefusal`, `opClass`, the no-op check, the answer for "the next Play"). `ApplyResult` carried free-text `deferred` / `restartRequired` strings that the Mixer panel collected as text.

G9b (a401a40, a fifth effect is a warning) and FU4 (9a3c5c1, a second compressor is kept) each had to edit three or more of these.

**The audio section.** `parseAudioSettings` was called in ~17 non-test modules; `audioOf(d)` 47 times in `audioSettingsModel.ts`; `applyOpToDraft` re-parsed per op; `settingsProblems` and `settingsWarnings` each parsed the same draft. `LIVE_KEYS` (in `mixOps.ts`) decided what `applyOpToDraft` writes back, while `withAudio` in the model separately pruned `occlusion.materials`.

## Decision

**One bus capability module, `src/engine/audio/busCapability.ts`.** It is in the engine because the settings parse needs it and the engine imports no plugin. It owns, per rule (`busCount`, `compressorsPerBus`, `effectsPerBus`), in `BUS_RULES`: the limit (`MAX_BUSES`, `MAX_CORE_BUS_EFFECTS`, `MAX_CORE_BUS_COMPRESSORS`; `settings.ts` re-exports the first two), the parse severity (`problem` / `warning`), the live answer (`refused` / `nextPlay`), whether only the core has the limit, and one message. Everything else is built from it:

- the parse (`busRuleFindings`, `findingText`: `audio.buses[i]: <message>.`, a problem adding "; the rest are ignored");
- `opRefusal` (`ruleRefusal`: "At most 32 buses.");
- the live answer (`liveRuleAnswer`, checked against the target's `LiveCaps`);
- the Section's add-bus buttons (`atBusLimit`).

A plugin-side test asserts `BUS_SLOT_MAX_EFFECTS` (the wire, generated from Rust) equals `MAX_CORE_BUS_EFFECTS`. `commandWriter`'s clamp stays as the wire encoder's guard.

**`Mixer.apply` owns the pipeline.** In order: no target, `noLiveBackend`; `opRefusal`, `{ ok: false, class: "none" }`; `opClass` none, `{ ok: true, class: "none" }`; a capability rule of the target (`liveRuleAnswer`), kept for the next Play; else `target.sendOp(op, cls)`; after an applied send, `unsupportedAnswer` (a level ducking rule on a target without level ducking: `needsAudioCore`). A `MixOpTarget` is `{ liveCaps, sendOp(op, cls), notSent?(r) }`: the core's `LiveMix` (`CORE_LIVE_CAPS`; `notSent` counts `liveRefused`) and the fallback's `BabylonBackend.mixOpTarget` (`FALLBACK_LIVE_CAPS`). `AudioBackend.applyOp` becomes `AudioBackend.mixOpTarget`.

**A closed set of reasons.** `ApplyResult` is `{ ok, class, reason? }` with `reason` one of `APPLY_REASONS`: `effectsPerBus`, `compressorsPerBus`, `needsAudioCore`, `structuralUnavailable`, `noLiveBackend`, `waitsForSlot`. `reasonMessage(reason)` is the only text; `appliesAtNextPlay(r)` (not ok, with a reason) is what the Mixer panel's banner collects. `ok: true` with `waitsForSlot` is a deferred add (R10). The user-visible texts are unchanged, except the parse's warnings, which now use the rule message (the drifted duplicate).

**One audio section module, `src/engine/audio/audioSection.ts`.** `audioSection(raw)` returns `{ settings, problems, warnings }`, memoised on the identity of the draft's `audio` object (a WeakMap) and deep-frozen, since callers share it. `withLiveKeys(d, next)` writes `LIVE_KEYS` over the authored section, keeping other keys (`applyOpToDraft`). `withSettings(d, next)` writes the whole section, with built-in occlusion materials pruned (the model's former `withAudio`). `LIVE_KEYS` moves here; `mixOps.ts` re-exports it. Editor callers (`settingsProblems`, `settingsWarnings`, `audioSettingsModel`, `mixerModel`, `mixerPanelModel`, `opLog`, `ProfilerPanel`, `EventEditorPanel`, `audioInspectorModel`, `profilerTablesModel`) hold its result. The ADR 0151 section machinery, `recordMixOps` and `diffOps` are unchanged. The Engine and `core/settings.ts` parse at run time once and keep doing so.

**What this changes in 0171/0172.** The behaviour of R10, G9b and FU4 is unchanged. Where those records and the design notes (`docs/design/0171-audio-mix/api-and-models.md` §6.2) name `ApplyResult.deferred` / `restartRequired`, `AudioBackend.applyOp`, `FIFTH_EFFECT`, `SECOND_COMPRESSOR` or `NEEDS_AUDIO_CORE` in `babylonBackend.ts`, read this record's names.

## Alternatives considered

- **Keep the limits in each module and add a cross-check test.** It catches drift after the fact. Each new rule would still mean editing every place.
- **Put the rules in the plugin (beside the wire constant).** The engine's settings parse needs them, and the engine can't import a plugin.
- **Keep free-text answers and add a code beside them.** That leaves two sources for one answer. The texts are derived from the reason instead.
- **Memoise on the whole draft object.** Every unrelated edit (display width) would invalidate it. The `audio` object only changes when the section does.
- **Return copies from the memo instead of freezing.** Copying on every call costs what the parse costs. Freezing makes a stray write throw in tests.

## Consequences

**Positive**
- A new or changed rule is one entry in `BUS_RULES`, covered by one table row (`busCapability.table.test.ts`).
- Adapters only send classified ops. The core's refused counter and the fallback's level-ducking answer come out of the same pipeline (`mixer.pipeline.test.ts`).
- One parse per draft section object. Problems, warnings and settings always agree.

**Negative / costs**
- The parsed section is frozen. Code that wrote into a parsed `AudioSettings` must copy first (none did in the suite).
- e2e `tests/e2e/audio-mix-c.spec.ts` reaches the live path through `backend.mixer.apply` and asserts `reason` instead of message text.

## Deprecates

`MAX_CORE_BUS_EFFECTS` as a `settings.ts` constant (re-exported from `busCapability.ts`); `FIFTH_EFFECT`, `SECOND_COMPRESSOR`, `RESTART_REQUIRED` (`liveMix.ts`); `DIP_UNAVAILABLE` (`structuralDip.ts`); `NEEDS_AUDIO_CORE` in `babylonBackend.ts` (`duckModel.NEEDS_AUDIO_CORE` now reads `reasonMessage`); `ApplyResult.deferred` / `restartRequired`; `AudioBackend.applyOp`, `LiveMix.apply` and `BabylonBackend.applyOp` (now `sendOp` behind `mixOpTarget`); `withAudio`'s own pruning. All removed.

## Open questions

- `duckModel.duckRefusal` still parses hypothetical sections with `parseAudioSettings` (validation of a list that isn't the draft's). Left as is.
- The slot table's own `SlotDeferred` message (`slotTable.ts`) is internal and no longer shown. `waitsForSlot` is what callers see.

## References

`src/engine/audio/busCapability.ts`, `src/engine/audio/audioSection.ts`, `src/engine/audio/mixer.ts` (`apply`, `MixOpTarget`), `src/plugins/audio/runtime/core/liveMix.ts`, `src/plugins/audio/runtime/babylonBackend.ts` (`sendOp`); tests `src/plugins/audio/editor/busCapability.table.test.ts`, `src/engine/audio/mixer.pipeline.test.ts`, `src/engine/audio/audioSection.test.ts`.
