# 0131. Asset kind and visibility are field options on the Component declaration, and per-type Inspector extras come from a sections registry

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0022, 0042, 0043, 0057, 0065, 0083, 0103, 0112

## Context

The Inspector (`src/editor/ui/Inspector.tsx`, 1,430 lines) knows things about engine Components that belong to their declarations. It finds them by matching type ids and field names:

- **Asset kind.** `assetListFor(type, field)` maps 8 type/field pairs to a `<datalist>` of suggestions: `MeshRenderer.mesh` and `MeshCollider.mesh` (models plus `builtin:` meshes), `MeshRenderer.material` and `materials[n]` (materials and shader graphs), `Camera.targetTexture`, `ParticleSystem.effect`, `NavGroup.formationAsset`, `PostProcessing.lut`, `ReflectionProbe.bakedMap` (`.env` files only) and `Environment.map` (environments, skies, cubemaps and PNG/JPEG panoramas). Every other `AssetRef` field gets every file in the project. That includes 10 engine fields that have an obvious kind (`SpriteRenderer.sprite`, `AudioSource.clip`, `Tilemap.tileset`, the UI `font`/`image` fields, `UIDocument.document`, `NavChunk.bake`) and every `AssetRef` field in a user script Component.
- **Hidden fields.** `ParticleSystem.embeddedEffect`/`overrides` (edited by the effect editor below the fields, ADR 0057) and `Tilemap.layers` (painted in the Tile Palette, ADR 0103) are filtered out by name.
- **Per-type sections.** Under the fields, inline conditions add the particle effect editor, the Tilemap summary, "Edit sky" for Environment (0112), the NavChunk plan summary and Bake button, the ReflectionProbe Bake button, and `navNote()`, a switch over six navigation types (0065). All of them are imported statically into `Inspector.tsx`.

`FieldOptions` in `src/engine/core/registry.ts` has only `replicate`, `predicted`, `quantize` and `choices`. `listComponents` (`src/engine/editor/index.ts`) already passes each field's declared options to the editor as `FieldValue.options`; `choices` is read from there today (`fieldValues.ts` `editorFor`/`choicesFor`), so the path for field metadata exists. The asset kinds the browser knows (`AssetKind` in `src/editor/assetBrowser.ts`, 28 kinds found from the file name) are editor code; the engine can't import them.

Testing: "MeshRenderer.material offers materials" can only be checked through the rendered Inspector today, and `src/editor/ui/` has one unit test file (`particleGraph/search.test.ts`), none for the Inspector.

## Decision

We will declare asset kind and Inspector visibility on the field, and move per-type Inspector extras into a registry keyed by Component type.

**1. Two new field options (public API).** `FieldOptions` gains:

```ts
/** For an `AssetRef` field (or each item of `[AssetRef]`): the kind of asset it holds. The editor offers only those. */
kind?: AssetFieldKind | readonly AssetFieldKind[];
/** Not shown in the Inspector (still saved, loaded and replicated as usual). For fields another editor owns. */
hidden?: boolean;
```

Used as `@field(AssetRef, { kind: "material" })`, `@field([AssetRef], { kind: "material" })`, `@field(PlainObject, { hidden: true })`. `kind` on a field that isn't `AssetRef` or `[AssetRef]` throws when the decorator runs, like a nested list does today. Both only guide the editor, like `choices`: scene files and scripts may still hold any path.

**2. The kind vocabulary lives in the engine.** `AssetFieldKind` is a string union exported beside `AssetRef` in `registry.ts` (and from `myco`): `"model" | "mesh" | "material" | "texture" | "sprite" | "rendertexture" | "audio" | "particles" | "formation" | "lut" | "environment" | "envmap" | "tileset" | "font" | "uidocument" | "navbake" | "scene" | "prefab"`. It names what a field needs, not a file format. `mesh` is `model` plus the `builtin:` meshes; `material` includes shader graphs; `envmap` is a baked `.env` probe map; `environment` is anything an Environment's `map` takes. The engine never resolves these; the editor maps each to a filter in one table.

