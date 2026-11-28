# Spike: can the Audio Studio activate every plugin's editor half in a reduced context?

Throwaway. Base: branch `claude/admiring-hypatia-n09ol2` @ 87e7ff16 (fast-forwarded). Files here: `walk.mjs` (import walker, TypeScript compiler API), `halves.test.ts` + `vitest.config.mts` (experiment), `walk.out`, `results-{A,B,C}.txt` (raw output).

## Question
Planned new `diagnostics` contribution point: a plugin's editor half contributes profiler views. The Studio (`src/studio/boot/studioPlugins.ts`, ADR 0341/0408) activates only audio (both halves), physics runtime and physics-rapier runtime. Plan: the Studio activates every plugin's editor half in a reduced context where only points the Studio uses take effect. Feasible? What breaks?

## How halves are activated today
- `src/plugins/editor.ts`: `EDITOR_PLUGINS`, 18 editor halves (the catalogue has 21 entries; `sprites`, `water` and `physics-rapier` have no editor half).
- `editorBoot.ts` (first import of `main.tsx`) calls `applyEditorPlugins` (`editorPlugins.ts`, plugin set ADR 0144), then `reloadLayout()`. `editorPlugins.ts` itself imports shell state (`status` from `editor/state`, `layout/store`, `parseLayout`, `pluginNotices`) because it reports problems and re-parses the layout. `editorActivator.ts` is just `activatePlugin/deactivatePlugin/isPluginActive`.
- `src/editor/sdk/plugins.ts`: `activatePlugin(plugin)` builds the context from `CONTRIBUTION_POINTS` (29 points, ADR 0284). Each `registerX(entry)` writes to a module-level registry in `editor/sdk/contributions`, tagged with the owner; deactivation undoes it. The context is `{ plugins: PluginsView, register... }`. Nothing in `activatePlugin` needs the shell booted; the registries are plain singletons.
- Studio today: `activateStudioPlugins()` builds a plugin set with the same `editorActivator`, and `main.tsx` already imports `editor/state`, `editor/assetKinds.builtin` (`registerCoreAssetKinds`) and `editor/ui/editor.css`. So the Studio is already a "reduced editor context": live registries, no layout/panel/scene-view consumers.

## Per-half table (18 editor halves)
Static = static import closure of `plugins/<p>/editor/index.ts` (`walk.mjs`, type-only imports skipped). "state?" = reaches `src/editor/state.ts`; every half that does gets it via the `editor/sdk` barrel (`sdk/index.ts -> assetDocuments.ts -> state.ts`), not directly. Points = what `activate` calls (recorded in test A). All 18 activate cleanly in A, B and C below, in a Node environment (no DOM).

| plugin | static mods / KiB | state? | import-time side effects | points used | notes |
|---|---|---|---|---|---|
| particles | 497 / 5189 | yes (sdk) | none seen | AssetKind x3, Panel, InspectorSection, HierarchyCreateEntry, ViewportTool, PanelExtension, SceneOpenMigration | preview installs only inside a viewport tool's `install` |
| materials | 487 / 4958 | yes | none | AssetKind x4, Panel | |
| sky | 4 / 16 | no (dynamic only) | none | AssetKind, Panel | tiny |
| audio | 623 / 6765 | yes | none; activate calls `setCaptureProject` (global setter) | NameReferences, PlayStatsCounter, AssetKind x5, ViewportTool x4, SceneToolbarItem, InspectorSection x4 | already active in the Studio; imports `../runtime` (Audio) |
| navigation | 501 / 5137 | yes | none | AssetKind, ProjectSettingsSection, PlayStatsCounter, PanelExtension, InspectorSection x8, ViewportTool x2, SceneToolbarItem | `navBake` imports `editor/projects`; navigation is frozen, only read here |
| tilemaps | 508 / 5174 | yes | none | AssetKind x4, Panel, ViewportTool, InspectorSection, NameReferences, HierarchyCreateEntry, AssetAction x2 | |
| physics | 516 / 5154 | yes | none | ProjectSettingsSection, ComponentNote, ViewportTool x2, ComponentWireframe, IdlePrefetch | imports `physics/runtime`, `runtimeContext` |
| meshes | 486 / 4965 | yes | none | AssetKind x2, FieldChoices | statically imports `engine/scene/models` (three loaders) |
| environment | 2 / 1 | no | none | AssetKind x2 | |
| lights2d | 487 / 4975 | yes | none | ViewportTool, InspectorSection, ProjectSettingsSection, NameReferences, SpriteEditorTool x2, ImportSettingsSection, HierarchyCreateEntry x6 | |
| post-processing | 2 / 1 | no | none | AssetKind | |
| camera-shake | 488 / 4962 | yes | none | ViewportTool, InspectorSection x2 | |
| ui | 485 / 4952 | yes | none; **activate starts a dynamic import** (`loadBuiltinUI(() => import("../builtinUI"))`) | AssetKind x2 | pulls the Svelte built-in UI code into the Studio |
| lines | 490 / 4975 | yes | none | ViewportTool, InspectorSection x2, HierarchyCreateEntry x4 | |
| decals | 488 / 4975 | yes | none | ViewportTool, InspectorSection, HierarchyCreateEntry x2 | |
| subtitles | 3 / 2 | no | none; **activate starts a dynamic import** (`loadBuiltinUI`) | PlayToolbarItem | |
| animation | 621 / 5895 | yes | none | AssetKind x10, AssetNodesAugment, NodeAssetDrop, InspectorSection, SkeletonBones, ViewportTool x3, ProjectSettingsSection, Panel x3, FieldAdornment, FieldWriteInterceptor, ComponentHeaderAction x2, ImportSettingsSection x4, AssetAction, SpriteEditorTool x2, PlayStatsTable | reads `context.plugins.isActive("myco.physics"/"myco.audio")` at activate; already has `profiler/register.ts` using `registerPlayStatsTable` |
| ragdoll | 688 / 6067 | yes | none | InspectorSection, ViewportTool | |

