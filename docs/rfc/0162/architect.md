# RFC review of 0162 (spatial audio, M3): architect

**Reviewer lens:** system architecture, which thread owns what, performance on weak hardware, failure and recovery, observability, benchmark method.

**Verdict: approve with changes.** The split (continuous work in the core, budgeted work on main) is right and follows 0157. The bed, MagLS, building into the mixer and load-balanced staggering all have measurements behind them. Four things need fixing before acceptance, because the code underneath does not work the way the record assumes.

**Top 3 concerns**
1. **One shared bed cannot pass through the bus tree.** Every voice mixes into its own bus, and that bus's effects, ducking and meters run on its stereo buffer. A bed decoded once has no bus to go through.
2. **The budget uses the wrong statistic, and part of the cost is missing.** 0157 budgets p99.9, and the record budgets p50/p99. The record also leaves out each bed voice's mixing cost, and a per-voice occlusion low-pass that does not exist yet. It counts the HRTF saving at about 1.7× what the frozen coefficients give.
3. **Rate-bound data and recovery.** Zone spectra and the MagLS filters only work at the sample rate they were built for. The record does not say how zones, occlusion and LISTENER are restored after a hard rebuild, or how they are rebuilt after a rate change.

## Issues

1. **blocking. Where the bed goes in the bus tree.** Voices mix into their bus's stereo buffer, then each bus runs its effects, snapshot low-pass, gain and meter (`audio-core/src/bus.rs:23-29`). M1's HRTF output is also added "to the voice's bus" (`panner.rs:35-36`). §1 (record L61) has one bed decoded once. So any bed voice on a bus with a filter, compressor, duck or mute either skips those stages, or the bed has to be per bus. Ambisonic clips "have a bus" (L68) and hit the same problem. **Change:** say it. Either keep one bed per root bus that has spatial voices (decode about 20 µs each, capped at, say, 4 beds, with any other bus falling back to equal-power), or apply bus gain per voice before encoding and allow bed voices only on buses with no effects. Budget whichever you choose.

2. **blocking. Budgets should be p99.9, as 0157 and 0158 say.** 0157 L192 says "Worst case, not averages: p99.9 over ≥5 runs", and 0158 L127 does the same. The record's §8 (L95) gives p50/p99 and treats p99.9 as unknowable on the container (spikes README L7). It also adds component p99s together, which is not the p99 of the scene. **Change:** state each M3 allowance at p99.9 as a target, mark it "to be measured", and make the integrated lab-VM run (see Performance) an exit gate. If the author thinks p99.9 cannot be measured on shared VMs, that is a question for the 0157 owner (an amendment), not a quiet switch to p99.

3. **major. Mixing cost and the "0.5 µs a voice" claim.** The bed spike times encoding only: "the bed cases measure encode, not `c_v`" (bed README L270). Each bed voice is still a mixed voice at 3.0–3.8 µs (architecture §6.1). Encoding replaces the equal-power pan (`c_mov` 0.86 µs for a moving voice), so the true marginal cost per voice is about 0.5 − 0.86 µs, which may be a saving. The decode is the only fixed new cost. **Change:** rewrite Consequences L119 and the §8 subtotal as "decode 20 µs plus (encode − pan) × N". The bed does not lift the mixed-voice cap. Note that the frozen high scene already drives the adaptive cap down to 16 (architecture §6.3), so "≈ 240 bed voices" is not a scene the high preset can run today.

4. **major. The HRTF saving is overstated.** The ≈94 µs saving (spikes README L40) comes from `hrtf16` = 214 µs. That case turns every voice every quantum under `KERNEL_BUDGET` 2 (`spikes/audio-spatial/bed/src/cases.rs:369-381`; `panner.rs:248`). Kernels cost 67–84 µs each and are capped per quantum, not per voice, so halving the voices does not halve them. With the frozen `c_hrtf` of 7.4 µs the saving is 8 × (7.4 − 0.5) ≈ 55 µs. **Change:** use the frozen coefficients, or measure 8 against 16 voices inside `audio-bench`.

