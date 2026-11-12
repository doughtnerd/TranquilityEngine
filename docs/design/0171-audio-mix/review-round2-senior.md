# 0171 audio mix (M5): round 2A review by the senior engineer

Reviewed: `architecture.md` (revision 1) and `contracts-architect.md` (C1-C26), against my `api-and-models.md` and `contracts-senior.md` (S1-S14). I also read ADR 0147 in full, which I had skipped. Nothing outside this file was edited. Line numbers cite the merged tree: `architecture.md:n` and code as before. "Round 2B" below means my revision of `api-and-models.md` after the coordinator's rulings.

## 1. Verdict

**Approve with changes; the two documents are close.** The architecture answers every S contract in substance. It is sharper than my draft in several places (keyframes keyed on STATUS *frames*, not counts; the shell's 96-quantum `loadPermille`; the convolver run-out; the live view through the same Worker as a file; rotation instead of a file cap). Of the six disagreements the coordinator listed, I **concede three** (six lanes, 16-file rotation with 64 MB, the architect's STATUS spare rule is already met), **converge on one** (a single fader law, §4.2) and **hold two** with reasons (the stamped dip, and `BUS_MIX`'s retirement kept only if asap ramps are bit-identical). I found **2 blocking, 6 major and 7 minor issues** (§6). Both blocking issues are timing and bit-identity facts the two documents must agree on before M5-0's wire task starts. My task table grows by about **16 days** if every C and ruling below is taken (§7): 300 days of tasks, 360 with the 20% reserve (72.0 person-weeks), still inside the record's 62-75.

## 2. The six disagreements, one law each

**1. Lanes: six against seven.** *I concede six* (A, R, S, G, D, U). Their lane G (authored mute, script mute and solo, monitor mute and solo, the dip) removes two lanes from the per-sample product, and the independent-writer problem I raised (a dip ramping a lane back to 1 would unmute a monitor-muted bus) is solved on main: **main owns G's target**, computed as the product of its five inputs, and sequences the dip as "target 0 until the dip's window ends, then the composed target". That needs one more main-side piece (task Mx3, 2 days) and two rules for the architect: G ramps are linear with a length main chooses per record (10 ms for mute and solo, 20 ms for the dip, `architecture.md:423, 551`), and two records for one lane in one quantum apply in frame order (C14). Contract S1 is therefore **met after my change**: lane ids become 0 A, 1 R, 2 S, 3 G (main-written), 4 D, 5 U (core-owned). One residual: sends are taken before the gain stage, so G does not silence them (issue 1).

**2. The ≤ 50 ms fader gate.** Both documents already agree on the law's substance: **asap, never stamped; a direct flush from the pointer handler; measured from `event.timeStamp` to the first changed core output sample, device latency excluded** (`architecture.md:196-198`; my §6.6). They differ only in the ramp (my 5 ms against their 10 ms) and the flush wording. **I take theirs: `DRAG_RAMP_MS` = 10 for lane A and lane G drags**, one post per pointer event and at most one per 4 ms. A 5 ms ramp leaves plateaus between 16.7 ms drag steps; 10 ms smooths them and costs 5 ms of the gate, which their budget (≤ 10 ms plus the post, est.) absorbs. `BUS_MIN_RAMP_MS` (5, today's `RAMP_MIN_MS`) stays only as main's floor for script jumps. In the core, `frames = 0` is a literal step (C14), used by replay and RESET only; main never sends it for a live change. I keep my preview path **outside the hook** (issue 4).

**3. Presence ducking in the core in M5-0.** `architecture.md:455` (§4.6 "Staging") says the same: M5-0 ships the order, the duck lane with presence mode and the gain lanes; M5c adds level mode. **My Dp1 stands.** The only gap is stamping: C15 calls presence flags "a level, not an event" sent on change; I stamp `BUS_PRESENCE` at the voice's frame. Both fit: the record is a level, and its `frameOffset` may be asap. I keep the stamp because it is free and starts a presence duck on the sound's own frame.

