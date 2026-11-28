# 0470. One curve cache for tween backends, and sequence bytes from encodeSequence

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0370, 0371, 0372, 0422, 0424

## Context

Loaded curve assets (a tween's `ease` when it eases through an engine curve) were cached in two places, differently:

- `AnimationWorldCore.acquireCurve`/`releaseCurve` (game tweens, T70): reference-counted by `JSON.stringify(curve)`,
  freed with the last reference, a failed load not remembered.
- `UIAnimator.ease` (UI animation, 0422 wave 4): a `Map` by `timingKey` that kept every handle, **including a failed
  load (0)**, for the animator's life. A curve refused once (a full curve table) eased linearly for good, and a curve no
  animation used any more stayed loaded until every document of the World went.

Both tween backends (`tween/standalone.ts`, the plugin's `core/tweenBackend.ts`) also kept the same three live-handle
sets with the same rule for what ended (tween `COMPLETED`/`KILLED`/`DESTROYED`; sequence `KILLED`/`DESTROYED`, or
`FINISHED` and no longer held) and the same dispose order.

Sequence bytes (`SEQ_CREATE` + `SEQ_MEMBER`) had two encoders: `encodeSequence` in `tween/backend.ts` (both backends)
and a hand-built copy in the plugin's `features/tweens.ts` from its own wire import. Only the copy clamped a member's
`offset` to the largest finite f32 (`MAX_OFFSET`); the module reads a non-finite offset as 0
(`native/common/tween/src/seq.rs`), so through a backend a member placed after an endless one (offset `Infinity`)
started at once instead of never.

## Decision

We will keep loaded curves in one cache, `src/engine/tween/curveCache.ts`:

```ts
interface CurvePort { loadCurve(curve: Curve): number; releaseCurve(handle: number): unknown }
class CurveCache {
  constructor(port: CurvePort);
  acquire(curve: Curve, key?: string): number; // one reference; key defaults to JSON.stringify(curve); 0 = refused, not remembered
  release(handle: number): void;               // the asset is freed with the last reference; unknown handles ignored
  releaseAll(): void;
}
```

- `AnimationWorldCore` holds one over the animation core (its `acquireCurve`/`releaseCurve` delegate; `close` calls
  `releaseAll`).
- `UIAnimator` holds one over its backend, keyed by `timingKey`. Each tween track holds the reference its tween eases
  through (`Track.curve`) and gives it back when the tween is released, killed or replaced by the track's next segment;
  a refused `create` gives it back at once. The animator's teardown calls `releaseAll` before disposing the backend.

The backends' live-handle bookkeeping is one class, `src/engine/tween/liveHandles.ts` (`LiveHandles`: `tween`,
`sequence`, `curve`, `freeCurve`, `tweenChanged`, `sequenceChanged(c, live)`, `endAll(ender)`); each backend supplies
only its module calls. It is the same knowledge in both (same change records, same dispose order). The animation
World's own tween/timeline sets are not folded in: it learns ends from the plugin's tween feature (`forgetTween`), not
from change records.

`encodeSequence` is the one sequence encoder and clamps every member's `offset` to the largest finite f32; the plugin's
tween groups call it (`encodeSequence(ns.id, head, members)`) instead of encoding records by hand.

## Alternatives considered

- **Keep the UI cache unreferenced and only stop caching failures** — fixes the permanent linear easing but still keeps
  every curve a document ever used loaded for the World's life.
- **Make the backends reference-count curves themselves** — the backend would have to know curve content; the callers
  already name content (`timingKey`, JSON), and the core path (`AnimationWorldCore`) isn't a backend.

## Consequences

**Positive**
- One rule for curve lifetime on both paths: loaded while used, released with the last user, refusals retried.
- One sequence encoder: the offset clamp reaches the standalone backend too.
- Tests through the interfaces: `curveCache.test.ts`; `tests/uiAnimationCurves.test.ts` (a provider wrapping the
  standalone backend refuses the first load: the next transition loads again, and the curve is released when its tween
  ends; both fail without the fix); `tween/standalone.test.ts` (a member at offset `Infinity` never starts; fails
  without the clamp).

**Negative / costs**
- Behaviour change on purpose: UI animation now loads a curve again after its last tween ended, rather than keeping it
  (a reload is one small table write).

## Deprecates

`AnimationWorldCore`'s `curves`/`curveByHandle` maps, `UIAnimator.loaded`, the backends' own `tweens`/`sequences`/
`curves` sets, and the hand-built `SEQ_CREATE`/`SEQ_MEMBER` encoding and `MAX_OFFSET` in `features/tweens.ts`: removed.

## Open questions

None.

## References

`src/engine/tween/curveCache.ts`, `src/engine/tween/liveHandles.ts`, `src/engine/tween/backend.ts`.

## As built

As above. Wire format and protocol versions are unchanged.