5. **major. A per-voice low-pass for occlusion does not exist.** `lpHz` "is not applied" (`voices.rs:26`, `:138`). A voice gets its own biquad only when it has an automation low-pass binding (`automation.rs:22-27`). §3 (L75) and §7 assume the filter is already there. **Change:** add a per-voice occlusion biquad to the budget (`BIQUAD` 1.2 µs × the occluded mixed voices, up to ≈0.3 ms at 256), or bypass the filter while a voice is fully clear. Say how the occlusion cut-off combines with `lpHz` and `lpAuto` (the minimum of the three).

6. **major. A per-instance filter cannot sit after panning.** §6 (L89) keeps "one filter per instance (`group`)". The spike summed 4 unpanned voices into one instance buffer. Spatial instance voices, though, are panned, HRTF'd or bed-encoded one by one, and may sit on different buses. **Change:** make the event filter a per-voice binding on M2's existing `lpAuto` biquad path. That works for kind 1 and kind 2 voices alike, and the cost is about the same.

7. **major. FLAC cannot hold 9 or 16 channels.** FLAC allows at most 8 channels (research README L59 flags this). §2 (L67) promises 2nd- and 3rd-order FLAC. **Change:** use WAV only for orders 2 and 3, and FLAC for 1st order.

8. **major. Occlusion collides with gameplay layers.** A collider has exactly one `layer` (`physics/runtime/Collider.ts:21`), and a project has at most 16 layers (`engine/physics/layers.ts:9`). Moving a wall onto `AudioOccluder` (L74) changes how it collides in gameplay. **Change:** add an occluder membership bit that is separate from the layer (a physics-side change, with its own record line), or use a sensor collider, and say which.

