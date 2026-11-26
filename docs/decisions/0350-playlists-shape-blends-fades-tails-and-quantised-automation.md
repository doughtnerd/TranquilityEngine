# 0350. Playlists shape their blends, fades and tails, and quantise automation to the beat

- **Status:** Accepted, amended by [0353](0353-quantise-reaches-pitch-pan-filters-and-entry-voice-curves.md) (quantise on pitch, pan, filters and entry voice curves)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0343 and 0346)
- **Related:** 0158, 0166, 0167, 0342, 0343, 0346, 0349

## Context

When the audio events and music events migrated to playlists (0343; decision log D32), five behaviours were lost because
the playlist format couldn't say them, and the Sound Lab samples were left with approximations:

1. **Blend overlaps.** An old blend child was full across a `range` and faded over a width either side (equal power),
   so neighbours could overlap. A playlist Blend entry is a point `x`; 1D weights crossfade across the whole gap between
   neighbouring points (layer: ramp in from the previous one and never end). The engine blend lost its overlaps.
2. **Music tails.** A segment region's `tailBeats` rang the audio past a loop's end over the next pass, and audio after
   a segment's exit cue rang under the next segment (Wwise's post-exit). A playlist sequence splices at a wrap and a
   Switch cuts or crossfades the old entry at the hand-over.
3. **Transition fade shapes.** Old transitions had linear, S-curve or equal-power fades; every playlist crossfade is
   equal power.
4. **Bridge fades.** An old bridge (Wwise's transition segment) had its own fade in and out; a playlist transition uses
   the rule's crossfade.
5. **Beat-quantised automation.** An old stem's automation could move only on the next beat or bar (a stamped 20 ms
   ramp); playlist automation follows its parameter continuously. Rhythm games need a change to land on the beat.

