# 0162 technical design: coordinator rulings (after round 2A)

These rulings settle the disagreements between `architecture.md` and `api-and-models.md`, after reading `review-round2-architect.md` and `review-round2-senior.md`. Both authors revise under them in round 2B. Anything that changes product behaviour, scope or schedule went on the owner's list instead (end of this file). The owner's standing rule applies throughout: follow industry practice (Wwise, FMOD, Unity, Unreal) unless there's a measured reason not to.

## Wire and ABI

- **R1. BED_CONFIG.** Each bus carries a `u8 bedSlot` (0xFF = none): the slot its voices feed. Each slot carries a `u16 hostBus`: the bus it decodes into. Stable slot ids keep decoder state across replans (the senior engineer's point), and one host per slot means the core can't receive inconsistent owners (the architect's point).
- **R2. Per-voice effects record.** Use the architect's `SET_VOICE_FX` with **four zone sends** (the wire keeps 4 slots whatever the owner rules on a standby slot), plus **one aux send** (`auxBus`, `auxLevel`) for event `sends.<bus>` (the record), `hpHz` ≤ 20 = off, and yaw: 52 B. Filter and send state lives in the **mixed-voice pool**, not the logical slot (see R12).
- **R3. LISTENER (0x20).** 36 B: the rotation **world → listener** (what clip rotation applies), `rampFrames`, and a flags word whose bit 0 is **snap** (camera cuts). An explicit flag is clearer than overloading `rampFrames` 0.
- **R4. Zones.** One idempotent **ZONE_CONFIG** table (per slot: kernelId, returnBus, state, wet, irFrames; plus the shared return gain). Ring-out is a slot state. An idempotent table makes REPLAY ordering free.
- **R5. Reserved clip ids.** `0xFFFF0000..=0xFFFF00FF` is already HRIR (`audio-wire/src/schema/envelope.rs:19`), so 0xFFFF0001 collides. MagLS filters use **0xFFFF0100**; zone kernels use **0xFFFF0200..=0xFFFF02FF**.
- **R6. Init.** There is **one `myco_audio_init`, with the new parameters** (ABI 2.0). Regions are a pure function of `InitParams` and sit before the arena (`audio-core/src/layout.rs:4`), so a later `init_spatial` call can't add regions. This is blocking for the architect.
- **R7. Kernel blob.** Follow M1's convolver: packed bins (128 / 2,048). Don't add a `flags` word to CLIP_BEGIN; distinguish kernels by a new clip **format** value, and PCM-versus-prepared by a format value too.

## Settings and fields

- **R8.** The settings ranges and defaults are:
  - `bedPriority`: 0..255, default 128 (the same scale as voice `priority`); the root bus defaults to `bed: own` with `bedPriority` 255, which the designer can change. There is no hard-coded "Master always first" rule.
  - `zones.maxActive`: 0..2.
  - `zones.maxIrSeconds`: 1 / 2 / 4 by preset.
  - `doppler.maxSpeed`: 150 world units/s (both values are unmeasured; the listening pass tunes it).
  - `reverbSend`: 0..2, with send × curve clamped to 4.
  - `audio.ambisonic.maxClips`: kept, 1 / 1 / 2 (low / default / high), as the cap on private decoders and wide rings.
- **R9. Equal-power mode keeps beds** and decodes them with a baked 16 → 2 matrix (the record: "decodes beds to equal-power stereo"). Bus behaviour stays the same in both modes; note the fold error at ±90°.
- **R10. Zone presets:** `room`, `corridor`, `hall`, `cave` and `open`. **Occluder fields** use the senior engineer's version (trims, `cutoffScale`, `openness`).
- **R11. The reverb send is taken before the distance gain, with its own send-versus-distance curve** (Wwise's model, so sound designers' habits carry over).

## Architecture changes asked for in the reviews

- **R12.** All six of the architect's changes are taken:
  - zone state goes in a fixed region sized at init;
  - the ray budget is a ray count per frame, derived from `budgetMs` with a measured EMA of ray cost;
  - the D0 ray query excludes given nodes (the source's own colliders) and sensors itself, and writes into a reused result;
  - the filter pool is sized to the mixed-voice count;
  - a filter costs 1.2 µs per biquad;
  - IR blobs go worker → worklet.

  From the senior engineer:
  - filter state per mixed voice (≈ 120 B), not per logical voice;
  - **mono-once filtering** (filter the mono voice before panning);
  - clips are never filtered (cap the filtered-voice term at the mixed voices);
  - per-voice send, high-pass and yaw state is placed explicitly in the pool;
  - the cost model is recomputed.
- **R13. Panner kind dwell:** main keeps a voice in a panner kind for at least 30 frames (S14), on top of M1's crossfade.
- **R14. One listener per frame.** Zones and occlusion use the World that holds the active listener (S19). Other Worlds' sources keep their last occlusion values.
- **R15. Doors:** no new system. `AudioOccluder.openness` (0..1, script-driven) scales transmission, and moving colliders use the same rays. A guide example for a door goes in the samples task.
- **R16. Wide rings** follow the senior engineer's design (a separate region), sized by `ambisonic.maxClips`. The 16,384-frame ring must pass a 300 ms decoder-stall test, or grow to 32,768.
- **R17. Zone return bus:** each zone has an `output` bus (default Master), and its wet signal is added before that bus's effects (Wwise-style aux routing). Both authors recommend it, and it follows the owner's industry rule. It's reported to the owner as a ruling.

## On the owner's list (not ruled)

1. HRTF voices on the **default** preset: 8 where beds exist (as on high; saves ≈ 55 µs), or keep 16.
2. A **standby zone slot**, so a released zone's tail rings out (peak zone memory 18.0 / 9.2 / 3.3 MB on high / default / low; +3.5 days), or 2 slots with a 150 ms eviction fade (12.2 / 6.2 / 1.5 MB).
3. **Load-shedding ladder:** whether to add the limited ladder (cut releasing tails, then one active zone fewer, triggered like the cap and never touching beds or HRTF; +2 days), or none.
4. **The estimate:** ≈ 35.8 person-weeks (the senior engineer's round-2A figure, including the architecture's needs), against the record's provisional 22.
