**Verdict: approve with changes.** Top 3 concerns: (1) the record sells "sample-exact" but its priming lead is an estimate (native decode x 1.5-3), never measured on the phone it must work on; (2) the 7.5-week editor is the least certain line in the estimate and serves an authoring model that nobody on the project has used yet; (3) in-voice ramps and the music ring pool are prerequisites the record could defer by designing around them.

Read: BRIEF, the record (fully), goal.md, spikes/audio-music/README.md, and code at the cited lines. Nothing was run. All prices below are mine, in the record's own units (feature weeks, multiplied by its 1.55-1.85 factor), and are as soft as the record's.

## Issues

1. **major. Priming lead is unmeasured where it matters.** §2 plans starts at max(horizon, 1.25 x prime time), about 100 ms. The prime time of 20-60 ms is "native measured, wasm 1.5-3x estimated" (README, "Answers"). The README itself assumes the phone is about 8x slower. At 8x, priming takes 160-480 ms. Quantised changes then land a bar late, not "within one beat" (§3), because one beat at 120 BPM is 500 ms and at 180 BPM is 333 ms. Change: state the claim per preset, and make the first M4 task a phone measurement of prime time.
2. **major. In-voice ramps are justified by a rate the design does not have.** The 538 us split (`voices.rs:310`) is a p50 for splitting *every* quantum. §4 admits the cost only matters "with a few fades per second". Music transitions happen well under once per second. Change: price the ramps as an optional 0157 hardening, not an M4 dependency, or show a music scene that actually splits often.
3. **minor. `playlist` duplicates M2.** `sequence` and `random` with `avoidRepeat` already exist (`eventFormat.ts:129,139`, `eventRuntime.ts:1150-1173`). Segment children and "step at exit cues" is a change of the *step trigger*, not a new node. Change: justify the new node by what `sequence`/`random` cannot express, or drop it.

## The cheapest credible M4

The cheapest credible design is what Unreal ships, and what the owner named as a reference: a quantised clock (Quartz), not an authoring hierarchy. Build a **grid layer on top of M2's containers and the existing `at`**, with no new music nodes.

- A `tempo` map on a clip or event (the same marker format as §1).
- `handle.nextGrid('beat' | 'bar' | n)` returning a heard time. It feeds `Audio.playOneShot(clip, { at })` (`Audio.ts:33`), which is already stamped and sample-exact for decoded clips.
- Public `Audio.horizon` and `Audio.timeAt`.
- Beat and bar callbacks from the same main-side clock (design A, as in the record: it is measured and cheap).
- Stems as M2 `layer` plus parameter automation, as sound-lab's `music-intensity` already does.
- M2's `switch` gains a `quantize` option beside `onChange: keep | restart | crossfade` (`eventFormat.ts:158`). Transitions and stingers become script calls to `nextGrid`.

| Price (feature weeks) | Weeks |
|---|---|
| Tempo-map format, grid maths | 1.7 |
| Beat clock and API (polling plus one callback, no component messages) | 1.2 |
| Public horizon and timeAt, `quantize` on switch | 1.1 |
| Slip counter | 0.3 |
| Numeric tempo-map inspector, samples | 2.2 |
| **Total** | **6.5** |

6.5 x 1.55-1.85 is **about 10-12 person-weeks**, roughly a quarter to a third of the record's 38-46.

**What it loses:** the transition matrix, cues and exit cues, regions, bridges, the segment view, and authored playlists. It loses owner scope items 2, 3 and 6 as *authored* features: they become script recipes. Composers have nothing to edit but numbers. That is why it is the floor, not my recommendation.

