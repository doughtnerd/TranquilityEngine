# 0419. Game UI is authored as Svelte components, rendered onto the UI core; UI documents are retired

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** 0077 (the `*.ui.xml` markup format, `{name}` bindings, `ui.data`/`ui.list()`, and markup-only scene-view editing; its CSS subset and its event core stay), 0077 §6 (Preact for dynamic parts)
- **Related:** 0020, 0076, 0309, 0340, 0356, 0417, 0418

## Context

0417 made UI documents (`*.ui.xml`, `*.ui.css`, `UIDocument`, scripts) the only way to build game UI. The owner prefers to author UI in Svelte instead and retire UI documents.

0077 rejected Svelte because it had no custom renderer. That has changed. The spike (`spikes/svelte-ui/README.md`, Svelte 5.59.2) found:

- **The renderer works.** Svelte's experimental custom renderer (`compilerOptions.experimental.customRenderer`, `createRenderer` from `svelte/renderer`) renders a component with props, runes, `{#if}`, keyed `{#each}`, snippets, `onclick`, `class:` and `style:` into real UI core elements. They're styled by the cascade and clickable through the real `UICore`.
- **Sizes, min+gzip:**

  | What | Size | Where it ships |
  |---|---:|---|
  | Svelte runtime for a full sample | 27.2 KB | games |
  | Renderer glue | 3.1 KB | games |
  | The markup and CSS parsers games load today | 40.9 KB | games |
  | `svelte/compiler` | 219 KB | editor and export only |

- **CSS:** Svelte scopes styles with hash classes and `:where()`, and under a custom renderer only `css: 'external'` works.
- **Editing:** with `dev: true`, every rendered element carries its template location. `parse()` gives spans precise enough to patch literal attributes in the source.
- **Bindings:** `bind:` on elements is refused under a custom renderer, even on HTML tag names (`<input bind:value>` compiles in DOM mode and is refused with `customRenderer`). `bind:` on component props compiles. The refusal is in `phases/2-analyze/visitors/BindDirective.js`, because the client binding helpers (`internal/client/dom/elements/bindings/`) are DOM code.
- **Other refusals under a custom renderer:** Svelte transitions and `animate:`, `<svelte:window|document|body|head>` and `{@html}`.

The UI core needs to grow anyway (0418), whatever authors it.

## Decision

**Game UI is authored as Svelte 5 components (`*.svelte`, plus `*.svelte.ts` rune modules), rendered by the engine's custom renderer onto the UI core. UI documents are retired once the migration below finishes.**

- **Dependency and compiling.**
  - `svelte` is pinned at exactly `5.59.2` (MIT), with a patch for bindings (below).
  - Components compile with `experimental.customRenderer` pointing at the engine's renderer module, `css: 'external'`, and `dev: true` in the editor.
  - They compile in the editor (Play, hot reload on save, type checks beside scripts) and at export, like scripts. Games ship only the runtime and the renderer, never the compiler.
- **Tags are HTML names, which the renderer maps onto UI core elements:**
  - `div`, `section`, `nav` and other block containers → Panel
  - `span`, `p`, `h1`–`h6`, `label` → Text
  - `img` → Image
  - `button` → Button
  - `input` → InputField
  - Unknown tags warn once and render as Panel.
  - Attributes are component fields in kebab-case (as in 0077). `class`, `id` and `style` feed the cascade, which matches the tag as written (`div`, `button`).
- **Mounting: `UIView`** replaces `UIDocument`.
  - Its fields: `component` (a `.svelte` asset), the canvas settings (`mode`, `referenceResolution`, `matchHeight`, `sortOrder`, `pixelSize`, `modal`, `autoFocus`, `player`), and `stylesheets` (global `*.ui.css` themes).
  - It makes the canvas root itself, so components never write a canvas tag.
  - Scripts pass data through `view.props` (reactive) or share state through `.svelte.ts` modules. Components import the engine API from `"myco"` (`Input`, `Audio`, `Locale`…).
- **The UI core's external tree host.**
  - The renderer creates, changes, moves and removes ordinary UI elements through a host the UI core gives the UI plugin. It is internal, not game API. This is the spike's `ui.host`, made real.
  - The host also handles: restyling in the same frame; mounting again after a hot reload; registering elements for editor picking; and a flush system ordered before the UI sync, so Svelte's microtask updates show in the frame of the click that caused them.
  - **0417 is amended:** UI components are created only by a `UIView`'s render (and, until retired, by a `UIDocument` build). `addComponent` stays refused.
