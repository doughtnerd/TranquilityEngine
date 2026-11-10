# Decisions for the owner's review (ADR 0158, audio events M2)

The coordinator's calls during the M2 build ([plan](../../plans/2026-11-audio-events-m2-waves.md)), each with how to revert it, newest last. The owner's own rulings are in the build log's "M2" entries and quoted in the plan. Confirmed entries are marked "(confirmed)"; superseded ones are marked in their title, not rewritten.

## Summary (read first)

M2 is in wave 1 (the pilot). E1, E2 and E3a are on master with the plan.

**Needs you:**
1. E2's deviations (entry 1): accept, or ask for changes.
2. The lab-VM run of the native automation cost (E5.5), once E5.3 lands.

**Biggest calls so far:** none beyond the plan.

**Proposals waiting for your yes/no:** the AAC decoder's size gate (entry 4).

## Entries

### 1. E2's deviations from ADR 0158, logged rather than changed (wave 0)
- **Question:** E2 (merged before planning) departs from 0158 in six places; accepted records aren't rewritten.
- **Chosen:** logged in the build log and here; no task changes them. (a) Only voices with a low-pass binding are filtered (M1 never applied per-voice `lpHz`; unbound voices stay bit-identical). (b) AUTOMATE, PARAM and CURVES apply on arrival, not stamped; the writer orders AUTOMATE after its PLAY. (c) Pitch automation ramps per frame; virtual voices advance at the block's mean pitch. (d) A voice past `loopEnd` when SET_LOOP arrives plays on to the end. (e) Curve uploads over the 256 KB staging area are dropped past ≈ 660 full curves (upload per asset; E3.1 spreads its replay over batches). (f) STATUS carries no `group` (0158 §6's line); main knows each voice's group.
- **Why:** each keeps M1's goldens bit-identical or avoids a wire record that can't hold eight bindings.
- **If changed:** (a) is `audio-core/src/automation.rs` and `voices.rs`'s filter gate; (f) would need a STATUS voice section, which STATUS doesn't have.

### 2. Babylon debug rows only for event voices (E3.2)
- **Question:** contract C3 adds `voices[].event`; on the Babylon fallback `debug().voices` has been empty for plain voices, and existing tests assert that.
- **Chosen:** the fallback lists only voices belonging to an event instance (nonzero `group`), with `state` "playing", `priority` 0, `audibility` 1, `playheadSeconds`/`world`/`owner` null, `gain` = volume × fade.
- **Why:** keeps M1's fallback behaviour and tests; the panel's grouping needs event voices only.
- **If changed:** drop the `group` filter in `babylonBackend.ts`'s `debug()` and relax the `[]` assertions in `babylonBackend.test.ts` and `audioApi.test.ts`.
- **Open follow-up:** whether changing `loopStart`/`loopEnd` on an already-playing Babylon sound takes effect isn't covered by the mocks; check in a real browser in the E5.4 `@slow` spec (Babylon backend).

### 3. Loop points from files: clamping, ABI bump, Vorbis only (E4.1)
- **Question:** how the decoder reports a file's loop and what to do with odd values.
- **Chosen:** the clip-info record grows from 32 to 40 bytes (flags bit 1 = the file states a loop; `loopStart` u32 at 32, `loopEnd` exclusive u32 at 36); decoder `ABI_VERSION` 0x100 → 0x101 (minor, so main's major check is unaffected). A loop is clamped to the file's stated length and dropped if empty. A malformed `smpl` loop record is skipped; a truncated `smpl` gives no loop. Ogg **Vorbis** comments are read; **Opus** comments aren't, because this decoder build doesn't decode Opus (0158 §4 names Ogg/Opus). Streams need no ranged read: the worker already gets the whole file at stream open, so E4.4 only maps the stream's info into its reply.
- **Why:** additive ABI change; a bad loop in a file should never break playback.
- **If changed:** `audio-decode/src/decoder.rs` (clamp) and `loop_points.rs` (record rules); Opus comments come with Opus decoding.

### 4. Proposal: the AAC decoder's size gate (E4.1 merge)
- **Question:** `myco_audio_decode_aac.wasm` is 1,073,338 B against the 1,100 KB (1,126,400 B) gate, 95%; it was already 94.8% before M2 (loop points added 5.6 KB).
- **Proposal (waiting for your yes/no):** under ADR 0158 the gates are tripwires, so raise `DECODER_AAC_LIMIT` in `native/audio/build.mjs` to 1,280 KB with a build-log line, or leave it until something actually trips it. Later briefs touching `audio-decode` are told the remaining headroom (≈ 52 KB).