Direct shell access beyond the context: none in any `index.ts` or `*/register.ts` (grep for `editor/state|layout/store` there is empty). The only non-sdk shell import in any half's folder is `navigation/editor/navBake.ts -> editor/projects`. `ui` and `subtitles` use `plugins/builtinUILoads`.

No half touches `document`/`window` at import or in `activate`: test B ran with `environment: "node"` (no DOM) and all 18 imported and activated. DOM-dependent code sits in lazily loaded views and in viewport-tool `install` callbacks, which nothing in the Studio calls.

## Experiment (`halves.test.ts`)
Command (the repo `vitest.config.mts` with `include` replaced; `mergeConfig` would concatenate `include` and run the whole suite, which I did by mistake once: 1290 files and 13702 tests passed in 520 s, no effect on the result):

    npx vitest run --config spikes/studio-editor-halves/vitest.config.mts --fsModuleCachePath /tmp/vitest-cache-spike-halves
    -> Test Files 1 passed (1), Tests 39 passed (39), Duration ~3 s

- A: recording Proxy context (every `register*` a counting no-op; `plugins.isActive` true for all): 18/18 ok (table above, `results-A.txt`).
- B: the real `activatePlugin` on all 18, no shell booted: 18/18 ok; 35 asset kinds and 7 panels registered; after `deactivatePlugin` of all, 0 kinds, 0 panels, nothing active (`results-B.txt`).
- C: Studio order (`registerCoreAssetKinds()` first = 14 kinds, then all 18 halves): no id collisions, 49 kinds, 7 panels, no errors (`results-C.txt`).

Not exercised: a real `diagnostics` point (doesn't exist), the Studio in a browser, runtime halves. Several editor halves read runtime state only when a consumer calls them (e.g. audio's `Audio.debug()` inside a PlayStatsCounter `count()`).

## Size / cost (`walk.mjs`, `walk.out`)
- Studio `main.tsx` static closure: 1729 modules, about 14.6 MiB of source. Union of all 18 halves' static closures: 1019 modules, about 8.9 MiB. **New static modules the Studio would gain: 0**, because it already imports `editor/sdk` (and with it state, contributions, layout store, panel UI, Svelte, three, Babylon via `audio` and the viewport tools). The real bundle could still change at the margin (tree-shaking can't drop an `index.ts` import of a gizmo module).
- Behind dynamic imports (inspector sections, panels, previews) the halves add 457 modules, about 5.1 MiB of source. They would be lazy chunks, fetched only if something calls the view loaders; the Studio has no inspector/panel host, so they would be dead chunks in `dist/studio` (disk size, not load cost). Not measured with a real build.
- Activation cost: registry inserts, a few ms. Exceptions: `ui` and `subtitles` start a dynamic import at activate (Svelte built-in components for project code), which the Studio doesn't need.

## Verdict
Feasible with little breakage: `activatePlugin` works against bare registries, all 18 halves activate cleanly with no shell, no DOM and no Studio-specific shim, and nothing collides with the core kinds. What does not come for free:
1. "Everything else is a no-op" is not what the real context does: it writes every point into live registries (49 kinds, 7 panels, many viewport/inspector entries) that nothing in the Studio reads. Harmless, except `registerAssetKind`, which the Studio does consume: its asset library and kind pickers would list material/shader/tileset/model kinds unless filtered. A product change, not a crash.
2. Activation side effects: `ui` and `subtitles` dynamic-import Svelte built-ins; audio sets the capture project (already so today).
3. Coupling: 15 halves statically depend on the whole `editor/sdk` barrel and so on `editor/state.ts`. Works only because the Studio already imports it; if the Studio ever drops the shell state, every half drags it back.
4. Dependencies: `activatePlugin` doesn't check them (the plugin set does). Animation records "integrations" from `plugins.isActive`, so absent physics/audio runtime halves in the Studio give it different behaviour than in the editor.
5. Third-party and project plugins (`thirdPartyEditor.ts`) are not covered.

## Recommendation
Prefer a per-plugin `diagnostics` sub-module over activating whole halves.
- The editor half registers it from a small `diagnostics/register.ts` (as animation already has `profiler/register.ts`), through the new point; the Studio does not call `activate` but imports each plugin's `editor/diagnostics` module by path (preact plus the plugin's own logic, never `editor/sdk` or gizmos) and a small diagnostics-view registry both hosts read. No manifest entry, still inside the half's folder, and the Studio's graph stays independent of the sdk barrel. The editor and Studio share one implementation.
- If the owner prefers one registration path (activate everything), it works as tested. Mitigate (1) with a host flag on the context so non-diagnostics and non-asset-kind points are real no-ops, and skip `loadBuiltinUI` there; keep a unit test that activates every half under the Studio's context (test C here is a start).
- Decide separately whether the Studio should show non-audio asset kinds; if not, filter in the Studio library.

## Unverified
- Browser behaviour (Studio built and loaded), real bundle sizes and chunk output; only source-level import closures were measured, and barrel re-exports make them an over-approximation.
- Activation ran in Node with no DOM; DOM-dependent paths in views and tools were not run.
- Behaviour with the other plugins' runtime halves absent, beyond activating cleanly.
- Third-party editor halves, and the deactivate/re-apply flow through the real plugin set (`createPluginSet`) in the Studio.
