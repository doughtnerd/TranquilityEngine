# 0451. One writer makes every raw clip, and one module samples keys

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0371's raw clip form and D46 "a timeline is a clip used as a timeline")
- **Related:** 0370, 0371, 0372

## Context

Two modules wrote `myco.anim@1` raw clips. `engine/animation/compile/rawClip.ts` (`compileRawClip`) wrote an
Animator's clips (the runtime's `clipSources.ts`, the editor's compile `jobs.ts`); the animation plugin's
`runtime/features/timeline/rawClip.ts` (`writeRawClip`) wrote timelines, `*.anim.json` sources played as timeline
subclips, image flipbooks (`subAssetClips.ts`) and a test's 2D bone clip. They had drifted:

- **Frame count:** the engine wrote `ceil(d·r) + 1` frames, the plugin `round(d·r) + 1`. A 1.01 s timeline at 30 Hz got
  31 frames whose last sample was at 1.0 s, so its last key was never sampled.
- **Key order:** the engine sorted each keyed track's keys (the format requires it); the plugin wrote them as given.
  Parsed files are already sorted (`tracks.ts`), so this bit only track lists built in code.
- **Smaller rules:** key starts clamped (engine) or only ends (plugin); an empty discrete asset dropped with a problem
  (engine) or written as `""` (plugin); empty strings `NONE` (engine) or a `""` string (plugin); the header's bone count
  only when bones are bound (engine) or whenever a skeleton was given (plugin); a colour track's empty alpha 1 (engine)
  or 0 (plugin); event thresholds and blend times clamped again by the plugin.

Key bracketing and lerp/nlerp/slerp were written five times: in both writers, in the clip import's loop pose-match
(`clipImportLogic.ts` `sample`), in the glTF channel resampler (`import/channels.ts` `evaluateSampler`, `slerp`), and
in `core/math.ts` (`Quaternion.nlerp`, `slerp`).

## Decision

We will have **one raw clip writer**, `compileRawClip(source, skeleton, name?, sampler?)` in
`engine/animation/compile/rawClip.ts`, and its rules are the contract. `writeRawClip` is deleted. To serve timelines it:

- takes a `RawClipSource` (`name`, `rate`, `duration`, `loop`, `tracks`, and optionally `additive`, `rotation`,
  `rootMotion`), which an `AnimSource`, a `Timeline` and a `FlipbookClip` all are;
- accepts a null skeleton (bone tracks dropped with a problem, as before);
- returns `subclips`: per subclip track (its index in the track table), each key's clip string id and reference in
  written (time) order, which a TimelineDirector binds (`timeline_bind`);
- treats a rate that isn't a positive number as 30 Hz and such a duration as 0 (the plugin writer's guard);
- sorts out-of-order key lists of the sampled kinds (bone channels, quat tracks) before sampling them, as well as the
  keyed kinds.

The timeline loader (`timeline.ts`) passes only a source's timing and tracks (an `*.anim.json`'s additive flag, bone
rotation mode and root motion are an Animator's), warns its own message for bone tracks and the writer's other problems.
The flipbook path calls `compileRawClip(clip, null)`. `importedClipSkeleton` accepts any `{ bones: { name, rest }[] }`.

We will have **one key sampler**, `engine/animation/compile/keySampling.ts`:

```ts
bracket(count, timeAt: (i) => number, t): { lo, hi, u }     // any ascending key store
bracketKeys(keys, t)                                       // [time, ...value] tuples
inTimeOrder(keys, timeOf)                                  // the list itself, or a stable sort of it
sampleVec(keys, t, out?, at?)                              // linear per component
sampleQuat(keys, t, "nlerp" | "slerp", out?, at?)          // core/math Quaternion, shorter arc, normalised
```

Before the first key it holds the first, after the last the last; between keys u runs 0 → 1; at a time several keys
share, the last of them is read. The writer, the loop pose-match and the glTF resampler use it; quaternion blending is
`core/math`'s `Quaternion.nlerp` / `slerp`, with no other copy.

**Value clamps** the plugin repeated (a notify threshold into 0..1, blend times ≥ 0, `end ≥ time`) are dropped: the
track parser (`tracks.ts`) already holds every `Track` to those ranges, and the engine writer never clamped them.

## Alternatives considered

- **Keep both writers and share only the sampling** — the frame and key rules would still drift; the bugs were in the
  writer, not in the sampling.
- **Make the plugin writer the contract** — it rounded the frame count down and left keys unsorted.
- **Keep the plugin's value clamps in the shared writer** — duplicate validation of what the parser guarantees; a
  track built in code that breaks them is a caller bug the writer shouldn't hide differently per kind.

## Consequences

**Positive**
- Timelines and flipbooks get the Animator path's frame rule, key order, empty-string and colour-alpha rules.
- One sampler to fix or tune; `core/math` owns quaternion blending.

**Negative / costs**
- Timeline problems other than bone tracks (an empty discrete asset) now warn where they were silently written.
- The core samples a raw clip at `x = clamp(t · rate, 0, frames − 1)` (`anim-sample` `frame_pos`), which assumes
  uniformly spaced frames; when `d·r` isn't whole the last frame sits at `d`, nearer than `1/r`, so between the last two
  frames the core blends as if it were a full frame away (at `t = d` it reads `frac(d·r)` of the way to the last
  sample). That is the core's, for Animator clips and now timelines alike, and is left open here.

## Deprecates

`src/plugins/animation/runtime/features/timeline/rawClip.ts` (`writeRawClip`, `RawClipSource`, its `RawClip`): removed;
its test became `timeline/writtenTimeline.node.test.ts`. The private `bracket`/`vec3At`/`quatAt` of the engine writer,
`sample` in `clipImportLogic.ts` and `slerp` in `import/channels.ts`: removed.

## Open questions

- Whether the core should place the last frame of a clip at its duration (see Negative); a format or core change.

## References

- `src/engine/animation/compile/rawClip.ts`, `src/engine/animation/compile/keySampling.ts`
- Tests: `compile/rawClip.test.ts`, `compile/keySampling.test.ts`, `runtime/features/timeline/writtenTimeline.node.test.ts`

## As built

- The two ADR 0451 fixes are proven in `writtenTimeline.node.test.ts` through the writer as `timeline.ts` calls it: a
  1.01 s, 30 Hz timeline has 32 frames with its last sample at the last key's value; out-of-order activation and
  subclip keys are written sorted, with `subclips` in the same order, and out-of-order quat keys sample correctly.
