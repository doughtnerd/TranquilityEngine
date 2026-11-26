# 0419. Game UI is authored as Svelte components, rendered onto the UI core; UI documents are retired

- **Status:** Accepted, amended by 0421 (the Svelte runtime and renderer are bundled into each game's code at export)
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** 0077 (the `*.ui.xml` markup format, `{name}` bindings, `ui.data`/`ui.list()`, and markup-only scene-view editing; its CSS subset and its event core stay), 0077 §6 (Preact for dynamic parts)
- **Related:** 0020, 0076, 0309, 0340, 0356, 0417, 0418, 0420

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
- **Every refusal under a custom renderer,** from the compiler's `incompatible_with_custom_renderer` checks: element `bind:`, `transition:`/`in:`/`out:`, `animate:`, `{@html}`, `<svelte:window>`, `<svelte:document>`, `<svelte:body>`, `<svelte:head>`, legacy `on:`, and `css: 'injected'`.

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
  - Its fields: `component` (a `.svelte` asset), the canvas settings (`mode`, `referenceResolution`, `matchHeight`, `sortOrder`, `pixelSize`, `modal`, `autoFocus`, `player`). It has no stylesheet field: styles come from components (below).
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
  - There is no UI stylesheet file kind: `*.ui.css` goes with UI documents. All styling is ordinary Svelte:
    - a component's `<style>`, scoped by Svelte (`css: 'external'`);
    - `:global(...)` rules for themes and shared rules (for example `:global(:root) { --accent: … }` in a root component);
    - CSS custom property props (`<Card --accent="red"/>`);
    - plain `.css` files imported from a component's script (`import "./theme.css"`), as in any Svelte project.
  - **What `:global` reaches:** a global rule, or an imported `.css` file, applies to every `UIView` in the World, as global CSS applies to the whole page on the web. A HUD and a pause menu share one theme. Scoped rules apply only to their component's elements.
  - **Styles are parsed at export, not in games.** The editor and the export step parse every component's CSS and every imported `.css` with css-tree into the cascade's rule data, which games load as data. Games ship no CSS parser; css-tree stays an editor and export dependency. In the editor, CSS is parsed on compile, so hot reload works as it does today.
  - 0418 wave 5's `:where()`, `:is()` and case-insensitive tag matching become prerequisites, because Svelte's scoping emits them.
  - Svelte transitions run through the `animate` hook on 0418 wave 4's keyframe engine, beside CSS transitions and keyframes.
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

**Compatibility target: full Svelte, except what's impossible or meaningless in a canvas game (owner requirement).**

- **Every compile-time refusal becomes a renderer hook in the same patch.** Each hook is optional: the compiler keeps refusing when a renderer lacks it. Each is offered upstream on its own, and each is deleted if upstream ships an equivalent.
  - `bind(node, name, get, set)`: element `bind:`, including size bindings (`clientWidth`, `contentRect`…).
  - `animate(node, keyframes, options) → handle` and `measure(node)`: `transition:`, `in:`, `out:`, `animate:`. The engine renderer runs keyframes on the shared tween core (0420).
  - `globalTarget(kind)`: `<svelte:window>`, `<svelte:document>`, `<svelte:body>`, with events and bindings. The engine routes keys from the device snapshot (respecting UI claims) and `resize` and sizes from the canvas.
  - `html(anchor, string) → nodes`: `{@html}`.
  - `addStyles(css)`: `css: 'injected'`.
  - Legacy `on:` maps onto the same events as `onclick`.
  - `<svelte:head>`: its `<title>` sets the window title in desktop builds; the rest is ignored with a warning.
- **Svelte's official packages behave as documented:** `svelte/transition` (every built-in), `svelte/animate`, `svelte/motion`, `svelte/easing`, `svelte/store`, `svelte/events`, `svelte/attachments`, `svelte/legacy`, `svelte/reactivity`. Its `MediaQuery` follows canvas `@media`, and `svelte/reactivity/window` follows the canvas.
- **HTML elements behave like HTML** on new UI core elements:
  - `input` of types `text`, `password`, `number`, `checkbox`, `radio` (`bind:group`) and `range`
  - `textarea`, `select`/`option`, `progress`, and `label` (focusing its control)
  - inline `<svg>`
  - `video` (a video texture in an image element) and `audio` (through the engine's audio)
  - `contenteditable` with `bind:textContent`/`bind:innerHTML`
- **DOM event semantics:**
  - bubbling and capture (`onclickcapture`), `stopPropagation`, `preventDefault`;
  - pointer, mouse, keyboard, focus, wheel and drag events;
  - Svelte's root event delegation.
- **Renderer nodes offer an Element subset**, so actions, attachments and `bind:this` code work: `setAttribute`/`getAttribute`, `classList`, `style`, `dataset`, `addEventListener`, `getBoundingClientRect`, `focus`/`blur`, `scrollIntoView`, `closest`, `querySelector`/`querySelectorAll`, `contains`, `parentElement`/`children`. It is not a whole DOM.
- **UI core work this needs beyond 0418,** each in its own record:
  - event bubbling and capture
  - scrolling containers
  - filters (`blur` transitions, `filter`)
  - inline rich text (mixed styles in one text; `{@html}`; `contenteditable`)
  - SVG rendering
  - video
  - the new form elements
- **Conformance is measured, not claimed.** Svelte's own runtime test fixtures (the runes runtime samples in the Svelte repository, at the pinned version) run against our renderer in Vitest. The pass rate is tracked as a ratchet in implementation-status, and every failure is either fixed or listed as out of scope with the reason.
- **Out of scope (impossible or meaningless):**
  - server-side rendering and hydration;
  - `customElement` compilation;
  - `<script>` in `{@html}`, iframes, browser-history CSS (`:visited`);
  - third-party libraries that use `document`/`window` APIs beyond the Element subset and the hooks above.

**Owner decisions (confirmed 2026-11-26):**
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
- Games load less UI code: the runtime plus renderer (about 30 KB gzip) instead of the markup and CSS parsers (40.9 KB), because styles are parsed at export.
- One styling model, Svelte's: no separate stylesheet file kind, editor support or `UIView` field to keep.
- `bind:` works as in normal Svelte, through a patch we can drop if upstream adds the same.

**Negative / costs**
- The only UI format rests on an experimental Svelte API, plus our patch. Mitigated by pinning exact versions, keeping the renderer and patch small, and having upstream as the way out.
- Visual editing gets partial: dynamic parts can't be edited in the scene view.
- A migration larger than 0417's: built-in UI, five samples, localisation attributes and the editor's UI tooling.
- Full compatibility is a large program beyond 0418: event bubbling, scrolling, filters, rich text, SVG, video, form elements and an Element subset on renderer nodes, each its own record, plus a patch carrying several hooks until upstream takes them.
- The editor carries `svelte/compiler` (219 KB gzip).

## Deprecates

- `UIDocument`, `*.ui.xml`, `{name}` bindings, `ui.data`, `ui.list()`, `t:` attributes, the markup parser (`ui/document/markup.ts`) and the editor's markup edits (`src/editor/uiEdit/markupText.ts`): kept until wave D, then removed.
- `*.ui.css` and `<Style src>`: removed with UI documents in wave D. Themes move into `:global` rules or plain `.css` imports.

## Open questions

- Whether `UIView` props are typed from the component (`$props()` types) in the Inspector.
- The upstream pull requests' reception, and what to do if Svelte's eventual API differs from our hooks.
- The order of the compatibility records, and the conformance pass rate to reach before wave D retires UI documents (the owner sets it once wave A reports a baseline).

## References

- `spikes/svelte-ui/README.md`, `spikes/svelte-ui/src/{host,renderer}.ts`
- Svelte 5.59.2: `src/compiler/phases/2-analyze/visitors/BindDirective.js`, `src/internal/client/dom/elements/bindings/`, `src/internal/client/custom-renderer/`, `types/index.d.ts` (`svelte/renderer`)
- 0417, 0418, 0077, 0309, 0340, 0356; `patches/@babylonjs+core+9.32.0.patch` (how patches are carried)
