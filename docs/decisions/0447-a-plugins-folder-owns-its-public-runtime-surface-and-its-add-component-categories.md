# 0447. A plugin's folder owns its public runtime surface and its Add Component categories

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0133, 0135, 0139, 0140, 0144, 0275, 0284

## Context

ADR 0275 said adding a first-party plugin is one catalogue entry. In practice it wasn't. Two more tables outside the plugin's folder named the plugin's parts one by one:

- `src/myco.ts` (390 lines; 23 commits in six weeks, 9 of them merges or ADR renumbers) listed each plugin's public names again, copied from that plugin's `runtime/index.ts`. Its comments cited ADR numbers that drifted: "The Lines plugin (ADR 0396)" sat over the CameraShake export, which it called 0435 while the plugin says 0436.
- `src/editor/componentCategories.ts` kept `BY_NAME`, a table of every built-in Component's Add Component submenu by short name. The camera shake commit (d73c214b) edited the catalogue, `plugins/runtime.ts`, `plugins/editor.ts`, `myco.ts` and `engine/index.ts`, and still needed a follow-up (80d8fde4) to list its Components under Rendering. MapObject needed the same follow-up (6128a9d0).

Nothing failed when a plugin was missing from either table: the Component landed in "Other", or the name never reached scripts.

## Decision

We will keep each of these facts in the plugin's own folder and make the shared files mechanical.

- **Public runtime surface.** Every first-party plugin with public names has `runtime/public.ts`: exactly what `myco` exports for it, re-exported from its implementation files. It holds no RuntimePlugin object and no internals. `runtime/index.ts` keeps the plugin object and internal exports and does `export * from "./public"`, so existing importers don't change.
- **`myco.ts` is a list.** It holds `export * from "./engine/index"`, one `export * from "./plugins/<folder>/runtime/public"` per plugin in catalogue order, the default plugin activation for library games, and `export * from "./plugins/runtimeSdk"` (the third-party SDK's runtime half: plugin types and `SDK_VERSION`). It names no ADRs. The Physics plugin's backend contribution point and the deprecated `TilemapCollider2D` alias move into `physics/runtime/public.ts`; `Curve`, `Gradient` and `evaluateGradient` move to `engine/index.ts`; the music handle types move to `audio/runtime/public.ts`. Navigation keeps an explicit block in `myco.ts` while its code is frozen (CLAUDE.md).
- **The public API is recorded.** `src/myco.test.ts` reads the declarations the engine library publishes (`virtual:myco-types`, emitted with `tsconfig.engine.json`). It compares `myco`'s export list (name and value or type) with `src/myco.exports.txt`, so a public API change is a reviewed diff. It also walks every declaration file `myco.d.ts` reaches and fails on an import of `@babylonjs/*`, `three`, `@dimforge/*` or `howler` (ADR 0010).
- **Categories come from the manifest.** `PluginManifest` gains `componentCategories?: Record<label, typeIds[]>`. The Add Component menu (`buildMenuTree`) looks up the plugin that registered a Component (`pluginOfComponent`), then its manifest. The engine's labels keep their order, a new label adds a submenu after them, and a Component no one categorises lands in Other. `componentCategories.ts` keeps a table only for the five Components the core registers (Camera, Light, Fog, ReflectionProbe, InputContext). Third-party `plugin.json` may carry the same key: it is parsed leniently, so a bad entry is a warning, never a refusal. A categorised third-party Component goes in that submenu instead of under Scripts.
- **One completeness test.** `catalogue.test.ts` walks `FIRST_PARTY`. For each plugin, every Component it puts in the Add Component catalogue has a category other than Other. Every id its manifest lists is a Component it registers. A plugin that registers Components has a `runtime/public.ts`, every value there is `myco`'s value of the same name, and each of its Component classes is one of `myco`'s exports.

This extends ADR 0275 (what adding a plugin takes) and ADR 0135 (what `myco` is built from).

## Alternatives considered

- **Categories registered by the editor half** (`ctx.registerComponentCategory`, a new ADR 0284 contribution point). This is closer to "editor-only concerns go through the editor context". But Sprites, Water and other plugins have no editor half and would need one only for this. The completeness test would also have to activate every editor half. Declarative data in the manifest is read without running plugin code, which is how `plugin.json` already handles `assetKinds`. Rejected.
- **Categories on the Component** (`@component(id, { category })`). This puts editor menu labels in the engine's registry API and core. Third-party scripts could set them too, which is a wider public API change than a manifest key. Rejected.
- **`runtime/index.ts` as the public module.** It exports the RuntimePlugin object and internals (`PHYSICS_2D`, `readTakeExtensions`, `MESHES_SPEC`…), so `export *` from it would publish them. Rejected.
- **Generate `myco.ts` from the catalogue.** A build step for what is now about twenty static lines, and the test already catches a missing line. Rejected.

## Consequences

**Positive**
- Adding a plugin means its catalogue entry, its halves (the compiler asks for the runtime one), its folder's `public.ts` and manifest categories, plus one `export *` line. A missing category or line fails `catalogue.test.ts` with the plugin's name.
- `myco.ts` changes only when a plugin is added or removed. What a plugin exports is reviewed in its folder and shows up in `myco.exports.txt`.
- ADR 0010 now has a test over the published declarations, not only source import scans.

**Negative / costs**
- Manifests, which ship in game builds, carry a few hundred bytes of menu labels per plugin.
- `plugin.json` gains a third-party-facing key (`componentCategories`) to document in the plugin SDK guide.
- `myco.exports.txt` must be updated (`vitest -u`) with every intended public API change.
- Navigation stays a special case (explicit names in `myco.ts`, a `Nav` prefix fallback in `componentCategories.ts`) until the freeze lifts.

## Deprecates

`BY_NAME` in `componentCategories.ts` (removed; the core table keeps five entries). The per-plugin export blocks in `myco.ts` (replaced by `export *` lines). The public export lines of each first-party `runtime/index.ts` (moved to `runtime/public.ts`).

## Open questions

- When the navigation freeze lifts: give `navigation/runtime/public.ts` its names and `navigation/manifest.ts` its categories, then drop the explicit block and the prefix fallback.
- Some runtime names exist in a plugin's `index.ts` but not in `myco` (`cloneSky`, `Decal2DClip`, `SubtitleSize`, `ZONE_PRESETS`…). Whether any should be public is for each plugin's owner. Adding one means adding it to `public.ts` and updating `myco.exports.txt`.

## References

`src/myco.ts`, `src/myco.test.ts`, `src/myco.exports.txt`, `src/plugins/*/runtime/public.ts`, `src/plugins/runtimeSdk.ts`, `src/plugins/manifest.ts`, `src/plugins/catalogue.ts`, `src/plugins/catalogue.test.ts`, `src/editor/componentCategories.ts`, `src/plugins/thirdParty.ts`.