**4. Constants.** *Rotation:* **adopt 16 files with the oldest deleted first** on Tauri and Android (`Storage.list` and `delete` exist for `cache`, `platform/Storage.ts`), so a test build never stops recording; on the web, where a download cannot be deleted, the trigger refuses a seventeenth save in a session with a toast. My "8 files, estimate" goes. *Decompression cap:* **`CAPTURE_MAX_UNCOMPRESSED_BYTES` = 64 MiB** (twice the largest ring, which is what I assumed), checked from the header before inflate and again while inflating. *STATUS spare:* mine is 2,748 B of 20,480 against their ≥ 1 KB requirement; after the changes in issue 3 it is about 2,650 B, still met. *Record envelope (C1):* my 20-byte head already has kind, length, epoch (u16), frame (f64), seq (u32) and a flags byte; I add the **`deferred` flag (bit 0, the real stamp in the payload as f64)** and state the 1 s bounded-disorder rule. Section 4 lists the remaining capture-format changes.

**5. Per-minute capture sizes.** The architect is right and my §5.7 was muddled. I quoted S3's delta-encoded figures (0.08 / 0.15 / 0.25 MB per minute) as "the saved size" with a hedge, then noted raw rates. With raw STATUS (record change 2), S3's "Compressed" table, raw column, gives **0.27 / 0.84 / 2.45 MB per minute saved** at 64 / 256 / 1,024 voices (`architecture.md:581`), and raw rates in the ring of 1.70 / 4.08 / 10.85 MB per minute plus M5's STATUS growth. Round 2B restates §5.7 with those figures and drops the delta numbers from the format section. My limits (64 MiB decompressed, 256 KB per record) are consistent with a 32 MB ring that saves to about 7 MB at 1,024 voices.

**6. The architect's extra constraints.** *Refuse any level-rule cycle:* **agree** (C17); my §2.2 refuses only the ancestor and self cases; round 2B adds the Kahn cycle check over level rules with the message naming the rules, at most 8 level rules per project (`MAX_DUCK_RULES` becomes 8 level plus presence rules up to 32 in total), and presence rules exempt from the cycle check but not from the ancestor check. *A structural edit that can't get a slot is applied at the next Play rather than refused:* **agree**, with one refinement: the op is **queued and retried each time a tombstone recycles** (≈ 40 ms), so "applies at next Play" is left for the fifth-effect case and for a project that is already at 32 live buses (which the parse refuses anyway). I replace my "refused visibly" with `ApplyResult.deferred`. *The ladder step skipping when only master is metered:* **agree**; Ld7's acceptance gains it.

## 3. My contracts S1-S14: status

