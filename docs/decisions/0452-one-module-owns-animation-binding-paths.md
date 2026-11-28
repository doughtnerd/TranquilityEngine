# 0452. One module owns animation binding paths (node path and field path)

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0371 "Bindings" and "Tweens", 0373)
- **Related:** 0371, 0372, 0373, 0424

## Context

A track's or tween's target is a node path relative to the Animator's (or director's) node and a field path on one of
its components (0371). What those two strings mean was written out wherever they were read:

- "the first child with that name at each step" four times (the runtime binding table, the Timeline model's
  `resolveNode` and `bindingProblem`, the Animation session's `nodeAt`);
- the relative path of a node copied verbatim twice (`animationSession.relativePath`, `timelineModelLogic.relativeNodePath`;
  `TimelineWindow.tsx` imported both);
- the field path's head / sub-path split eight times (key buttons, Add Property, the Timeline's Key button, the
  session's restore, the clip edits, the field-track shapes, the binding table, the tween target);
- "which track kinds bind a field" twice, with different answers (the Animation session excluded bone, marker and curve
  tracks; the Timeline listed the property kinds).

The copies had already drifted: the binding table accepted `materials[N].<name>` (one material slot's override, the
form model imports emit) and tweens write through that same binding, but the tween's read side only knew
`material.<name>`, so `tween(renderer, "materials[1].metalness", …)` failed with `no field`.

## Decision

We will keep binding paths in one pure module, `src/engine/animation/bindingPath.ts`, beside the track model
(`tracks.ts`), so the plugin's runtime and its editor half both import it. It imports no engine objects; nodes are
anything with `name`, `parent` and `children` (`PathNode<N>`, which `GameObject` satisfies).

```ts
resolveNodePath<N>(root: N, path: string, step?: (parent: N, part: string, child: N | null) => void): N | null
nodePathOf<N>(root: N, node: N): string | null
parseFieldPath(field: string): { head: string; sub: readonly string[]; material?: { name: string; slot?: number } }
fieldPathValue(headValue: unknown, field: string): unknown
trackBinding(track: Track): Binding | null
```

- `resolveNodePath` is the one "first child with that name" rule; "" and empty parts are the root. The optional `step`
  sees each step, so the binding table records what it looked at (its rebinding watches) and the Timeline flags
  missing nodes and same-named siblings, without walking the path themselves.
- `parseFieldPath` reads `material.<name>` and `materials[N].<name>` as material properties (the caller still checks
  the component is a MeshRenderer). The binding table's write and the tween's read both use it, so they accept the
  same paths.
- `fieldPathValue` is a sub-path's value inside its field's value (the field's value itself when there is no sub-path).
- `trackBinding` is the field a track writes: the property kinds (`float` … `discrete`) whose target names a
  component. Both windows restore exactly these after a preview.

The public tween API (`features/tweens.ts`, 0424) is unchanged.

## Alternatives considered

- **Put it inside the animation plugin's runtime** — the editor half already imports runtime modules, but the module
  needs nothing from the plugin; next to `tracks.ts` it sits with the format it reads.
- **Keep `resolveNode` in the binding table and have the editor reuse it** — the runtime walk is tied to its watches
  and to `GameObject`; the step callback keeps the rule in one place and the watching where it belongs.

## Consequences

**Positive**
- A tween on a material slot works; a path the binding table accepts, a tween can read.
- Changing what a path means (escaping names, indices) is one edit.

**Negative / costs**
- The Animation session no longer restores non-property tracks that happened to name a component (none of those wrote
  a stored field, so nothing visible changes).

## Deprecates

`animationSession.relativePath` and `nodeAt`, `timelineModelLogic.resolveNode` and `relativeNodePath`,
`fieldTracksLogic.subValue`, the binding table's `SLOT_PROPERTY` and the tween target's `walk`: removed. `NodeLike` in
`timelineModelLogic.ts` is now an alias of `PathNode`.

## As built

- Module and tests: `src/engine/animation/bindingPath.ts`, `bindingPath.test.ts`.
- Runtime: `properties/bindings.ts` (`resolveNode` over `resolveNodePath` with its watches; `componentWrite` over
  `parseFieldPath`), `tweens/target.ts` (reads through `parseFieldPath` / `fieldPathValue`). Bug test:
  `tweens.node.test.ts` "drives one material slot's override".
- Editor: `animationSession.ts`, `AnimationWindow.tsx`, `keyButtonLogic.ts`, `addTrackLogic.ts`, `recordLogic.ts`,
  `clipEditLogic.ts`, `fieldTracksLogic.ts`, `timelineModelLogic.ts` (`bindingProblem`, `animatedBindings`),
  `TimelineWindow.tsx`, `BindingPicker.tsx`.
- Raw clip writing (`rawClip.ts`, the timeline compile path, `subAssetClips.ts`, `clipImportLogic.ts`) was left as is.