**3. One editor table turns a kind into suggestions.** New `src/editor/assetFieldKinds.ts`: `assetsForKind(kind, files): string[]` built on `assetKind()` from `assetBrowser.ts`, plus `assetKindsOf(field: FieldValue)` that reads `field.options?.kind` (list fields pass the item's options). `AssetLists` renders one `<datalist>` per `AssetFieldKind` (and the all-files list), and the asset input picks `asset-list-<kind>`, or a list for an array of kinds, from field metadata. `assetListFor()` and its type/field matching go.

**4. Engine Components declare their kinds.** The 8 pairs above, plus the 10 that get every file today (`sprite`, `clip`, `tileset`, `font` ×2, `image`, `document`, `bake`), get a `kind`. `ParticleSystem.embeddedEffect`/`overrides` and `Tilemap.layers` get `hidden: true`, and the name filter in `ComponentSection` goes. The editor reads metadata only; no Component type id is matched for kind or visibility.

**5. An Inspector sections registry, lazy (ADR 0083).** New `src/editor/ui/inspectorSections.tsx` (as built; the proposal passed `load` inside the options object):

```ts
interface InspectorSectionProps { scene: OpenScene; paths: NodePath[]; info: ComponentInfo }
registerInspectorSection(type: string,
  load: () => Promise<FunctionComponent<InspectorSectionProps>>,  // wrapped in lazyComponent
  options?: { single?: boolean;      // only when one node is selected (most do)
              rootOnly?: boolean },  // only for a top-level node (NavChunk, ReflectionProbe, NavGroup)
);
inspectorSectionsFor(type: string, paths: NodePath[]): LazyComponent<InspectorSectionProps>[];
```

`lazyComponent` (0083) gains a props type parameter so a lazy section receives its props.

Each feature registers its section beside its own UI: `ParticleInspector.tsx`, `TilemapSummary` (moved out of `Inspector.tsx`), `EditSkyButton`, `NavChunkInspector.tsx`, `ReflectionProbeInspector.tsx`, and the six `navNote()` cases in `NavComponentInspectors.tsx`/`NavFormationInspector.tsx`. Registrations are gathered in one `src/editor/ui/inspectorSections.builtin.ts` that `Inspector.tsx` imports; it holds only `import()` thunks, so the section modules load the first time a Component that has one is inspected (the shared `<PanelLoading />` placeholder shows meanwhile, as for panels). `ComponentSection` renders `inspectorSectionsFor(info.type)` under the fields, in registration order. `navNote()` and the six inline conditions go.

The registry stays editor-internal for now (`src/editor`, not `myco` or `myco/editor`): only engine types register. Opening it to user scripts is a later decision (see Open questions).

**6. Tests are unit tests on metadata.** In-process Vitest, no DOM:

- `src/engine/core/registry.test.ts`: `kind`/`hidden` round-trip through `getFields`; `kind` on a non-asset field throws.
- `src/editor/assetFieldKinds.test.ts`: each `AssetFieldKind` filters a fixture file list as expected (materials include `.shadergraph`; `envmap` takes only `.env`; `mesh` includes `builtin:cube`).
- `src/editor/inspectorMetadata.test.ts`: for every registered engine Component, every `AssetRef` field declares a `kind` (so a new engine field can't forget one), and table checks such as `MeshRenderer.material → material`, `ParticleSystem.overrides` hidden, a user-style test Component with `@field(AssetRef, { kind: "audio" })` gets the audio list.
- `src/editor/ui/inspectorSections.test.ts`: `inspectorSectionsFor("engine.NavChunk")` has the plan summary and Bake sections, and nothing is loaded until asked.

The existing Playwright Inspector specs stay as the end-to-end check.

## Alternatives considered

- **Keep matching names, but in a table** (`{ "engine.MeshRenderer.material": "material", ... }` in the editor) — smaller change and no public API, but user script Components still get no filtered pickers, and the table drifts from the declarations it describes.
- **A distinct marker per kind** (`@field(MaterialRef)`, `@field(MeshRef)`, …) — reads well, but multiplies `ScalarFieldType` members, every consumer of `AssetRef` (`editorFor`, scene loading, netcode, list items) would have to learn each one, and a field that takes several kinds has no form.
- **Use the editor's `AssetKind` as the vocabulary** — no new list, but it names file formats (`shadergraph`, `cubemap`, `image`) rather than needs, and the engine can't import editor code; the needs-based list maps onto it in one place instead.
- **File extensions on the field** (`{ accept: [".mat", ".shadergraph"] }`) — flexible for user formats, but leaks file layout into Components and duplicates `assetKind()`. Left as an open question for custom kinds.
- **Sections as a public decorator on the Component** (`@inspector(() => import(...))`) — puts editor UI references into engine classes and the runtime build; the registry keeps that dependency in the editor.

## Consequences

**Positive**
- User script Components get filtered asset pickers by declaring `kind`, with no editor change.
- 10 engine fields that suggest every file today get a filtered list.
- `Inspector.tsx` loses `assetListFor`, the hidden-field filter, `navNote()`, `TilemapSummary` and the static imports of the particle, nav, probe, tilemap and sky UI (roughly 120 lines); each feature's Inspector UI sits with the feature.
- Section modules (particle effect editor, nav previews, bake buttons) leave the Inspector's start-up chunk and load on first use.
- "This field offers materials" and "every engine asset field has a kind" become fast unit tests.

**Negative / costs**
- Public API grows: `FieldOptions.kind`, `FieldOptions.hidden`, `AssetFieldKind`. The kind list is a vocabulary we must keep stable; adding a kind is cheap, renaming one breaks scripts.
- Two vocabularies to keep in step: engine `AssetFieldKind` (needs) and editor `AssetKind` (file formats), joined by `assetFieldKinds.ts`; its test covers every member.
- Lazy sections show a "Loading…" line the first time a NavChunk, ParticleSystem or similar is inspected, unless preloaded when idle (as panels are).
- About 18 field declarations across `render/`, `physics/`, `nav/`, `audio/`, `tilemap/`, `ui/` change, plus the Inspector refactor: roughly a day of work, mostly mechanical.

## Deprecates

- `assetListFor()` and the per-pair `<datalist>` ids in `Inspector.tsx` (replaced by one list per `AssetFieldKind`).
- The name-based hidden-field filter for ParticleSystem and Tilemap.
- `navNote()` and the inline per-type sections in `ComponentSection` (moved into the sections registry).

## Open questions

- **Custom kinds for user asset formats.** Should `kind` accept a free string with a filter the project supplies (or an `accept` list of extensions), or should users wait for a public editor extension API?
- **Public sections registry.** When user scripts can extend the editor, should `registerInspectorSection` move to `myco/editor`?
- **Other per-field special cases.** `MeshRenderer.variant`'s dropdown of the model's material variants (0118) and the collider "Edit Collider" button still match type names; they could become field or section metadata later.
- **Drag-and-drop.** Should dropping an asset on a field be refused when its kind doesn't match? This record only filters suggestions.

## References

- `src/editor/ui/Inspector.tsx` (`assetListFor`, `AssetLists`, `ComponentSection`, `navNote`)
- `src/engine/core/registry.ts` (`FieldOptions`, `AssetRef`, `field`), `src/engine/editor/index.ts` (`FieldValue.options`)
- `src/editor/assetBrowser.ts` (`AssetKind`, `assetKind`), `src/editor/fieldValues.ts` (`editorFor`, `choicesFor`)
- `src/editor/ui/lazy.tsx` (ADR 0083)
- `docs/plans/2026-11-architecture-followups.md`, section D