- **Element bindings: patch Svelte, offer it upstream.**
  - `patches/svelte+5.59.2.patch` (`patch-package`, as for Babylon) makes `bind:` on elements work under a custom renderer.
  - The renderer interface gains an optional `bind(node, name, get, set) → cleanup`. The compiler emits it for element `bind:` when a custom renderer is set, and keeps refusing when the renderer has no `bind`. `bind:this` gives the renderer's node.
  - The engine renderer implements `bind:value` on `input` (from the UI core's change events, 0309), and later `bind:checked`/`bind:value` on toggles and sliders.
  - The patch goes upstream as an issue and pull request. If Svelte ships element bindings for custom renderers, we delete our patch and follow theirs. If not, we keep a correct, renderer-driven version.
- **Events.** `onclick`, `oninput`, `onchange`, `onsubmit`, `onfocus`, `onblur`, `onpointerenter` and `onpointerleave` come from the UI core's interaction log (0309). They run in the same place UI document handlers run today, and a handler gets a `UIEvent`.
- **Styles.**
  - A component's scoped `<style>` (CSS from `css: 'external'`) and the view's `stylesheets` both feed the cascade.
  - 0418 wave 5's `:where()`, `:is()` and case-insensitive tag matching become prerequisites, because Svelte's scoping emits them.
  - Svelte transitions stay unavailable; 0418 wave 4's CSS transitions and keyframes take their place.
- **Localisation and navigation.**
  - `t("key", args)` from `myco` is reactive to the language (0356). `t:` attributes go.
  - Navigation (0340) keeps its attributes: `nav-up`, `focusable`, and so on.
- **Editor.**
  - The hierarchy shows the rendered tree, and clicking UI selects the element whose template location `dev` compilation recorded.
  - Literal attributes and literal text are edited in the Inspector and with scene-view handles, written back to the `.svelte` source through `parse()` spans. Expressions, `{#each}` rows and child components' insides are view-only, with their source location shown.
  - The Create menu inserts tags into the selected element's component source.
- **Migration, in waves.**
  - A: the runtime (patch, renderer, host, `UIView`, editor and export compiling).
  - B: the built-in UI (`UIControlMapper`, `SubtitleDisplay`) and the samples.
  - C: the editor tooling.
  - D: removal of `UIDocument`, the markup parser, `src/editor/uiEdit` markup edits and `*.ui.xml`.
  - `*.ui.xml` keeps working until wave D.

**Owner decisions recorded as proposed defaults (confirm or change in review):**
1. Visual editing covers static parts only; dynamic parts are view-only.
2. UI documents keep working during migration and are removed in wave D, not in one cut-over.
3. 0418 waves 1–2 (format-neutral) run first or in parallel with wave A. 0418 wave 5's `:where`/`:is`/tag-case items are pulled forward into wave A.

## Alternatives considered

- **Svelte as a layer beside `.ui.xml`** (the spike's recommendation). Keeps full visual editing of markup, but leaves two formats. The owner prefers one.
- **Engine wrapper components for bindings** (`<Input bind:value>`, binding component props). Works without a patch, but plain `<input bind:value>` stays refused, and every element pays a component layer.
- **A preprocessor rewriting `bind:`** before compiling. Works now, but rewrites user code, needs care with member expressions and `bind:value={get, set}`, and errors point at rewritten code.
- **Keep UI documents.** Full visual editing and no experimental dependency, but no components, reactivity or familiar framework for UI that grows past bindings and `list()`.

## Consequences

**Positive**
- One UI format with components, props, snippets, runes and HTML-like tags, familiar to web developers.
- Games likely load less UI code: the runtime plus renderer (about 30 KB gzip) instead of the parsers (40.9 KB), if themes are also pre-parsed at export.
- `bind:` works as in normal Svelte, through a patch we can drop if upstream adds the same.

**Negative / costs**
- The only UI format rests on an experimental Svelte API, plus our patch. Mitigated by pinning exact versions, keeping the renderer and patch small, and having upstream as the way out.
- Visual editing gets partial: dynamic parts can't be edited in the scene view.
- A migration larger than 0417's: built-in UI, five samples, localisation attributes and the editor's UI tooling.
- The editor carries `svelte/compiler` (219 KB gzip).

## Deprecates

- `UIDocument`, `*.ui.xml`, `{name}` bindings, `ui.data`, `ui.list()`, `t:` attributes, the markup parser (`ui/document/markup.ts`) and the editor's markup edits (`src/editor/uiEdit/markupText.ts`): kept until wave D, then removed.
- `*.ui.css` stays, as global theme stylesheets on a `UIView`.

## Open questions

- Pre-parsing stylesheets at export (so games drop css-tree): measure in wave A.
- Whether `UIView` props are typed from the component (`$props()` types) in the Inspector.
- The upstream pull request's reception, and what to do if Svelte's eventual API differs from our patch's.

## References

- `spikes/svelte-ui/README.md`, `spikes/svelte-ui/src/{host,renderer}.ts`
- Svelte 5.59.2: `src/compiler/phases/2-analyze/visitors/BindDirective.js`, `src/internal/client/dom/elements/bindings/`, `src/internal/client/custom-renderer/`, `types/index.d.ts` (`svelte/renderer`)
- 0417, 0418, 0077, 0309, 0340, 0356; `patches/@babylonjs+core+9.32.0.patch` (how patches are carried)
