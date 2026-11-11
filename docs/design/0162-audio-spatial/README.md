# 0162 spatial audio (M3): technical design

The build-ready design for [ADR 0162](../../decisions/0162-spatial-audio-ambisonic-bed-occlusion-and-reverb-zones.md) (Accepted, direction). Start with [goal.md](goal.md) and the record, then these documents.

| Document | Owner | What it holds |
|---|---|---|
| [architecture.md](architecture.md) | architect | components and channels, lifecycles, sequences, ownership and staleness, every constant, the pipeline order, memory per preset, **the one cost model** (§7), failure modes, observability, platforms, industry comparison (§12), resolutions (§13) |
| [api-and-models.md](api-and-models.md) | senior engineer | public API, settings and asset data, internal models field by field, byte-exact wire, crate and file layout, editor, Babylon fallback, test plan, **task table** (§10), resolutions (§12) |
| [contracts-architect.md](contracts-architect.md), [contracts-senior.md](contracts-senior.md) | each author | contracts C1–C24 and S1–S23 |
| [review-round2-architect.md](review-round2-architect.md), [review-round2-senior.md](review-round2-senior.md) | each author | cross-reviews |
| [rulings.md](rulings.md) | coordinator | R1–R17 and clarifications; the owner list |
| [working-notes.md](working-notes.md) | coordinator | the owner's working rules for M3 |

## How it was made

Round 1: the two authors drafted in parallel and wrote contracts. Round 2A: each reviewed the other (both "approve with changes"; one blocking issue, a separate init export that couldn't add regions). Rulings R1–R17 settled 17 disagreements. Interestingly, each author had offered to adopt the other's shape on most wire points. Round 2B: both revised and ended with resolutions tables. The coordinator then verified the documents (below).

## The owner's choices so far

From the record (2026-11-11): zone weights per source; no feature flags; HRTF voices 8 where beds exist on high; Babylon occlusion gain-only; below-horizon by listening; beds as a `maxBeds` setting per preset, per-bus `own`/`parent`/`none`, sharing keeps gains, `bedPriority`; follow industry practice. The root bus owning a bed by default (R8) and per-zone return buses (R17) are rulings reported to the owner.

## Coordinator verification

| Check | Result | Fix |
|---|---|---|
| Mermaid diagrams | 10/10 render (Mermaid 10.9.1, headless Chromium) | — |
| Code citations | checked: `envelope.rs:19` (HRIR ids 0xFFFF0000..00FF), `layout.rs:4` (regions a pure function of `InitParams`), `batch.rs:22` (panner bits 5–6), `audioSettingsModel.ts:213` (high `hrtf: 32`), `worldServices.ts:266` (`_worldRaycast` without layers or collider), `Physics.ts:83-85` (the plugin's query has layers, but audio can't import the plugin), `voices.rs:117`, `editorViewport.ts:51-58`, Babylon `webAudioBus.d.ts` (`_inNode`/`_outNode` only), `AudioSource.ts:77` (`priority` 0..255 default 128, the scale R8 follows) | `Collider.ts:31-37` is a few lines off (the `attachedRigidbody` walk is at 26–33); harmless |
| Pool entry size | architecture said ≈ 380 B, API ≈ 448 B | the field-by-field API figure wins; architecture updated to 448 B, 28 / 56 / 112 KB (M3 fixed memory ≈ 4.6 / 10.7 / 20.9 MB with the standby slot, 3.0 / 7.7 / 15.1 MB with the eviction fade) |
| Cost model | two figures: worst high 0.42 ms (architecture) vs 0.63 ms (API), from different per-pass filter and send estimates | architecture §7.2 is the one model; API points to it. HRTF 178 µs vs 166 µs are the same saving counted gross vs net |
| Kind dwell | architecture said 30 frames, API 500 ms game time | 500 ms of game time (clarified R13); architecture updated |
| Send tap | R11 needed a tap point; API §4.4 still said the send skipped the filters | after the voice's filters, before the distance gain (Wwise); API §4.4 aligned |
| Numbers vs spikes | typical-high terms (bed decode 20 µs a bed, 0.5 µs a bed voice, 3rd-order clip 13–23 µs, 2 × 2 s blending zones 47 µs) match `spikes/audio-spatial/README.md` | — |
| Task table | groups re-summed: A 31, B 25.5, C 39.75, D 28.75, F 3.5, E 35.5 = 164 d, plus a 14 d named reserve = 178 d ≈ 35.6 pw | matches the document |
| Stale decisions | the record's "existing projects unchanged" and flags removed earlier; "16 → 8 saves 55 µs" in the record is superseded (high is 32 → 8, ≈ 166–178 µs) | write back to the record at step 9 |

**Estimate, line by line:** record 22 pw → round 1 32.7 pw (tests, benches and tooling priced; the physics query D0; 16-channel streams; a named reserve) → round 2B 35.6 pw (+14.5 d: private ambisonic decoders, wide rings, the equal-power matrix, the allocation-free ray query, the shared-return scaling, fit sweeps and worst-case scenes, the in-core IR fallback moved from reserve to tasks). Optional: standby zone slot +3.5 d, load-shedding ladder +2 d (both: 36.7 pw). (Superseded by the final figures below.)

**Cost (container wasm p50, est.; p99.9 needs the lab VM):** typical high ≈ 0.10 ms net (gross 0.28), worst high ≈ 0.42 ms; typical default ≈ 0.18 ms (≈ 0.13 if its HRTF goes to 8); low ≈ 0.04–0.11 ms. M1's high preset is already over 0157's 1.3 ms p99.9 on the lab VM; the adaptive cap keeps protecting it.

## Owner decisions on the design (2026-11-11)

All recommendations accepted, and the extra time: default-preset HRTF 8 where beds exist; a standby zone slot on high and default (stored as `zones.standby`, 1 / 1 / 0) and a 150 ms eviction fade on low; the M3 load-shedding ladder; the estimate; Babylon zones inert with one warning. Plus the test cadence: intensive tests at wave and milestone end (working-notes.md). Recorded in the record's "Revision 4".

**Final figures:** 169.5 days of tasks (A 31.5, B 25.5, C 44.25, D 29.25, F 3.5, E 35.5; re-summed by the coordinator) + a 14-day named reserve = **183.5 days ≈ 36.7 pw**. Critical path ≈ 45 days of chain; about 9 calendar weeks to M3e with two seniors and three mids, 10–11 with the reserve and the owner's gates. Cost (container wasm p50 net, est.): typical high / default / low ≈ 0.10 / 0.13 / 0.04 ms, worst ≈ 0.42 / 0.26 / 0.10 ms. M3 fixed memory ≈ 20.9 / 10.7 / 3.0 MB.

## Notes for the build

- Wire changes are ABI 2.0 with one `myco_audio_init`; regenerate `wire.generated.ts` and the schema hash.
- D0 (the core ray query with node and sensor exclusion, reused result) touches engine core and the physics plugin; it has no dependency on the bed and can go first.
- Voices without sends keep M2's filter order, so M2's goldens must stay bit-identical; voices with sends differ by float rounding (state it in the task's acceptance).
- Main re-sends `SET_VOICE_FX` with every promotion (the pool holds no state for virtual voices).
- The listening pass items are exit checks per milestone (bed A/B, switch dip, floor-below, material values, send curve, Doppler speed).
