# Round 2: architect reviews api-and-models.md

**Verdict: approve with changes.** The document is concrete, buildable and well tied to today's code. The public API, settings, voice table, envelope and versioning rules, the one-schema generator and the test plan are all sound, and I'd build on them as they are. There are three structural problems:
- The ABI makes every trap a `processorerror`, which rules out recovery that keeps the clips.
- Status buffers return to the worklet only at frame time, so status stops while the tab is hidden.
- Stream seeks have no epoch, so pre-seek audio can land in the ring after the flush.

The plan also leaves the riskiest platform work (WebView2 and WebKitGTK) to the final soak, and it has no quirk buffer. All of these have small fixes.

## Contracts

| | Status | Change needed |
|---|---|---|
| C1 imported memory, re-init | **Not met.** §5 says the wasm owns memory and a panic is seen as `processorerror` | §5: link with `--import-memory`; the shell creates the `Memory`; `myco_audio_init` allocates deterministically; add `myco_audio_adopt_arena() -> i32` (checks the directory checksum in the arena header). The shell wraps `myco_audio_process` in `try` and re-instantiates over the same memory. RESET `keepClips` (§4.2) already fits |
| C2 direct chunk copy | **Not met.** `clip_write` copies from the inbox | §5: add `myco_audio_clip_chunk_ptr(clip, frame_offset, bytes) -> *mut u8`; the shell does `HEAPU8.set(src, ptr)` straight from the transferred buffer. Keep `clip_write` for tests |
| C3 STATUS fields | **Partly.** It has `underruns`, `lateCommands`, `workUnits(Max)` and flags | §4.3: add `u16 mixedCap`, `i32 minSlackFrames`, `u16 loadPermille`, `u32 underrunFrames`, `u16 traps`, `u32 arenaUsedKB`, `u32 arenaLargestFreeKB`. Add sections `clipEvents {u32 clipId; u32 code}` (resident, refusedCeiling, refusedGrow) and `streamEvents {u32 streamId; u32 code}` (starved, eos, error). The loader's `copying → ready` (§3) has no signal without them |
| C4 underrun method | **Not met.** §4.3 says "from `currentFrame` gaps" | `currentFrame` never gaps. Count from frames against `Date.now()` drift (architecture §7). These fields are written by the shell, not the core |
| C5 direction not pan | **Not met.** `f32 pan` is in PLAY, SET_PARAMS and SET_MIXED | Replace it with `f32 dirX, dirY, dirZ` (listener space, unit length). The core derives the equal-power pan. M3 then needs no major version bump |
| C6 owner World | **Partly.** The clip registry has `holders`; the voice table has `owner` (an `AudioSource`) only | §3 voice table: add `world: Uint8Array` (World key). Selection forces voices of inaudible Worlds virtual; `releaseWorld` stops them |
| C7 streams | **Not met** | §4.1: STREAM_OPEN gains `u32 epoch; u32 startFrame`; STREAM_CHUNK gains `u32 epoch` (reuse `reserved`); SEEK gains `u32 epoch`. New kind STREAM_CREDIT (worklet → worker: `streamId`, consumed frames, returned buffers). CLIP_BEGIN and CLIP_CHUNK may also come from the worker (M1b) |
| C8 first STATUS as READY | **Partly.** Hashes are exports, and A0.3 checks a ping | §4.3: flag bit "init done" plus `abiVersion` in the first block, or the shell posts the three hashes once |
| C9 ceiling and format settings | **Not met.** §2 has no memory setting; presets are "numbers only" | §2: `audio.clipMemoryMB` (16..1024, default 128) and `audio.clipFormat` (`"i16"` default, `"f32"`) |
| C10 frame timestamp | **Not mentioned** | §6: the audio system reads the frame's rAF time through an `@internal` Engine hook |
| C11 `maxVoices` | **Met** (§3: steal by priority before the global rule) | Say it in §1's docs and in the guide |

## Issues

