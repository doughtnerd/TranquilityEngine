# 0284. Editor contribution points are declared once, and registries record each entry's plugin

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0134, 0138, 0142, 0146, 0151, 0174, 0182, 0266, 0275

## Context

A plugin's editor half registers through `EditorPluginContext` (ADR 0133). Each of its 16 contribution points was written three times: a method on the interface (`sdk/plugins.ts`), a lambda building it in `activatePlugin`, and the registry in `sdk/contributions.ts`. Point-specific behaviour sat inline among the lambdas: a viewport tool with `editsComponents` brings its Edit toggle (ADR 0266), a settings section's keys are vetted (ADR 0151), and a panel's owner is written to a side table first.

Which plugin contributed an entry was recorded only for panels, in `sdk/panelOwners.ts` (ADR 0174), written before `register`, so a taken id needed its own check. Saved layouts (`layout/savedStore.ts`) and the panel catalog (`layout/registeredPanels.ts`) read that side table beside the panel registry.

## Decision

**One table of contribution points.** `CONTRIBUTION_POINTS` in `sdk/plugins.ts` has one row per point: the context method's name, its comment, and how it registers. `registryPoint(registry, { check, also })` covers the registry points: `check` vets the entry (settings sections: `checkSettingsSectionKeys`), `also` registers what comes with it (viewport tools: the Edit toggle), undone with it. `point(add)` covers a point that isn't one registry (Inspector sections, kept per Component type). A new point is its contribution type and registry in `contributions.ts` and one row.

**The context is made from the table.** `EditorPluginContext` is a mapped type of the table (`ContextOf<typeof CONTRIBUTION_POINTS>`), so the methods, their parameter types and their comments come from the rows; `activatePlugin` builds one function per row. Plugin authors see the same method names and parameters. One type change: `registerAssetKind` takes `AssetKindContribution` (its `T` defaulting to `any`) instead of being generic, so an explicit type argument (`registerAssetKind<Foo>(…)`) no longer compiles; no plugin used one.

**Registries record the owning plugin.** `Registry.register(entry, owner?)` takes a `ContributionOwner` (`plugin`, `pluginTitle`); `ownerOf(id)` gives the entry's plugin, kept after the entry is removed this session (a saved layout names the plugin to turn back on, ADR 0174) and cleared when the editor registers the id itself; `idsOf(plugin)` lists what a plugin registered this session. Every point records owners, not just panels; an owner is recorded only once the id is accepted.

**The side table goes.** `sdk/panelOwners.ts` is deleted; the panel catalog reads `panels.ownerOf`, `pluginPanelTypes` reads `panels.idsOf`, and `layout/catalog.ts` takes `ContributionOwner`.

## Alternatives considered

- **Keep the hand-written interface and check the table against it with `satisfies`** — keeps the interface readable as a block, but a new point is again two edits in the same file plus the registry, and the comments live in two places.
- **Registries declared inside the table** — one edit per point, but `contributions.ts`'s registries are imported by name across the shell, and the table's hooks (`componentEditToggle`, `checkSettingsSectionKeys`) would make `contributions.ts` import modules that import it.
- **An owner side table per point** — what panels had; it is the duplication this removes.

## Consequences

**Positive**
- One place per new point; point-specific rules sit in their row, not among sixteen lambdas.
- "Who contributed this" is answered for every point by its registry; a viewport tool's Edit toggle is owned by the tool's plugin.
- Layout code reads one source (the panel registry) for a panel's plugin.

**Negative / costs**
- `EditorPluginContext` is a mapped type: an editor shows its methods through the table's rows, and the emitted `myco/editor` declarations include the table's type.
- Building the context needs one cast (`Object.entries` loses the row types).

## Deprecates

`sdk/panelOwners.ts` (`PanelOwner`, `setPanelOwner`, `panelOwner`, `panelsOfPlugin`): removed; `PanelOwner` became `ContributionOwner` in `sdk/registry.ts`. The hand-written `EditorPluginContext` interface and `activatePlugin`'s per-method lambdas: replaced by the table.

## Open questions

- Inspector sections don't record their plugin (they aren't a `Registry`); nothing asks yet.

## References

`src/editor/sdk/plugins.ts`, `sdk/registry.ts`, `sdk/contributions.ts`, `layout/registeredPanels.ts`, `layout/savedStore.ts`, `layout/catalog.ts`; tests `sdk/plugins.test.ts`.
