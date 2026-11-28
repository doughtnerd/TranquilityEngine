# 0460. One classifier names what an animation clip reference is

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0371, 0372, 0459

## Context

A clip reference can name an authored clip (`*.anim.json`), a timeline (`*.timeline.json`), a compiled clip
(`*.anim.bin`) or a model's clip (`model.glb#Anim/Run`). Ten places worked out which by testing suffixes themselves:

- the runtime timeline loader (`runtime/features/timeline.ts` `loadClip` and `sourceOf`), which matched case-sensitively;
- the timeline editor (`assetDropKind`, `TimelineWindow` `lengthOf`, `timelineSession`, `isTimelineRef`);
- the scene clip drop and previews (`isClipAsset`, `clipTiming`, `prepareClip`);
- the Animation window (clip picker, session document).

The editor lowercased first and the runtime didn't. So `clips/Walk.Anim.JSON` dropped on a timeline was accepted as a
subclip, but the runtime didn't recognise the suffix: the clip never played. Had the first check passed, `sourceOf` would
have parsed it as a timeline.

## Decision

We will classify clip references in one function, next to `isClipSource` and `modelClipOf`, in
`src/engine/animation/compile/keys.ts`:

```ts
clipRefKind(ref): "source" | "timeline" | "compiled" | "model" | null
```

- It ignores letter case, and it reads the reference through `normalizeAssetPath` (ADR 0459).
- A model sub-asset (`#Anim/<name>`) is checked first.
- `isClipSource` is now `kind === "source" || kind === "model"`.
- All ten places call `clipRefKind`. None of them tests suffixes itself any more.

## Alternatives considered

- **Lowercase in the runtime only.** That fixes this bug but leaves ten copies to drift again.

## Consequences

**Positive**
- The editor and the runtime agree on what a clip reference is, in any letter case. Fixed: a timeline that nests
  `asset:tl/Glow.Anim.JSON` now plays it (`timeline.node.test.ts`, through `TimelineDirector`).

**Negative / costs**
- Behaviour change: the runtime treats `*.ANIM.JSON` / `*.Timeline.Json` as clips and timelines. Before, it tried to
  load them as compiled files and warned.

## Deprecates

The suffix tests in the files listed under Context.

## As built

- `clipRefKind` in `keys.ts`, with a unit test in `keys.test.ts` and a runtime test in
  `runtime/features/timeline.node.test.ts`.
