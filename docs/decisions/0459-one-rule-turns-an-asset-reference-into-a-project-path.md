# 0459. One rule turns an asset reference into a project path

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0040, 0148, 0371

## Context

A reference string names a project path, written bare or as `asset:x`, `asset:./x`, `./x` or `/x`, maybe followed by
`#slice` or `#Anim/Run`. The editor's `assetRefValues.ts` (ADR 0148) and the engine's `normalizeAssetPath` already said
so. About 100 places in `src/` ignored them and wrote `ref.replace(/^asset:/, "")` inline, some with
`.replace(/^\.?\//, "")` after it and some without. Local helpers repeated it too (`stripRef` three times, `graphPath`,
`gainKey`, `keyOf`, `clipPathOf`, `refPath`, `prefabPath`, `projectAudioPath`, `pluginModulePath`…). The result was
that `asset:./x` named two different files:

- The graph editor's self-link check got `./graphs/a.animgraph.json` and the runtime got `graphs/a.animgraph.json`, so the
  editor accepted a graph linked to itself (a cycle).
- The Material inspector reported a material's `asset:./shaders/…` graph as missing.

## Decision

We will turn references into paths with one rule, in `src/engine/scene/assetPath.ts`. The module has no imports, so any
module can use it, including the asset store, import settings and the animation compiler:

```ts
assetRefPrefix(ref): string        // the prefix as written: "asset:", "./", "/", "asset:./", "asset:/" or ""
normalizeAssetPath(ref): string    // the project path, #sub-asset kept: "asset:./a.png#walk" → "a.png#walk"
withoutAssetScheme(ref): string    // drops "asset:" only, for paths a UI document resolves against its own folder
```

- `Assets.ts` re-exports `normalizeAssetPath`, so existing importers are unchanged.
- The editor's `parseAssetRef`/`assetRefPath`/`assetRefTarget` (ADR 0148) and the migration's `jsonReferences.ts` use
  `assetRefPrefix` and no longer keep their own prefix regex.
- Editor code uses `assetRefTarget` (with the slice) or `assetRefPath` (without it). Plugin editors get them, and
  `parseAssetRef`, from the editor SDK. Runtime and engine code uses `normalizeAssetPath`.
- Every inline copy and alias helper is gone. Their callers call the rule directly.
- Two places keep `./` and `/` on purpose and use `withoutAssetScheme`: the UI document's `resolvePath` and the CSS
  `url()` the UI field sources write. In those, `./x` is relative to the document and `/x` is the project root.
- A guard test (`assetPath.test.ts`) fails if `/^asset:/` appears in any non-test module under `src/` other than
  `assetPath.ts`. Navigation is exempt while it is frozen.

## Alternatives considered

- **Keep the editor helpers and the engine function as two rules that happen to agree.** They agreed already, and that
  didn't stop the copies. Now there is one prefix regex, and the editor builds on it.
- **Name the engine function `assetRefPath`.** The editor's `assetRefPath` drops the slice, while runtime callers keep
  sub-assets such as `#Anim/Run`. Keeping the existing `normalizeAssetPath` name avoided both a clash and churn.

## Consequences

**Positive**
- `asset:x`, `asset:./x`, `./x` and `/x` name the same file everywhere: in the editor's checks, the inspectors and the
  runtime loaders.
- Fixed: a linked graph written `asset:./graphs/me.animgraph.json` is refused as a self-link
  (`graphEditLogic.test.ts`). A material whose graph is written `asset:./…` finds it (`materialShaderFile`,
  `materialAssets.test.ts`).

**Negative / costs**
- Behaviour change: places that stripped only `asset:` now strip a leading `./` or `/` too, so an `AssetRef` field loaded
  from a scene reads `images/a.png` for `asset:./images/a.png`. That is the canonical path, and every lookup already
  normalised it.

## Deprecates

Removed: `clipPathOf` (keys.ts), `pluginModulePath` (graphNodes/plugin.ts; the third-party plugin helper of the same name
is unrelated and stays), `projectAudioPath`, `refPath` (timelineModelLogic), `graphPath` (debug/targets), `prefabPath`
(tilemaps), plus the file-local `stripRef`, `gainKey`, `keyOf`, `assetKey`, `assetPath`, `projectPath`, `bare`, `where`,
`path` and `clipPath`.

## Open questions

- Navigation code (`src/engine/nav/formation.ts`, `src/plugins/navigation/**`) still has four inline copies. They are
  frozen until the upstream merge and are exempt from the guard until then.

## As built

- `src/engine/scene/assetPath.ts` (+ `assetPath.test.ts`: forms and guard). `Assets.ts` re-exports `normalizeAssetPath`.
- SDK: `src/editor/sdk/index.ts` exports `assetRefPath`, `assetRefTarget`, `parseAssetRef`, `AssetRef`.
- New `materialShaderFile(settings)` in `src/plugins/materials/editor/materialAssets.ts`. The Material inspector uses it.