| # | Status | The exact change |
|---|---|---|
| S1 lanes and ramps | **met** after my change | six lanes (§2.1); `BUS_RAMP` lane ids and the G composer as above; a non-finite target **leaves** the target (C14), not "refused"; a full due list applies at the quantum start and counts `busRecordsEarly`; two records for one lane in a quantum apply in frame order |
| S2 stamped config | **partly met** | C16 gives the structural record a frame at quantum granularity; it does not say whether `BUS_DUCK`, `LOUD_CONFIG` and `BUS_PRESENCE` may be stamped. I will state: only the structural slot record and `BUS_PRESENCE` carry a meaningful frame; `BUS_DUCK` and `LOUD_CONFIG` are asap. The architect adds that sentence to §4.7 |
| S3 tombstones | **met**, simpler | their tombstone is a silent root with lanes held at 0 and no effects (C16); mine was a sentinel parent. **Take theirs** (no wire sentinel, bytes of BUS_CONFIG stay identical) and **drop `TOMBSTONE_TAIL_FRAMES`**: recycle when the dip has ended and no voice references the slot (C21), about 40 ms. The shared convolver, not the bus, carries tails |
| S4 dip, glides, sends | **partly met** | `DIP_FRAMES` = 960 at 48 kHz and `COMPRESSOR_SMOOTH_MS` = 20 are given (`architecture.md:212-222, 552`). **Not met:** the dip (and mute and monitor) must also scale the bus's reverb send (issue 1); the overlap and queue rule is missing (I assume one structural sequence in flight, same-frame ops coalesced); the F0 race (issue 2) |
| S5 ring and limits | **met** | ring 4 / 16 / 32 / 32 MB, `deviceMemory` cap 8 MB per GB with a 4 MB floor, index 4,096 entries, cap 64 MB, largest record 256 KB. I change the header's `keyframeEveryStatus` to **`keyframeIntervalMs`** = 1000 (keyed on STATUS *frames*, which fixes the idle-cadence stretch they found, `architecture.md:340`) |
| S6 clock | **partly met** | align my EPOCH reasons (start, trap, stall, device, rate, latency, mode) and GAP reasons (paused, rebuild, held, dropped, recordTooLarge) to C2 and C3; EPOCH gains `timeOffset` (f64 s); drop my "heard frame = frame minus latency" in favour of their axis (**rendered frames**, the cursor reading "heard ≈ D + output latency later", `architecture.md:322`); the live link's framing (`architecture.md:326-334`) needs nothing my format lacks once `deferred`, gap `dropped` with a seq range, and in-stream names exist |
| S7 CPU | **met** | adopt C8: shell fields `busyMsTotal`, `quantaTotal`, `clockStepMs`, new `clockSteps` (u16); **`loadPermille` is filled by the shell** (the last 96 quanta, 0 until 96 have run), so my "stays 0 on the wire" and §12 item 8's first half are withdrawn. I keep the cumulative counters as **f64** (no wrap logic for main; 16 bytes) against C8's wrapping u32; the architect accepts or says wrap is wanted |
| S8 loudness data flow | **met** | take semantics, ring of 32, seq restart at an EPOCH with feeds reset and histograms kept (`architecture.md:245`), tp gate = ceiling − 6 dB. Changes on my side: master is **implicit** in `LOUD_CONFIG` (C11), flags gain "tp gate active", `elapsed` excludes shed and gap time, `Bus.loudness` gains a **lower-bound** indicator on `maxTruePeak` (C22) |
| S9 ladder | **met** | a new header field `loudShed` (0 or 1) beside `m3Shed`, which keeps counting bed and zone steps (C13); I stop assuming `m3Shed` counts it |
| S10 sidechain | **met** | the law is given (6 dB knee, peak instant attack with 10 ms release, RMS 10 ms, one-pole attack and release, min per target, pre-fader tap after effects and the snapshot low-pass, `architecture.md:442-453`). `MAX_DUCK_RULES`: 8 level rules (C17) plus presence rules to 32 total |
| S11 constants | **met** | published as in my doc, with the changes listed in §4; their constants `DRAG_RAMP_MS` 10, gate ramp 10 ms, dip 20 ms enter the published list |
| S12 budgets | **met** | the typical scene (≈ 124k instructions, 75 µs floor est.) and worst (≈ 375k, 225 µs; allowance 0.10 ms) and the recorder at ≤ 1 ms per second fill my `BUDGET_*` placeholders (`architecture.md:611-612`) |
| S13 rebuild and replay | **met**, change mine | they replay lanes at their **end state** and a dip as applied (`architecture.md:243`); I had replayed the remaining ramp. Take theirs: replay with `frames = 0` after RESET, order RESET, BUS_CONFIG (slot order), rules, presence, loudness config, lane values |
| S14 20 KB and pool | **met** | spare 2,748 B against ≥ 1 KB; the only other consumer of the old size is `bufferPool.ts:73`, which reads the constants |

## 4. The architect's contracts C1-C26: my answers

