# 0417. Game UI is built only from UI documents; hand-built UI nodes, the screen `Text` component and `LocalizedText` are removed

- **Status:** Accepted, amended by 0419 (UI components come only from a `UIView`'s Svelte render: wave D retired UI documents, and a saved `engine.UIDocument` fails to load naming 0419)
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** 0020 (the interim screen `Text`), 0069 (authoring UI as hand-placed component nodes; the components stay as what document elements are made of), 0356 §4 (`LocalizedText` only; `t:` attributes stay)
- **Related:** 0069, 0076, 0077, 0340, 0356, 0357, 0385

## Context

Game UI can be made three ways today:

- **UI documents (0077):** `*.ui.xml` markup, `*.ui.css` stylesheets, a `UIDocument` component and scripts using `ui.query`, `ui.data` and `ui.list`. They can be edited in the scene view.
- **Hand-built UI nodes (0069):** `UICanvas`, `UIPanel`, `UIText`, `UIImage`, `UIButton` and `UIInputField` placed node by node in scenes and prefabs, through the Create menu or Add Component, or added by scripts with `addComponent`.
- **The interim screen `Text` component (0020):** a canvas-texture label positioned by `anchor` and `offset`, with an outline. 0069 kept it "so existing scenes work".

0077 kept hand-built nodes working beside documents. Having three paths means three ways to do the same screen, two text components with different fields, and `LocalizedText` (0356 §4) existing only to localise hand-built text. It also carries the problem 0077 set out to fix: structure, look and behaviour mixed together in Inspector fields and code. Among the samples, Pirates uses hand-built nodes (`scenes/menu.scene.json`, `prefabs/hud.prefab.json`, `scripts/behaviors/Hud.ts`). Flappy, Arena, Sound Lab and Navigation use `Text` (25 labels in 11 scenes). 17 of those labels have an outline, and `UIText` has no outline field.

## Decision

**Game UI is authored only as UI documents, with markup, stylesheets and scripts. The other two paths are removed outright, not deprecated, and the samples are migrated.**

- **UI components are made only by documents.**
  - `UICanvas`, `UIPanel`, `UIText`, `UIImage`, `UIButton` and `UIInputField` stay public. They are the types of document elements (`element.as(UIButton)`, field writes at runtime, `getBehavior` on a document's node).
  - Only a `UIDocument` building its tree creates them. Anything else is refused.
  - `addComponent(UIPanel)` and the other UI types throw: `UI elements come from UI documents (ADR 0417): add the element to a *.ui.xml document, or use ui.list() for rows made at runtime.`
  - A scene or prefab that saves one of these components on a node fails to load. The error names the file, the node path and this record. There is no automatic migration.
  - Runtime-made UI (pooled markers, rows) uses `ui.list()` with a `<Template>`, with `{field}` bindings in attributes for positions and colours.
- **The screen `Text` component (`engine.Text`) is removed.**
  - Its class, render path, editor node kind and picking go.
  - Its replacement is a document with a `<Canvas>` and a `<Text>`. `anchor` and `offset` become absolute positioning or flex alignment in the stylesheet.
  - A saved `engine.Text` is an unknown component type, with the same load error naming this record.
- **`UIText` gains a text outline:** `textOutlineColor` (Color, default none) and `textOutlineWidth` (UI px, default 0), written `text-outline-color` and `text-outline-width` in stylesheets. They are inherited like other text properties. Babylon GUI draws them (`TextBlock.outlineColor` / `outlineWidth`). This is what the migrated `Text` labels need.
- **`LocalizedText` (`engine.LocalizedText`) is removed.** Documents localise with `t:<field>` attributes (0356 §4). Scripts use `Locale.t` and `Locale.text`. The localisation gather reads documents and scripts only.
- **`SubtitleDisplay` (0357)** stops creating a `UICanvas` in code. Its default document has a `<Canvas>` root (screen mode, `sortOrder` 1000). "Under the node's own canvas" now means a canvas built by a document.
- **Editor**
  - The Create menu's UI section offers only **UI Document**. Its Canvas, Panel, Text, Image, Button, Input Field and Screen Text items go.
  - Add Component doesn't list the UI types.
  - Document elements are still selected, inspected and edited as 0077 §4 describes, including the Create menu adding elements into the selected document.
- **Samples are migrated.** Each label or screen becomes a `ui/*.ui.xml` and `ui/*.ui.css`, with a `UIDocument` node in the scene. Scripts write `ui.data` or query elements.
  - Pirates' document menu replaces `scenes/menu.scene.json`, and `menu-document.scene.json` is merged into it.
  - The Pirates HUD becomes a document.
  - Navigation's HUD label is migrated too. The owner lifted the navigation freeze for that label only. No navigation code changes.

## Alternatives considered

- **Deprecate first (warn, hide in the editor, remove later).** Gentler for outside projects. Rejected by the owner: there are no outside projects to protect yet, and a deprecation window keeps the three paths alive.
- **Keep `Text` as a lightweight label.** It costs nothing at load. But it's a second text component with its own fields and renderer, and a one-label document is a few lines.
- **Keep `LocalizedText` for other components' string fields.** Its own doc says it exists for hand-built scene UI, and nothing outside UI uses it in the samples. It can return in a record of its own if a non-UI need shows up.
- **Migrate saved scenes automatically.** Turning node trees into markup is feasible, but there are no outside scenes to convert. The samples are migrated by hand, and the result is better than a mechanical conversion.

## Consequences

**Positive**
- One way to make UI, which is the one the editor can edit visually and that keeps structure, look and behaviour apart.
- One text component, with an outline. `Text`'s canvas-texture renderer and `LocalizedText` are deleted.
- The editor's UI menu and Add Component list get shorter.

**Negative / costs**
- A breaking change: any scene, prefab or script using the removed paths stops loading or compiling. The samples are migrated in this change.
- A one-label HUD now needs two small files (markup and stylesheet).
- Runtime-made UI has to fit `ui.list()` and bindings. Anything more waits for 0077 §6 (Preact rendering into an element).

## Deprecates

- `engine.Text` (`src/engine/render/components.ts`) and its Babylon drawing and viewport picking: removed.
- `engine.LocalizedText` (`src/engine/ui/LocalizedText.ts`): removed.
- Creating UI components outside a `UIDocument` (scenes, prefabs, `addComponent`, the editor's UI Create items and Add Component entries): removed.
- 0077's line "Hand-built UI nodes from 0069 keep working beside documents" no longer holds.

## Open questions

- A UI-local way for scripts to add one element at runtime outside `list()` (`ui.append(selector, markup)`). It's left out until a screen needs it.

## References

- 0077 (UI documents), 0069 (UI components), 0020 (interim `Text`), 0356 §4 (`t:` attributes, `LocalizedText`), 0357 §5 (`SubtitleDisplay`)
- `src/engine/ui/UIDocument.ts`, `src/engine/ui/components.ts`, `src/engine/render/components.ts`, `src/engine/ui/LocalizedText.ts`, `src/editor/nodeKinds.ts`