The owner asked for all five, everywhere they would be expected, following Wwise and FMOD (2026-11-22, with three
design steers recorded in the build's decision log): blend regions on 1D entries like FMOD instruments and Wwise
blend-track ranges; a weight curve for 2D entries (Unity's 2D blend trees have no regions); one shape set for every
crossfade; tails from the Exit markers samples and sequences already have, not a separate length.

The audio core runs four fade laws (`linear`, `sCurve`, `equalPowerIn`, `equalPowerOut`) and stamps fades and gain ramps
at a sample; it isn't changed here.

## Decision

We will add the following to the playlist format (`src/engine/audio/playlist/types.ts`), each optional and absent by
default, so an old file parses to what it meant; the lenient parse fills nothing new, rejects bad values with one problem
line, and the writer leaves defaults out.

**One fade-shape set** (`FadeShape`, `fadeShapes.ts` the one shape function): `linear`, `equalPower` (sin in, cos out:
constant power), `sCurve`, `invSCurve`, `log1`/`log2`/`log3` (1 − (1 − u)^p, p = 1.41, 2, 3: most of the change early)
and `exp1`/`exp2`/`exp3` (u^p: most of it late): Wwise's set without its duplicate sine. A fade in's level is the shape's
value at phase u; a fade out's is 1 − value (cos for `equalPower`). At runtime `linear`, `sCurve` and `equalPower` are
one stamped fade on the core's law; every other shape is twelve stamped linear fades on the shape's knots (each takes
over from where the last one is, the core's class G rule), exact at the knots, the middle among them. Every unset shape
is `equalPower`, today's crossfade. A `TimeLength` is `{ ms } | { beats }` and a `Fade` is `{ length, shape }`.

**1. Blend regions (1D) and weight curves.**
- `EntryUse.region?: { start, end, fadeIn, fadeOut, shapeIn?, shapeOut? }` in the axis's units: the entry's weight is 0
  outside `[start, end]`, ramps up over `fadeIn` from `start` and down over `fadeOut` to `end`, 1 between. Shapes
  default to the blend's `curve` (`linear` → linear, `equalPower` → equalPower). `x` stays the entry's anchor and the
  shorthand.
- An entry without a region keeps ADR 0343's weights exactly ("derived" regions: crossfade from the previous point to
  its own and out to the next, √ for equal power; layer from the previous point, never ending). Explicit regions win;
  `crossfade`/`layer` and equal power change only how unset regions are derived. In layer mode a layer can now end.
- `EntryUse.weightCurve?: Curve` (0346's curve): the entry's raw weight (0..1: in 2D the barycentric or edge weight, in
  1D after its region) in, its gain out. Absent: today's (the weight, √ under equal power). In 2D under `equalPower`,
  when any entry has a curve, the shaped weights are normalised to constant power (a no-op without curves, since
  Σ(√w)² = 1); otherwise shaped values stand as they are (a curve that stays 0 until 0.4 narrows the overlap and leaves
  a gap, as asked). 2D blends get no regions (an entry's reach comes from where its point sits).
- `blendWeights.ts` stays the one weight model (`blendWeights1D(…, regions, weightCurves)`, `blendWeights2D(…,
  weightCurves)`); the runtime and the Studio both read it.

**2. Tails (post-exit) and pre-entry,** from Exit markers, as Wwise's exit cue:
- A section's **Exit marker** (a sequence `exit` marker, or a sample's Exit marker, 0342) is its musical exit; the audio
  after it is its tail. When a Switch change **cuts** at that Exit point (`when: "exit"`, or a beat or bar that lands
  on it), the old entry *rings out*: its loops are let go by their exit settings and its voices play on to their
  natural end (the trim end; a sequence plays its playhead on with every loop inactive, and at its end lets clips that
  run past it play to their own end) under the next section. A crossfade still fades it (`length`, `shapeOut`), as
  Wwise applies a set fade-out to the post-exit. `ChangeHow.tail?: boolean` (absent: true; the owner's "default on") —
  `false` cuts as before. No Exit marker: no tail, today's behaviour. A cut that isn't at the Exit point cuts.
- **Loops and Exit markers in one sample:** release (and ring-out) sends the voice's key-off, so a held loop exits by its
  exit setting into the audio after it ("Tail" on the Samples screen, from the last loop to the trim end), while the
  music's exit is the Exit marker. An always-active sample loop can't be let go (only a stop ends it), so ring-out
  still cuts that voice.
- **Loop tails:** `SequenceLoop.tail?: boolean` (absent: false, so old sequences still splice): at each wrap the audio
  from the loop's end to the first `exit` marker after it rings on over the next pass (a voice whose piece runs past
  the loop's end plays on; else a tail voice plays the audio after it; a playlist clip keeps playing), ending with a
  5 ms fade. No Exit marker after the loop: no tail (linted).
- **Pre-entry:** `SequenceMarker.type` gains `entry`. A sequence entering by a Switch change at a boundary starts its
  first `entry` marker's time early, so the marker lands on the boundary (its timer is scheduled that much earlier);
  the old entry still leaves at the boundary. Played on its own, a sequence starts at 0. (Samples get no Entry marker
  type here: the sample format is 0342's.)

**3. Transition fade shapes:** `ChangeHow.shapeOut?`, `shapeIn?` (Switch `onChange` and rules) shape the outgoing and
incoming fades over `length`. The same set shapes `QueueSettings.continuous.shape?` (a negative gap's overlap),
`SequenceLoop.exitShape?` (a `crossfade` exit, both sides) and region fades. Sample loops' seam and exit crossfades are
the core's (equal power) and stay so: the core isn't changed.

**4. Bridge fades:** `ChangeHow.transitionIn?`, `transitionOut?: Fade`: the transition playlist fades in at the
boundary and out at its Exit marker by its own fades; absent, by the rule's `length` and shapes (as the old runtime
read an absent bridge fade). The sections still fade by the rule.

**5. Beat-quantised automation:** `Automation.quantize?: "beat" | "bar" | { beats: n }` (1..64, counted from the bar,
the musical grid's `every n beats`) on a parameter-keyed lane. A quantised lane isn't a core binding (the core follows
its parameter continuously; this amends 0346's "automation keyed on a parameter is evaluated in the core" for these
lanes). Its level is the voice's own stamped gain ramp (`AudioVoice.paramsShaped({ gain, at })`, the stem level the old
music runtime used, which multiplies the voice's volume, so other gains and bindings are untouched): on a parameter
change the lane asks the instance's musical clock for the next boundary (`MusicalSource.nextGrid`, the same clock Switch
`when: beat|bar` and the beat callbacks use) and, a quarter second (the runtime's lookahead) before it, reads the
parameter and stamps a 20 ms ramp starting exactly at that sample on every voice under the lane; voices that start
later begin at the lane's level. The last change before the stamp wins; a later one moves at the next boundary. No
tempo: it moves at once (one warning; linted). Gain-like targets only (`volume`, `enabled`, a gain effect's `gain`);
others follow their parameter (warned, linted). Per lane rather than per parameter: a rhythm designer quantises the drum
stem's volume to the beat and leaves a filter sweep continuous on the same parameter. Entry voice curves don't take
`quantize`.

**A fix found on the way:** a cut timed to a beat, bar or exit stopped the old entry when its timer ran (a lookahead
early); it is now a stamped 5 ms fade at the boundary.

**Migration** (`migrate/audioEvent1.ts`) maps what it noted as lost: blend children → regions `{ start: lo − fade, end:
hi + fade, fadeIn: fade, fadeOut: fade }` with `curve: "equalPower"` (the old weights exactly, overlaps included);
`tailBeats` → the loop's `tail` (exact when an Exit marker sits `tailBeats` after the loop's end, as in music-loop;
another marker rings that far, noted; none: one is added at the tail's end, noted); transition fade curves → `shapeOut`/
`shapeIn`; a bridge's own fades → `transitionIn`/`transitionOut`; a stem's quantised volume → `quantize`. Still not kept
(noted): fade offsets, different fade-out and fade-in lengths, quantised low-pass, quantise on entry voice curves.

**Studio** (Playlists screen, 0349 kit, theme tokens): a fade-shape picker with a glyph of the curve; Switch rows gain
fade-out/in shapes, "Let the tail ring" and a transition's bridge fades; a continuous Queue's overlap shape; the 1D lane
draws regions as trapezoids with four draggable, keyboard-nudged handles (each drag one undo step; "Reset to automatic"
clears); a weight-curve preset menu (the shapes, narrow overlaps) beside "Edit curve…" in the shared curve editor (kind
`parameter` over the raw weight; no new curve input kind is needed) and Reset; the 2D plane tints each entry's shaped
influence; sequence loops gain "Ring the tail" and the exit shape; automation lanes keyed on a parameter gain a quantize
menu; marker type `Entry`; the timeline shades the post-exit tail (after the last Exit marker) and loop tails. Lints:
`quantizeIgnored`, `quantizeNoTempo`, `regionIgnored` (a region in 2D), `tailWithoutExit`.

No public `myco` API changes.

## Alternatives considered

- **A tail length on sequences and clips** (seconds or beats, the old `tailBeats`) — the first design; the owner chose
  Wwise's model, where the Exit marker samples and sequences already carry says where the music ends and what rings.
- **Per-neighbour crossfade widths (one band between two points)** — simpler to draw, but can't say a plateau, a gap or
  a layer that ends, and maps the old overlapping fades only approximately; FMOD and Wwise both give each instrument
  its own region.
- **Regions in 2D** — a region narrower than its neighbours leaves holes, and Unity's 2D blend trees have none; a weight
  curve shapes reach without holes in triangles.
- **New core fade laws for log/exp** — exact per sample, but a core and wire change this work can't make; stamped linear
  pieces on the shape's knots are within a chord of the curve and need nothing new.
- **Quantise per parameter (in its definition)** — every curve on it would wait; a designer wants it per lane.
- **Quantise by a shadow parameter slot set at the boundary** — the slot write is unstamped (frame-accurate), not
  sample-accurate.

## Consequences

**Positive**
- The Sound Lab's engine blend, music-loop's tail, music-world's linear and S-curve transitions and its riser's cut-in,
  and the intensity stems' beat steps play as they did before 0343; the migration writes them.
- One shape set and one weight model across crossfades, transitions, bridges, regions, loops and queues.
- Rhythm games can move stems on the beat, sample-exactly, from the same musical clock as Switch timing.

**Negative / costs**
- `ChangeHow.tail` defaults to true (the owner's choice): a cut at an Exit marker in an existing playlist now lets the
  audio after the marker ring. A cut not at the Exit point, and any crossfade, are unchanged.
- Non-core shapes cost twelve stamped fades per voice per fade.
- A quantised lane's level is the voice's stem gain ramp: one per voice, shared by its quantised lanes (their product).
- Pre-entry starts the incoming sequence early only when the boundary is far enough ahead to stamp it.

## Deprecates

Nothing.

## Open questions

- An Entry marker type on samples (pre-entry for sample sections) belongs with 0342's sample format.
- A sequence playing out in a continuous Queue (no Switch) doesn't ring its post-exit over the next entry yet.
- Separate fade-out and fade-in lengths and fade offsets on change rules (the old format had them).

## References

- Wwise: blend tracks and crossfade regions, music segment pre-entry/post-exit and exit cue, transition fade curves,
  transition segments; FMOD: instrument regions on parameter sheets, transition timelines with fade curves, quantisation.
- `src/engine/audio/playlist/{types,format,fadeShapes,blendWeights,lint}.ts`; `src/plugins/audio/runtime/playlists/
  {nodes,liveNode,sequence,levelAutomation,quantizedLanes}.ts`; `src/engine/audio/migrate/audioEvent1.ts`.
- Guides `docs/wiki/guide/playlists.md`, `docs/wiki/guide/interactive-music.md`; decision log D32, D33.