9. **major. Who owns the occlusion smoothing.** The record has the core smooth occlusion (L75), while selection on main needs the smoothed value for the no-gap rule. That puts the same state on both threads. The spike smoothed on main for 60 ns per source. **Change:** main owns the smoothed value and sends it with `rampFrames`, and the core only ramps it. PLAY then needs an occlusion field (from PLAY's reserved u16 or appended words; a minor wire change), so a promote or replay starts at the occluded level.

10. **minor.** PLAY's panner is in flags **bits 5–6** with values 2–3 reserved (api-and-models L240), not "bits 2–3" (L37). Doppler should go into main's existing `pitch` and `rampFrames` instead of a new core smoother, so that `PlayheadTracker.rateOf` (`replay.ts:101-105`) keeps the replay offset right. The LISTENER quaternion has to use the same `rampFrames` as that frame's direction changes, or clips and voices drift apart.

## Failure modes

- **A hard rebuild in the middle of a zone blend.** The REPLAY header carries the automation mirror (`replay.ts:13-15`), but the record does not list zone state, LISTENER, occlusion or the instance filters. Spectra come back through the 256 KB-per-quantum chunk budget (`chunker.ts:5`), behind the HRIR and the clips. If the two zones return at different times, one fades in alone and the level jumps. **Rule:** REPLAY carries the zone table and weights. A zone is audible only once it is resident and fades in over ≥100 ms. Tails are lost, which is acceptable inside the gap.
- **A rate change with IRs prepared at 48 kHz.** The convolver region is sized from the rate (`convolver.rs:189`, `:283`). Partition counts change at 44.1 kHz (convolution README L207). The MagLS filters are "at 48 kHz only" (bed README L273), and the core refuses HRIR data at any other rate (`clips.rs:542`). **Rule:** keep each IR's PCM on main, as kept clip bytes, and re-prepare it in the worker at the new rate through an `updateReserved`-style path (`clipRegistry.ts:96-100`). Ship MagLS sets for 44.1 and 48 kHz (128 KB), or resample the time-domain filters. Until a zone is ready again it plays dry.
- **The worker dies while preparing an IR.** The record says to "spread across quanta" as a fallback (L82). That needs the IR's PCM and a second buffer set inside the core, which the record has not budgeted. **Rule:** load tokens like clip loads. The old zone keeps playing (or none plays) until the new one is ready, with a timeout and one warning. Fall back to spreading only when memory for it is reserved.
- **An occlusion pass starves the frame.** Smoke p99.9 was 3–20× the budget (occlusion README), and every ray allocates (`Physics.ts:83-85`; `PhysicsCore.ts:682-687`: `map`, a spread `hypot`, the hit object, two `Vector3`s). That breaks the rule that main allocates nothing per frame (architecture §6.4). `performance.now()` is coarse on pages that aren't cross-origin isolated, so a 0.25 ms time check is noise there. **Rule:** a ray-count budget adjusted from a running mean, an allocation-free ray path on the physics World service, and no casts at all for culled or virtual voices.
- **A clip arena full of 16-channel clips.** int16 16-channel audio at 48 kHz is 1.5 MB/s, so one minute is 92 MB. That is most of the default ceiling and more than low's 64 MB (§5.3). An upload of that size also delays every other clip by about a second, and lengthens a rebuild's gap (§7: "~1–3 s for 64 MB"). **Rule:** stream orders 2 and 3 by default (16-channel rings: state the memory), and refuse with a warning that names the order.
- **A backgrounded tab.** Batches stop and ramps hold (architecture §3.8). A held Doppler factor keeps a shifted pitch for as long as the tab stays hidden ("keep playing" mode). On return, the position delta over a clamped `dt` gives a false velocity. **Rule:** Doppler decays to 1 when batches stop, and velocity history resets on `visibilitychange`.

## Performance

- **Statistics:** use p99.9, as 0157 does (Issue 2). The base is already over budget: the high preset measured 5.45 ms p99.9 against 1.3 ms (architecture §6.1, L649–651). So "beyond 0157's remaining reserve" is measured against a reserve that does not exist. The record should give the new high total and the burst check (4 × quantum ≤ 7.5 ms, §6.2) on the reference machine, or say plainly that they are unknown.
- **The low end:** the low scene costs 0.59 ms p50 and 2.35 ms p99.9 on the lab VM. On a phone several times slower, that leaves no room. The low preset should default to: no bed (equal-power, or 1st order), one 1 s zone (1.7 MB), Doppler on, and about 16 rays a frame. Write these down now as provisional numbers.
- **Do the measurements support the numbers?** Partly. The components are timed separately in hot loops (no `pace=1`, no cache-cold zones, convolution README L202). The bed is not timed inside `audio-core` (spikes README L65). The cheap Chromium cases are batch means (bed README L59). Occlusion was timed in Node, not a WebView. **Required:** one integrated M3 scene in `audio-bench`, layered on the frozen high scene, with `pace=1`, at least 5 runs × 60 s. Add work-unit coefficients for encode, decode, zone, prep and the occlusion biquad. Add metered CI scenes.
- **Adaptive cap:** decode, zones and zone preparation add to the floor that the cap cannot shed (§6.3). Define a ladder for shedding load under pressure: drop the second zone, then lower the bed order, then switch to equal-power.

## Cheaper alternatives

- **Prepare spectra at import time**, one set per rate (44.1 and 48 kHz) as an asset. That needs no worker and no preparation work in the core, and a rebuild only re-uploads. The cost is about twice the IR's size on disk.
- **Doppler through `pitch`**, as main already sends it: no new path in the core.
- **Event filters on M2's per-voice `lpAuto`**, as in Issue 6.
- **Cache occlusion results for static occluders** and recast only after the source or listener has moved more than about 0.5 m. Cast only for mixed voices, at most 256, not all logical voices.
- **On low:** a 1st- or 2nd-order bed, and an FDN reverb for zones.

## Questions for the author

1. Is the bed one per root bus, per bus, or one with no bus effects? Can a bed voice be ducked or metered?
2. 0157 sets p99.9 as the budget statistic. Are you proposing to amend that, or does M3 commit to p99.9 targets?
3. How many zones can be resident at the peak: active, still ringing out, and being prepared? And are zones a fixed region set up at init (§5.1), or do they live in the arena, which is never compacted?
4. What is restored in REPLAY, and in what order: zones, LISTENER, occlusion, instance filters?
5. Will the MagLS filter sets ship one per rate, or be resampled at run time?
6. What do the new counters cover? I would add: bed voices, zones resident and their memory, preparation latency, rays per frame, the oldest occlusion age, Doppler clamps, and HRTF↔bed switches per second (to catch thrashing at 8 slots).
