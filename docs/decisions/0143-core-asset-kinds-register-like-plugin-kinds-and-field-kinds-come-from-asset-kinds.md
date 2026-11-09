# 0143. Core asset kinds register like plugin kinds; one asset kind module answers every per-kind question; field kinds come from asset kinds

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0134's "built-in entries go away kind by kind" and 0131's closed field-kind vocabulary)
- **Related:** 0131, 0133, 0134, 0139, 0140

## Context

ADR 0134 made asset kinds a contribution point and said the shared tables "consult the registry first and fall back to their built-in entries, which go away kind by kind as features move into plugins". That can't finish: scenes, prefabs, images, audio, scripts and plain text files are **Core** (GLOSSARY.md) and will never be plugins. So every per-kind question in the editor shell still has two tiers, a registry lookup and then a private table:

- `assetBrowser.ts`: `builtinKind`/`builtinExtensionLength` (a regex chain), `CODE_KINDS`, `canAddToScene` (a literal list), `builtinNodeForAsset` (a switch).
- `ui/Assets.tsx` `KIND_LABELS`, `ui/AssetPreview.tsx` `ICONS`, `thumbnails/keys.ts` `previewKind`, `assetFieldKinds.ts` `FILTERS`, `assetImport.ts` `ImportKind`, `ui/AssetInspector.tsx`.
- `assetKindLookup.ts` is 40 lines of one-line pass-throughs (`kindLabel`, `kindIcon`, `registeredKindOpens`…) that the tables call before falling back.

Kinds that now belong to plugins still have code in the shell, past the seam:

- **`particles`** (Particles plugin) is in `canAddToScene` and has its own `case` in `builtinNodeForAsset`; the plugin registers the kind but no `addToScene`.
- **`model`** (Meshes plugin, ADR 0140): its import settings stay in the shell, `ImportKind = "image" | "audio" | "model"` and about 60 lines of model UI in `AssetInspector.tsx`.
- **Field kinds**: the engine's `AssetFieldKind` (ADR 0131) is a closed union of 18 names, several of them plugin kinds (`tileset`, `uidocument`, `lut`, `formation`, `particles`, `navbake`). In `FILTERS`, 9 of the 18 entries are `() => false` placeholders whose answer comes from a plugin kind's `referencedAs`. A third-party plugin (ADR 0139) can register an asset kind but can't give its own Components a field kind for it.

Testing one kind means importing six modules (`assetKindRegistry.test.ts`).

## Decision

We will register core asset kinds through the same `AssetKindContribution` plugins use, and answer every per-kind question from one asset kind module.

- **Core kinds register from the editor shell.** New `src/editor/assetKinds.builtin.ts` registers `scene`, `prefab`, `image`, `audio`, `rendertexture`, `script`, `json`, `xml`, `javascript`, `typescript` and `text` at boot, the way `ui/inspectorSections.builtin.ts` registers built-in Inspector sections. They are Core, not a plugin: they can't be disabled and appear in no manifest. `rendertexture` stays here until it moves to a plugin.
- **One asset kind module.** `assetKindLookup.ts` grows into the module that answers "what is this file and what can it do": the kind of a path (longest extension match over every registered kind, case-insensitive; a dotfile is no match; a `#slice` entry of an image is `sprite`; no match is `other`), and each kind's label, icon, open behaviour, Code-panel policy, add-to-scene, import settings, preview and the field kinds it satisfies. The `BuiltinAssetKind` fallbacks in the 8 files above are deleted; callers ask only this module. `folder`, `sprite` (slice entries) and `other` are answered by the module itself, not registered.
- **Behaviour moves onto contributions.** Core kinds' `addToScene` (prefab/scene instances, sprites, audio sources) and `codeEditor` move into their registrations. The Particles plugin registers `addToScene` for `particles`; the shell's `particles` cases go. `AssetKindContribution` gains `importSettings` (the import-settings view for a selected file, loaded on first use); image and audio supply theirs from the shell, and the Meshes plugin supplies the model one, so `ImportKind` and the model UI leave `AssetInspector.tsx`.
- **Field kinds come from asset kinds.** `AssetFieldKind` stays exported from `myco` with its 18 known names, widened to accept any string (`AssetFieldKind | (string & {})`), so a third-party Component can declare `@field(AssetRef, { kind: "spin" })`. The editor finds a field kind's files from the asset kinds whose `referencedAs` names it. Core kinds declare theirs (`image` → `texture`, `sprite`; `audio` → `audio`; `scene` → `scene`; `prefab` → `prefab`; `rendertexture` → `rendertexture`). `mesh` stays one core rule: files whose kind is referenced as `model`, plus the `builtin:` meshes. The `FILTERS` table goes. `ASSET_FIELD_KINDS` stays as the list the engine's own Components use, for `inspectorMetadata.test.ts`.
- **Unchanged.** `preview` stays a closed union of internal renderer names (ADR 0133: renderers stay first-party). A disabled plugin's files still show as generic files (`json`, or `other`). Registration order doesn't matter, because the longest extension wins.

## Alternatives considered

- **Keep the two tiers and finish moving kinds into plugins** (0134 as written). Core kinds never move, so the fallbacks are permanent, and every new per-kind question adds another pair of lookups.
- **A "core" plugin holding the built-in kinds.** One registration path, but it could be disabled or shown in the Plugins category, and GLOSSARY.md says Core is never a plugin.
- **Field kinds as file extensions** (`{ accept: [".spin.json"] }`, 0131's open question). This leaks file layout into Components and duplicates kind matching; `referencedAs` already expresses "which fields may reference it".

## Consequences

**Positive**
- Locality: what a kind is and does sits in one registration; the shell's per-kind branches go.
- Third-party asset kinds can be referenced by typed fields.
- One kind can be tested with one fake contribution against one module.
- Particles and models stop having code in the shell.

**Negative / costs**
- A typo in a field kind is no longer a type error. The editor warns once about a field kind no registered asset kind satisfies, instead of offering no files silently.
- Core kinds now depend on boot-time registration. A test that resolves kinds must register them (one helper call).
- `AssetFieldKind` widening is a public API change in `myco` (additive: existing code still compiles).

## Deprecates

- `BuiltinAssetKind` fallbacks: `KIND_LABELS`, `ICONS`, `CODE_KINDS`, `builtinKind`, `builtinExtensionLength`, `builtinNodeForAsset`, `canAddToScene`'s literal list, `previewKind`'s hard-coded endings, `FILTERS`, `ImportKind`. Removed.
- The one-line pass-throughs in `assetKindLookup.ts`, replaced by the module's own interface.
- The dead fallback stubs `AssetInspector.tsx` still imports (`ui/TilesetInspector.tsx`, `NavFormationInspector`, `ui/ParticleInspector.tsx`). Removed.

## Open questions

- Whether `folder` should register too, so the Assets panel has no special case at all.
- Moving `rendertexture` into a plugin (implementation status lists it as not yet moved).

## References

- `src/editor/assetKindLookup.ts`, `assetBrowser.ts`, `assetFieldKinds.ts`, `assetImport.ts`, `thumbnails/keys.ts`, `ui/Assets.tsx`, `ui/AssetPreview.tsx`, `ui/AssetInspector.tsx`, `src/engine/core/registry.ts` (`AssetFieldKind`), `src/editor/sdk/contributions.ts` (`AssetKindContribution`).
- Architecture review, 2026-11-09 (candidate 1).