**A middle cut that keeps all seven owner scope items** (every item stays authored and runs in the record's runtime):

| Cut | Saves (features) | Cost of the cut |
|---|---|---|
| In-voice ramps (issue 2): one stamped STOP per transition | 1.5 | each transition splits one quantum (+0.54 ms once); tail risk on the lab VM is unmeasured |
| Segment view: waveform strip, grid, numeric cue and region fields, no dragging, no lane editing | 1.5 | composers type positions; drag is a later increment |
| Audition: play-from-cue only | 0.5 | no per-transition preview |
| Fallback: music plays but quantisation is "not supported", with one warning | 0.7 | goal says best effort, so this is within it |
| Rhythm mode: keep public `timeAt` and the stamped-only rule; drop the `latencyHint` switch, calibration API and sample scene | 1.2 | rhythm games build their own calibration; this mode is the least-tested claim (README "Still unverified") |
| Playlist node: use `sequence`/`random` with an exit-cue step (issue 3) | 0.5 | no per-item loop counts, so these go into regions |
| Import hints (acid, cue, smpl) | 0.5 | composers enter BPM by hand |
| **Total** | **6.4** | |

I make this 24.5 - 6.4 = 18.1 feature weeks, x 1.55-1.85 = **about 28-33 person-weeks**, saving 10-13. This is the one I would back.

Two cuts I would *not* make, and why:
- **One tempo per segment.** The map is nanoseconds at runtime (S4). The saving is perhaps 1-1.5 weeks of UI and validation, and it removes the one place the record beats Wwise. Not worth it.
- **Rewrite on Babylon/Web Audio scheduling.** It would discard the accepted core (0157), and `at` on Babylon only covers decoded clips (`babylonBackend.ts:85-91`). It buys nothing.

**Decoding instead of streaming** works only for short material. A decoded stem is 11 MiB per minute (33 MiB per 3 min, README). Four stems of 45 s fit low's 64 MB, but eight stems of 3 min need 270 MiB, more than high's 256 MB. So drop streaming only if the owner accepts short adaptive loops, which makes it a content rule, not an engineering cut. It saves the prime protocol and ring pool (about 2.5 weeks, 4-5 with the multiplier) and removes issue 1 entirely.

## When this record is wrong

The record is the wrong design if **any** of these turns out true. Each names the evidence that would show it.

1. **Real music is short.** If the samples and the first composers' stems are 6 or fewer stems of 60 s or less, the streams machinery (prime, pool, slip counter, encoded-copy memory) is solving a problem the content does not have. Evidence: the lengths of the actual assets, and a decode-everything run on low.
2. **The phone is slow.** If wasm priming on the low preset exceeds about 150 ms, the record's central promise (exact starts within a beat) fails there. Evidence: the owner's phone run (README, "Still unverified").
3. **The beat clock is not within 1-2 frames on real hardware.** The 0.04 ms figures are against a fake sink and the engine's own reference. If `outputLatency` jitter on a real device exceeds a frame, §5's design A buys nothing over polling `Audio.time`. Evidence: the loopback measurement that the rhythm spike lists.
4. **Nobody authors tempo changes.** If composers deliver DAW stems at one BPM, the tempo map is dead weight in format, editor and tests. "Both, as one model" is the owner's choice, not usage evidence. Evidence: a composer's real project.
5. **Composers want the timeline, not the matrix.** If the real users want FMOD-style arrangement (the deferred item), M4 builds a rules table and segment view for a model they do not pick, and the deferred timeline then becomes the real M5. Evidence: the first two authoring sessions.
6. **The budget premise breaks.** The record's allowance assumes high is already near 1.3 ms. The README admits high is over 1.3 ms p99.9 on the lab VM. If the owner's lab-VM run shows a *split-free* high already over, "own budget" is not a cheap addition but a tradeoff that takes voices from elsewhere, and music in the voice cap (owner decision 2) is mandatory, not recommended.
7. **The estimate is wrong.** The x1.67 multiplier comes from one milestone (M3). The 7.5-week editor is the largest feature, and canvas views with zoom, drag and a transport that previews through the real backend usually overrun. If the segment view alone costs more than about 10 weeks, the total passes 50 and the middle cut above becomes the plan.
8. **Streamed stems are not the common shape.** If most games use one stereo music track with a stinger or two, 40 of the 46 weeks serve a minority, and the grid layer above is the right M4.

## Cheaper alternatives

See "The cheapest credible M4": the grid layer (10-12 weeks), and the middle cut (28-33 weeks) that keeps all seven owner scope items.

## Questions for the author

1. What is the prime time on the phone, in wasm, and what lead does the record promise there?
2. Which music scene in the spike splits quanta more than once per second? If none, why are in-voice ramps in M4?
3. What can `playlist` express that `sequence` plus an exit-cue step cannot?
4. Which segment-view features are drag-only, and what would a numeric-first editor lose that composers need?
5. Is there any non-owner composer or tester for the segment view before M4d?