1. **blocking: status buffers starve in the background and at low frame rates.** Location: §4.3, §3 mirror. STATUS buffers (a pool of 4) are "applied once per frame". If they return only with the next frame's batch, the worklet runs dry at 20 Hz frames (3 blocks per frame), and permanently while hidden (no frames). Ends would then never be freed. Fix: the host copies each block into the mirror's accumulators in `onmessage` and returns the buffer at once (RECYCLE, or with the next batch if one is pending within 16 ms). The pool becomes 8. In the background the host frees ended slots in `onmessage`.
2. **blocking: trap recovery as specified loses every clip.** Location: §5 memory ownership and `process` "catch_unwind-free"; A3.4. See C1. A `processorerror` kills the node. The new node has a new global scope, so the whole arena (up to 128 MB) has to be re-decoded and re-uploaded. That takes seconds, and every voice is meanwhile waiting for data.
3. **major: seek and stream ordering.** Location: §4.1 SEEK and STREAM_OPEN. See C7. "The decoder then sends STREAM_OPEN" doesn't say who tells the decoder. Without an epoch, chunks already in flight from the old position are pushed after the flush, and you hear a blip of old audio.
4. **major: no early platform check.** Location: §9. The worklet in WebView2 (Tauri) and WebKitGTK is first exercised at C3, the soak at the end of the plan. The ADR names the real-engine round trip as the riskiest item. Fix: an A0.7 (M, 2 days): `tauri:dev` on Windows and a WebKitGTK build both play the A0.3 tone; set the autoplay policy per webview; play mode's second Engine shares the host. Put it on the critical path before M1a.1.
5. **major: the CI benchmark can't catch regressions.** Location: §8 and C1 ("audio-bench prints work units"). Modelled work units don't change when the code slows down. Fix: `build:audio` also emits a metered test wasm (an instruction counter injected after linking). CI counts instructions in Node, so the gate needs no Rust. The work-unit model is checked against those counts (±20%).
6. **major: the estimate has no quirk buffer.** Location: §9. The tasks sum to **89 days (17.8 weeks)**, which is already the ADR's padded figure: the ADR has 13 nominal weeks plus quirks. There are also tasks missing:
   - A0.7 (issue 4);
   - soft recovery (C1);
   - the metered build (issue 5);
   - the host and World-service lifecycle across two Engines;
   - unlock re-arm after `interrupted`.

   Fix: add them (≈ 8 days) and a named 10% quirk reserve, or show where the 13 nominal weeks are. The S load (36 days) is the real constraint, as you say.
7. **major: replay can't fit one batch.** Location: §4.2 caps a batch at 64 KB with overflow carried to the next frame. Replaying 4,096 voices × 48 B is 196 KB, which spreads over 4 frames, and each carried record goes out late. Fix: allow RESET batches up to the 1 MiB inbox. Better, let a batch carry its own `firstFrame` per chunk, so carried records keep their stamp.
8. **minor: posting from `process()`.** Location: §4.3. This is necessary (no timers), but the envelope allocates on the audio thread. Keep the transfer-list array preallocated, and skip the post when the pool is empty (state that rule).
9. **minor: dwell in quanta.** Location: §3 selection, "8-quantum dwell". Selection runs once per frame, so 21 ms is below one frame at 60 Hz and does nothing. Use 3 frames (or 50 ms).
10. **minor: priority barely affects mixing.** Location: §3, `audibility = gain·(1+priority/128)`. At most ×2 (+6 dB). That's fine for mixing, but document that priority mostly governs stealing.
11. **minor: `myco_audio_dispose` wording.** Location: §5, "context rebuild reuses the instance". A rebuild creates a new global scope, so there's nothing to reuse. Only soft recovery (C1) reuses anything, and that's the memory, not the instance.
12. **minor: pitch up to 16×.** Location: §1. Each voice reads 2,048 source frames per quantum. Its work units must scale with pitch, and the arena read is cache-cold. Fine, but count it in A3.3.
13. **minor: lazy load and servers.** Location: §6. Say that the host is created by a `myco.audio` World service (lazy dynamic import, not run on servers or headless Worlds), so the ADR's "servers never load the core" holds.
14. **minor: M2 hook.** Location: §3 and §4.2. Reserve `group: Uint16Array` in the voice table and a `u16 group` in PLAY now (as a minor version), so event instances don't force a major version change.

## Agreements

- **Issue 1 (`volume` alias):** agree.
- **Issue 2 (HRTF lost until M3):** agree. It's a real regression, so add it to the ADR's behaviour table and the guide.
- **Issue 3 (distance):** replicate Web Audio exactly. That keeps old projects sounding the same; fix the doc comment.
- **Issue 4 (locked voices without a timeout for `AudioSource` and loops):** agree, strongly.
- **Issue 5 (`stream` ignored in M1a):** agree.
- **Issue 6 (virtual voices don't duck):** agree. A virtualised trigger is inaudible by definition.
- **Issue 7 (core demotes, reports `demoted`):** agree. Add `mixedCap` (C3) so selection doesn't re-promote.
- **Issue 8 (`libm` everywhere):** agree; keep the tolerance as the fallback.
- **Issue 9 (status cadence):** agree, with issue 1's buffer fix and slowing to 48 quanta when no batch has arrived.
- **Issue 10 (lookahead):** answered: clamp(2 frames, 8 quanta, 100 ms) on top of the burst lead Λ. The 2-quantum floor is too low (architecture §4.3).
- None rejected.