| # | Answer |
|---|---|
| C1 envelope | Met by §5.3's 20-byte head (kind, len, epoch u16, seq u32, frame f64), `perfMs` in event payloads. **Adding:** the `deferred` flag bit 0 with the stamp as f64 in the payload; the bounded-disorder rule (no frame more than 1 s before an earlier-written record's within an epoch). Rc1 |
| C2 EPOCH | Add `timeOffset` (f64 s), `reason` per C2's list including "first"; the limiter latency stays. Rc1 |
| C3 gap | Reasons as C3; payload `perfFrom`, `perfTo` (f64) and, for `dropped`, first and last missing seq (u32 each). Rc1 |
| C4 keyframe | **Changes:** per bus add each lane's **target** beside its value (A, R, S, G; D and U as last reported); per metered bus store the **readings** (M, S, I, LRA, maxTP, maxM, elapsed, flags) so a truncated file shows the live meter's values; events gain a state byte; add the active snapshot name id. I withdraw my "decode the whole recording at open for loudness" (§5.5) and adopt theirs: M and S recomputed exactly from sub-blocks, I and LRA held from the last keyframe (≤ 1 s stale, `architecture.md:344`). Voice rows shrink to ≤ 24 B (reason as u8, event instance from the events section) so 8,192 voices stay under the 256 KB largest record with margin (229 KB at today's 28 B is too tight). Rc1b |
| C5 names | Met: META name table plus in-stream NAMES records before first use; strings are data, cut to 256 B |
| C6 other records | Met except: add a ring-only **WRAP** record (type 0x09, never in a file; the saver strips it); MIXOP origin gains "compare"; markers are written for owner joins and Compare swaps; MASTER and hidden-mute records exist (events 18, 19) |
| C7 file | Add header fields `ringBytes`, `firstFrame` (f64), and a `compressed` flag (clear when `CompressionStream` is missing: the payload is stored raw); limits: 64 MiB, per-record, name caps, footer INDEX validated against the body: already in §5.7 |
| C8 CPU fields | As S7: shell writes the four fields and `loadPermille`; f64 counters (my one deviation) |
| C9 work totals | Met by my five f64 totals |
| C10 loudness per bus | Met with a tighter item (issue 3): **16 B** per metered bus (bus u16, a u16 holding the new-block count in bits 0-5 and the flags paused, reset, lost, gated, tp-gate-active in bits 6-10, firstSeq u32, truePeak f32, gatedQuanta u32). Worst case 17,824 B of 20,480, spare 2,656 B (≥ 1 KB) |
| C11 loudness config | Master implicit; slots metered plus `tpGateDbfs`; sent asap when `meter` or the target changes; pause, resume and reset are main-only. Met by `LOUD_CONFIG` (own record, not folded into BUS_CONFIG) |
| C12 duck gains | **Take theirs:** only buses that are targets of a rule, `{ u16 slot, u16 pad, f32 gain }`, count ≤ 32 (≤ 256 B worst, typically 8-16 B). Mine sent all 32 (128 B every block); with the ring holding raw STATUS the typical case matters more than the worst |
| C13 header, ladder, ABI | Add `loudShed` u16, `busRecordsEarly` u16, `sidechainLate` u16, `clockSteps` u16 in the 12 reserved bytes (244-255), leaving a u32; `liveRefused` is main-kept and `loudnessLost` main-derived. ABI 4.0, hash and vectors at the head of M5-0 (Wa1) |
| C14 lane ramp | As S1; fields match (slot, lane, start or asap, frames with 0 = step, f32 target). The record keeps my `mask` for the snapshot low-pass and my `shape` word (linear only in M5). Wa1 |
| C15 presence | Met (one bit per trigger slot, level not event, in the replay); stamped as above |
| C16 BUS_CONFIG as a difference | **Take it.** I kept the full tree; a filter-frequency drag would resend up to 5 KB per pointer move. Add opcode **`BUS_SLOT` (0x1C)**: one slot's parent and effect list (the BUS_CONFIG item layout) with a frame field honoured at quantum granularity for structural use; direct edits go asap and the core glides the parameter 20 ms. Add the **convolver run-out** as a core task. **Bit-identity:** see issue 5 |
| C17 sidechain rules and validation | As §2 point 6. Wire is met (24 B items); the parse and editor model gain the cycle check |
| C18 settings | Met (§2.1): `meter`, `loudnessTargets`, `loudnessResetOnPlay`, `mode` required, new rules default to `level` (Dk1) |
| C19 mix operations | Met (§6.2, `MixOp`, `opClass`). The class names map: their "direct, glided" is my "smoothed" (and now covers filter and send parameters, not only the compressor); their "structural" is my "dip". A preview applies live with no undo entry and the commit is one undo step (§6.1); Compare ops carry origin "compare" and no undo, no save; `apply` never clears runtime state |
| C20 SDK hook | **Name:** `editor.project.changed()` already exists (`sdk/project.ts:42-43,67-68`), so `onSectionChanged(key, listener)`. **Timing:** I fired it from `saved`, after the file write; C20 wants it synchronous in the turn of the edit. **Change:** the shell fires it from `Session.edit` right after `history.push` and from `step` (undo and redo, where `stepped` is already synchronous, `projectSection.ts:139-146`), only when the draft has no problems, so typing a value in Project Settings is heard at once, not after the write. A failed write leaves the live sound and an unsaved draft with the error shown. Previews bypass the hook (issue 4) |
| C21 slot table | Met; add `Audio.debug().mix.slots` (`name`, `slot`, `state`) to my §1.3 (I had counts only) |
| C22 `Bus.loudness` | Met, with the lower-bound field, `elapsed` excluding shed and gap time, and one **correction to my text**: I wrote that a mute taints "every metered bus under any muted bus". C22 is right: a mute of X taints X, its **ancestors** and master (X's signal feeds them), a solo taints every meter |
| C23 capability flags and debug | Add `mixCaps.cpuReason`, and the debug fields: recorder (state, owners, bytes, segments, evicted, truncated), CPU (window, clock step, `clockSteps`, refit residual), slot table, `busRecordsEarly`, `sidechainLate`, `liveRefused`, the ladder's loudness step. Dbg1 |
| C24 `Audio.capture` | Met; I choose: **a start from Held begins a new take and appends with a gap record**; `save()` writes from the latest take's start keyframe (or the ring's tail if truncated), so older takes stay in the ring for the panel but not in the file; a second `start()` while recording joins and writes a marker; rotation of 16 as §2 |
| C25 tests | Met by §10 except two rows to add: **loudness integrity** (a 3 s main stall loses nothing, 4 s sets `incomplete`, an EPOCH keeps integrated) and **the fader gate as an e2e spec** from `event.timeStamp` to the first changed core sample. Ld8, E3 |
| C26 Worker protocol and models | Take their shape: open → summary, warnings, audio section, overview; `seek(t)` → snapshot; `range(t0, t1, columns)` → transferred typed arrays; **live segments appended every second**. I had a separate main-thread `LiveSource` over the ring; theirs gives one decoder for live and file and keeps decode off the UI thread. Rc5 gains `range`, new task Rc6 (append), Pf7 shrinks |

## 5. What I got wrong in round 1 (found while reading)

- §4.2: retiring `BUS_MIX` is fine only if an asap lane ramp is bit-identical to today's `Ramp::next` (issue 5).
- §5.7: delta figures as saved sizes (point 5 above).
- §6.6: the taint direction (C22).
- §6.4: the hook fires at the wrong moment (C20).
- §6.5: the dip stamps both ramps; I keep that (issue 2), but my sequence also needs G's composition rule.
- §5.5: one shared decoder is better than my open-time recomputation for truncated files (C4).
- ADR 0147's status is **Proposed** (its header, line 3), not Accepted. CLAUDE.md forbids rewriting *accepted* records; an amendment section appended to 0147 is allowed, and Dc4 and Dc5 say so instead of "a new record".

## 6. Issues

**Blocking**

1. **`BUS_MIX` bit-identity against my retirement** (`architecture.md:436`, C16; my §4.2). The brief and the record require unstamped work to stay bit-identical; C16 assumes "an asap BUS_MIX and MASTER with lanes R-U at identity render exactly today's samples". I retired `BUS_MIX` and said bus goldens are re-recorded; a re-recorded `bus-gains`, `bus-mute`, `snapshot` is not a proof of identity (spike S4 measured `Ramp::next`'s drift of 1.1e-5 against an exact ramp). **Resolution I will take:** asap `BUS_RAMP` on a lone lane uses `Ramp::next`'s arithmetic and identity lanes are skipped, so the existing bus goldens keep their digests with a harness that sends `BUS_RAMP` where it sent `BUS_MIX`; only **stamped** cases are new goldens. The architect confirms the arithmetic rule and the skip in §4.5. Both documents: G1's acceptance and §10's golden row change from "re-recorded" to "digests unchanged".
2. **The dip's F0 race** (`architecture.md:211-214`). The sequence stamps the structural record at F0 + 960 where F0 is "the asap frame estimate", but starts the gate ramp *asap* (at arrival). If the batch arrives later than the estimate (S4: arrival jitter up to 3 quanta, `postMessage` unmeasured), the ramp ends later than F0 + 960 and the config applies at a gate above 0: the click the dip exists to prevent. **Fix:** stamp **both ramps and the config in one batch from one F0 = now + lookahead**, as my §6.5 does (`lookahead.ts:27-31`: 33 ms at 60 fps, 67 ms at 30). A structural edit is not latency-critical, and a late batch then counts `lateCommands` honestly instead of corrupting the dip.

**Major**

3. **STATUS growth makes the ring shorter than §4.2 says.** `architecture.md:355` budgets +0.4-0.7 MB per minute from M5's STATUS additions. My round-1 layout adds 80 B of header plus 180 B of `loudBuses` plus 128 B of `busDuck` to every 16 ms block: about 1.6 MB per minute raw, so 16 MB at 64 voices holds about 4.8 minutes, not 7. With C12's targets-only duck section and the 16 B loudness item (§4 above) it is about 0.7 MB per minute. The numbers in §4.2 and §6 are met only after my change; the worst-case STATUS becomes 17,824 B.
4. **Preview ops cannot go through the hook** (`architecture.md:185-188`, C20). The sequence routes a drag's preview through `H->>X`. The hook is a section change: it fires when a draft enters the undo history; a preview has no draft and no undo entry. Previews call `mixer.apply` directly from the Mixer model (plugin-internal), the commit goes through the hook. C20's "the audio plugin flushes a mini-batch for preview ops" is then the plugin's own call (`backend.flushNow`), not the hook's.
5. **Sends are taken before the gain stage** (`bus.rs:540` against the gain at `:548-562`). Lane G (mute, monitor mute and solo, the dip) therefore does not silence a bus's send to the shared convolver. Consequences: monitor solo is unfaithful (a muted bus still rings the reverb), the dip lets a send step through while the chain resets, and today's muted-bus-with-send leaks the same way. **Needed:** the core scales the send by lane G. This is a **deliberate change** to today's output for a muted bus that has a send, so it is the one named exception to bit-identity (new golden, not a digest match). New task Rv1.
6. **Contract S4's convolver run-out is real core work** (`architecture.md:223`, C16): today the convolver runs only while a send exists (`bus.rs` `has_reverb`, S4 "What today's code does"), so removing the last send cuts the tail. A run-out until the input has been silent for the IR length plus `IDLE_MARGIN_QUANTA`, then a reset, is a task I had not priced (Rv1, 4 days with its tests).
7. **`BUS_SLOT` (C16) changes my wire task and the live-apply path.** A per-slot record with a frame and the glide rules is new surface in Wa1, B2, B4 and Ma1; direct parameter edits stop resending the tree.
8. **The record's tp-gate and the target check** (`architecture.md:396`): the target check is suspended while any monitor control is active, which extends record change 11 (MASTER not 1 or muted). I agree it is right (a soloed reading must not pass or fail a target) and `Bus.loudness.target.state` becomes `suspended` for it; it is a behaviour the record did not state.

**Minor**

9. The architecture calls the hook `editor.project.changed` in its diagram (`architecture.md:42`) and §4.7 step 1; use `onSectionChanged`.
10. `architecture.md:178` (memory table) takes the mixer baseline as 318,306 B; the tree's `myco_audio.wasm` is 319,799 B (312.3 KiB in the build log), so the projected size is ≈ 347-351 KB decimal against the 327,680 B gate. Still a recorded tripwire move.
11. §3.1's tap is in `CoreLink.handleMessage` (`core/context.ts:239-247`), not in the `coreBackend` STATUS callback; I name that in Rc2's files and add `core/context.ts`.
12. C8 asks wrapping u32 counters; I keep f64 (see S7). Any wrap rule on main would be one more fake-clock test.
13. §4.2 sizes the ring by `deviceMemory`, which browsers cap at 8 and clamp to powers of two; the formula `8 MB x GB` is fine, the test must not assume other values.
14. The web has no rotation (downloads cannot be deleted); `architecture.md:534` should say the web trigger stops at 16 with a message.
15. §4.7 step 5's `liveRefused` counter must be readable by scripts or only by the debug panel; I make it debug-only.

## 7. Agreements

I agree with, and design to: keyframes keyed on STATUS frames with the index at 4,096 entries; the 20 KB STATUS with 8 buffers (+32 KB); the shell's `loadPermille` ring and the coarse-clock table (1 ms, 2 ms with a 1 s window, hidden above); the NNLS refit staying on main and never feeding the cap; the take cursor advancing only inside `myco_audio_status_take`; reseeding feeds at an EPOCH while keeping histograms; presence in the core in M5-0 and level mode in M5c; the min combine and the trigger-first order with Kahn and the defence in depth (`sidechainLate`); the dip reset happening at gain 0 so effects need no stable slots (a good simplification of my slot table: only buses are stable); the convolver run-out; the ladder step skipped for master-only and given back last; rotation; 64 MiB; the platform matrix; the health thresholds; the observation that the record's capture numbers predate change 2 (their §13 item 2) and that `loadPermille`'s figure and `Date.now`'s coarse clock are separate things.

On their §13: item 1 (the sort fixes nothing in M5-0) I raised independently; item 4 (any cycle) and item 5 (apply at next Play) I take with the refinements above; item 3 (nine buses, 0.10 ms) I take into S12.

## 8. Rows and days these requirements add to my task table

Estimates for the coordinator; round 2B re-sums by script.

| Row | Change | Days |
|---|---|---|
| Wa1 | `BUS_SLOT`, header repack (`loudShed`, `busRecordsEarly`, `sidechainLate`, `clockSteps`, `loadPermille` filled), the 16 B loudness item, targets-only duck section | +1 |
| B2 | the per-slot record at quantum granularity, tombstone as a silent root | +1 |
| **Rv1 (new)** | send scaled by lane G, the convolver run-out and reset, goldens with the named exception | +4 |
| B4 | glide filter frequency and Q and the send level, not only the compressor | +0.5 |
| **Mx3 (new)** | gate-lane composer on main: authored, script, monitor, dip windows | +2 |
| Rc1b (new) | keyframe and name codecs: lane targets, loudness readings, events state, 24 B rows | +1.5 |
| Rc4 | rotation through `Storage.list` and `delete`, take semantics on Held | +0.5 |
| **Rc6 (new)** | Worker live append and `range` | +2 |
| Pf7 | live follow now through the Worker | -1 |
| Sa1 | the Kahn cycle check, 8 level rules | +0.5 |
| **Ld8 (new)** | loudness integrity tests (stall 3 s and 4 s, EPOCH, seq restart) | +1.5 |
| Ld4 | lower-bound field, `elapsed` rules, taint direction | +0.5 |
| Dbg1 | recorder, CPU and slot-table debug fields, `cpuReason` | +0.5 |
| **Ma3 (new)** | deferred live adds with retry on recycle | +1.5 |
| Hk1 | fire from `edit` and `step`, validity check, the 0147 amendment appended to a Proposed record | +0.5 |
| **Total** | | **+16** |

New totals if all are taken: **300 days of tasks (60.0 person-weeks), 60 days of reserve, 360 days (72.0 person-weeks)**; the milestone split moves M5-0 to 57 days, M5a to 98, M5b to 45.5 and M5c to 74.5, M5d unchanged. The reserve's RS5 (click-test surprises) shrinks by the 4 days Rv1 now prices; the rest of the reserve is unchanged.

## 9. What I need from the architect before round 2B

1. Confirm six lanes with main-owned G composition, and the asap arithmetic parity in issue 1.
2. Rule on issue 2 (one stamped F0 for the whole dip) and on the send scaling of issue 5.
3. Accept f64 counters, or state the wrap rule.
4. Confirm `BUS_SLOT`'s shape (one slot, the BUS_CONFIG item layout, a frame) and that `BUS_CONFIG` stays as the full-tree record for replay.
5. State the structural-sequence overlap rule (one in flight, same-frame coalescing) in §4.7.
