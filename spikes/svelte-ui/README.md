# Svelte UI spike

A feasibility spike, not engine code. Nothing in `src/` imports it, and `src/` was not changed.

**Question.** Can users write game UI in Svelte 5, rendered into the engine's UI core through Svelte's experimental custom renderer, eventually as a plugin (`src/plugins/svelte-ui/`) built on the UI core? What would the UI core need to expose, what does it cost in bytes, how does Svelte's CSS meet the UI stylesheet subset, can the editor trace and patch it, and what's missing compared with a DOM?

`svelte` **5.59.2** (exact) is a dependency of this folder only (`package.json` here). The root `package.json` doesn't have it.

## How to run

```sh
cd spikes/svelte-ui && npm install
../../node_modules/.bin/vitest run --config vitest.config.mts   # Q1, Q3, Q4: 11 tests, headless World
../../node_modules/.bin/tsc -p tsconfig.json                    # typecheck (engine sources included)
node sizes.mjs                                                  # Q2: prints the table, writes out/sizes.json
node probe.mjs                                                  # Q5: which Svelte features compile with a custom renderer
```

## Method

| File | What it is |
|---|---|
| `src/host.ts` | The **external tree host**: what a plugin would need from the UI core. A prototype that reaches into `UIDocument` internals from outside `src/`. Each internal it touches is marked `INTERNAL:`. |
| `src/renderer.ts` | The Svelte renderer (`createRenderer` from `svelte/renderer`), mapping Svelte nodes to hosted UI document elements, plus `render(doc, selector, Component, props)`, which is the plugin's `ui.render` (ADR 0077 §6). |
| `svelteCompile.mjs` | The whole toolchain: a 40-line Vite plugin that calls `svelte/compiler` with `experimental.customRenderer` pointing at the renderer. No `vite-plugin-svelte`. |
| `src/components/*.svelte` | `Hud` → `Shop` (props, `$state`, `$derived`, `{#if}`, keyed `{#each}`, a child component `Price`, a snippet passed in by `Hud` with an argument, `onclick`, `class:` toggles, `style:`). `Card` has a scoped `<style>`. `Field` covers input without `bind:`. |
| `src/svelteUI.test.ts` | Q1. Mounts into a document built by `buildUI` (`src/engine/tests/uiMarkup.ts`), clicks through `UIPointer` (a real `UICore` laying out and routing `Input`'s DOM adapter, the same path the engine's own UI document tests use), and checks the node tree, the fields, updates, keyed moves and unmounting. |
| `src/tooling.test.ts` | Q3 and Q4. Compiled CSS through `parseStylesheet`, a CSS adapter, dev-build locations, `parse()` spans and patching. |
| `sizes.mjs` | Q2. esbuild 0.28.2 (the repo's), tree-shaken, minified, `platform: browser`, gzip level 9. |
| `probe.mjs` | Q5. Compiles each Svelte feature with the custom renderer and prints the result. |

Svelte's package picks the custom-renderer runtime with the `svelte-custom-renderer` resolve condition. In a browser bundle, `browser` is enough. In Node (Vitest, export tooling) the condition is required, or `createRenderer` throws `custom_renderer_unavailable_on_server`.

## Answers

| Question | Answer |
|---|---|
| 1. Does the renderer fit? | **Yes, all 11 tests pass.** Props, `$state`, `$derived`, `{#if}`, keyed `{#each}`, a child component, a snippet, `onclick`, `class:` and `style:` all build real UI document elements (GameObjects with `UIPanel`/`UIText`/`UIButton`) under a document's `<Panel id="slot">`. The document's stylesheet styles them: classes, descendants, `:hover`, inheritance. `ui.query` and script handlers see them. A click goes through the UI core → `onclick` → `$state`, and the result shows **in the same frame**. A keyed reorder moves the **same GameObjects**. The engine needs a public "external tree host" (below). |
| 2. Sizes (min / gzip) | Svelte client runtime with the custom renderer: **56.4 / 21.2 KB** for a one-button counter, **72.5 / 27.2 KB** for the whole sample (components are 2.8 KB min of that). The same components in DOM mode are 54.1 / 20.3 and 69.9 / 26.3, so the custom renderer adds about 1 KB gzip. The spike's renderer and host glue add 7.5 / 3.1 KB. `svelte/compiler` bundled is **831 / 219 KB** (the prebuilt `compiler/index.js` is 865 / 226; `parse` alone is 490 / 123). The UI document parsers chunk, measured the same way, is **115 / 40.9 KB**, which confirms implementation-status's ~41 KB. A game with Svelte UI loads parsers + runtime ≈ **68 KB gzip**. The compiler goes only in the editor and export, never in a game. |
| 3. CSS | Svelte scopes rules with a hash class (`svelte-1s7zazm`) on every element that has a matching selector, and `:where(.svelte-x)` on descendants. The UI parser **rejects** `:where`, lowercase tags (`text`, `button`; Svelte tags are lowercase), `@media`, pseudo-elements and structural pseudo-classes (`:first-child`). `transition` and `transform` parse, then warn as unknown properties when the cascade runs. `:global(...)` comes out as plain selectors and works. **A 25-line adapter** (css-tree walk: tags to UI tags, `:where(.h)` to `.h`) leaves only real subset gaps. Pushed into the document's sheets, the scoped rules style the component (tested). `css: 'injected'` is **silently dropped** under a custom renderer, so the only option is `css: 'external'`. |
| 4. Editor source mapping | **Yes, per element, in dev builds.** `dev: true` puts `__svelte_meta.loc = { file, line (1-based), column (0-based) }` on every element node the renderer creates (Svelte's `add_locations`), before insertion. The host stores it per hosted element. Measured: `#card` 6:0, `#label` 7:2, `#tags` 9:4, `.tag` 11:8, `#toggle` 15:2. Text nodes and synthetic labels have none. Production builds have none. **`parse(src, { modern: true })`** gives `start`/`end` for elements, attributes and attribute value parts. line:column → offset → element → `class="label"` value span 191–196. Patching `gap="2"` → `gap="6"` through the span and recompiling works. So static literal attributes can be edited like `.ui.xml`. Anything in `{…}`, from `{#each}` or from a child component's props is code, so it's read-only. |
| 5. DOM gaps | **Rejected at compile time** with a custom renderer: every `bind:` (`value`, `this`, `group`, `clientWidth`), `transition:`/`in:`/`out:`, `animate:`, `<svelte:window|document|body|head>`, `{@html}`. **Compile and work:** actions, `{@attach}` (they receive the renderer node, so a plugin can hand out the element; tested), `class:`, `style:`, spreads, `<svelte:element>`, `<svelte:boundary>`, `{#await}`, `{#key}`, snippets. Details below. |

## 1. Renderer fit

### What the renderer does (`src/renderer.ts`)

- **Tags are lowercase:** `canvas`, `panel`, `text`, `image`, `button`, `input-field`. A capitalised tag is a Svelte component, so `<Panel>` can't be used as in `.ui.xml`. Unknown tags warn and are skipped.
- **Attributes are UI document attributes** (`flex-direction="column"`, `font-size={24}`). The cascade converts them as it converts markup attributes, at attribute precedence.
  - Svelte hands `setAttribute` raw values (numbers, booleans, objects). Its setter path is disabled for custom renderers. The renderer writes them as CSS text, so a `Color` becomes `rgba(…)`.
  - **`class:` toggles arrive as one whole `class` string** (the custom renderer always sets the whole attribute), along with Svelte's hash class.
  - **`style=` and `style:x` arrive as one `style` string.** The host splits it into attribute-level declarations, which win over other attributes, as inline style does.
- **Text.** Text nodes inside `<text>` are its `text`. Elsewhere, a text node with content becomes its own synthetic Text element, which is how a button label works, as `<Button>Play</Button>` does in markup.
  - Whitespace is collapsed and trimmed as markup does. Svelte keeps a space where inline HTML needs one (`{item.label} <Price/>` gave `"Bow "` before collapsing).
  - Svelte's anchors (comments) and whitespace-only text never become nodes. The ECS tree has exactly the elements (tested).
  - A text node can start as `' '` and get its content later (Svelte's template placeholder), so the renderer builds or drops it on `setText`.
- **Building.** Svelte builds each template instance fresh (no `cloneNode`) as a detached subtree, then inserts it. The renderer builds hosted elements when a subtree is connected to the mount container, then restyles the subtree once.
  - An `insert` of an already-connected node is a **move**: keyed `{#each}` reorders keep the GameObject (tested).
  - `remove` destroys the subtree.
  - Svelte stores symbol-keyed caches on nodes (`TEXT_CACHE`, `CLASS_CACHE`, `__svelte_meta`), so renderer nodes must be plain extensible objects.
- **Events** go to the document's existing handler layer (ADR 0077 §3, 0309).
  - The mapping: `onclick` → `click`, `oninput`/`onchange` → `change`, `onsubmit`, `onfocus`, `onblur`, `onpointerenter` → `hover`, `oncancel`.
  - Handlers receive the `UIEvent` (`element`, `document`, `item`), not a DOM `Event`.
  - Svelte calls custom-renderer handlers directly: no delegation, bubbling or capture phases.
  - Anything else (`keydown`, `wheel`, `pointerdown`) has no UI event. It warns.

### Frame timing (a real requirement, found by the test)

Svelte applies state changes in a microtask. A frame runs inside one `requestAnimationFrame` callback, so a handler's `count++` would reach the UI tree only after the frame had been drawn: one frame late. The host calls `flushSync()` in a system ordered after `engine.LateUpdateScripts` and before `engine.UIDocumentSync`. With it, a click shows its restyled result in the same `engine.step` (tested). The plugin needs to be able to order a system against `engine.UIDocumentSync`.

### What the UI core would have to expose: the "external tree host"

ADR 0417 says only a `UIDocument` build creates UI components. The prototype is a second creator, and it needed these internals (each marked `INTERNAL:` in `src/host.ts`):

| Need | Internal used now | Proposed public form |
|---|---|---|
| Create a UI element under an element, at an index | `new UIDocumentElement` (@internal ctor), `world._createNode`, `world._addComponent` (bypasses the 0417 guard), `el._children`, `world._setSiblingIndex` | `ui.host(element) → UIHostedTree` with `create(tag, parent, index, attributes)`. Its elements are ordinary `UIDocumentElement`s of the document, so query, handlers, `UIEvents`, the cascade, pseudo-classes and inheritance all apply. 0417 amended: the document's build **or its hosted trees** create UI components. |
| Set attributes, id and class later | a synthesised `MarkupElement` assigned to `el._markup` (the cascade reads attributes from it); `_target.id` (readonly: markup ids never change); `el._markDirty()` | `tree.setAttributes(el, map)`, which restyles in the late sync |
| Style a new subtree now | private `UIDocument.restyle` | done inside `create`/`mount` |
| Set a Text's text | a direct field write (fine as is) | `tree.setText(el, text)` |
| Move and remove | `world._setParent`, `_setSiblingIndex`, `_destroyNode`, `applyDestroys`, `_alive`, `_handlers` | `tree.move(el, parent, index)`, `tree.remove(el)` |
| The component's own CSS | private `UIDocument.sheets` (`parseStylesheet(css, file, order)` pushed in) | `ui.addStylesheet(text, file)`: an extra sheet, removed with the tree |
| An inline `style` attribute | the host parses it into attribute-level declarations | decide whether markup gains `style=` too |
| Editor picking and the Inspector | `elementByComponent` is module-private, so hosted elements **can't be picked** in this prototype | register hosted elements, so `UIDocument._elementOf` and the hierarchy show them, marked generated, read-only, with the dev location |
| Hot reload | a document rebuild drops hosted elements: they have no static path, like list rows (tested) | the host element survives a rebuild by path, and the tree is told to mount again (`_onBuilt` is editor-only today) |
| Flush before the late sync | `defineBuiltinSystem` (engine-only) | plugin systems (ADR 0135) able to order against `engine.UIDocumentSync` |

### Events, headlessly

Clicks were simulated through public paths. `UIPointer` (`src/engine/tests/uiPointer.ts`) runs a real `UICore` over the World and presses through `Input`'s DOM adapter. The UI core records the click, `UIDocument._collectEvents` walks the element tree (hosted elements included), and the element's handler runs the Svelte handler. **No custom routing was needed.** InputField typing wasn't driven through the core in `Field`: the test called the element's `change` handlers as `_collectEvents` would, with an internal read.

Side observation (not Svelte-related, not investigated): a click in the frame right after another click was sometimes not reported until a later frame, with markup-only buttons too. The test steps one frame between clicks.

### Rough cost (this container, median of 5, not a budget)

200 keyed rows, each a button with a label and a price Text:

| | Svelte (spike host) | `ui.list()` |
|---|---:|---:|
| Mount | 29.0 ms | 19.7 ms |
| Reverse the order | 12.7 ms | 2.0 ms |

The reverse is slow because the prototype's `place()` and `hostedIndex()` are O(n) per move, so O(n²) in total. A real host would keep sibling indices.

## 2. Sizes

esbuild 0.28.2, minified, tree-shaken, `platform: browser`, gzip level 9. The Svelte bundles use a stub renderer, so engine code isn't counted. `sizes.mjs` also writes the raw numbers to `out/sizes.json` (not committed).

| Bundle | min KB | gzip KB | brotli KB |
|---|---:|---:|---:|
| Svelte runtime + 1-button counter, custom renderer | 56.4 | 21.2 | 19.2 |
| Svelte runtime + the sample (Hud, Shop, Price, Card), custom renderer | 72.5 | 27.2 | 24.5 |
| The same, DOM mode (reference) | 54.1 / 69.9 | 20.3 / 26.3 | 18.3 / 23.7 |
| Spike renderer + host glue (engine excluded) | 7.5 | 3.1 | |
| `svelte/compiler` (`compile`, `compileModule`, `parse`), bundled | 831.2 | 219.1 | 178.1 |
| `svelte/compiler` `parse` only | 490.0 | 122.6 | 98.7 |
| `svelte/compiler/index.js` as published | 864.7 | 226.0 | 180.3 |
| **UI document parsers chunk today** (htmlparser2, entities, css-tree parser, `ui/document/`) | 115.2 | **40.9** | 37.4 |

- The runtime's floor is about 21 KB gzip: `mount`, effects, boundaries and blocks. It grows with the blocks a project uses: `{#each}`, snippets and `await` took it to 27 KB.
- The compiler's minified bytes: svelte 388 KB, acorn + acorn-typescript 230 KB, **a11y data (`aria-query`, `axobject-query`) 143 KB**, esrap 41 KB, magic-string 16 KB.
  - Export compiles in Node, so games ship none of it.
  - The editor would load it lazily (in a worker) to compile `.svelte` on save.
- Components compile with `runes: true` to avoid the legacy-mode import (`svelte/internal/flags/legacy`), which any runes-less component pulls in.

## 3. CSS

What Svelte emitted for `Card.svelte` (`css: 'external'`):

```css
.card.svelte-1s7zazm { background-color: #202020; padding: 4px; }
.card.svelte-1s7zazm text:where(.svelte-1s7zazm) { color: #eeeeee; }
.tags.svelte-1s7zazm > .tag:where(.svelte-1s7zazm) { font-size: 12px; }
button.svelte-1s7zazm:hover { background-color: #333333; }
.card.svelte-1s7zazm .external { gap: 1px; }             /* :global(.external) */
@media (max-width: 600px) { .card.svelte-1s7zazm { padding: 0; } }
.label.svelte-1s7zazm::before { content: "x"; }
.tag.svelte-1s7zazm:first-child { color: red; }
.card.svelte-1s7zazm { transition: opacity 0.2s; transform: scale(1.1); }
```

The class attributes in the template: `card svelte-1s7zazm`, `label svelte-1s7zazm`, `tags svelte-1s7zazm`, `tag svelte-1s7zazm`, and a bare `svelte-1s7zazm` on the `<button>`.

- **Rejected by `parseStylesheet`:**
  - `Unknown element "text"` and `"button"`;
  - `:where` (twice);
  - `@media`;
  - pseudo-elements;
  - `:first-child`.
- **Kept:** 3 rules, including the `:global` one.
- `transition` and `transform` aren't parse errors. The cascade warns once about each as an unknown property.
- The hash is derived from the **filename** passed to the compiler. The editor, the export and the runtime must compile with the same path, or the classes won't match.

| Option | Cost | What users get |
|---|---|---|
| **A. `css: 'external'` + adapter + `ui.addStylesheet`** (prototyped, tested) | ~25 lines on css-tree (already in the parsers chunk), plus the public `addStylesheet` | Co-located, scoped `<style>`, and Svelte's unused-selector warnings. `:where(.h)` becomes `.h`, which adds 0,1,0 of specificity Svelte meant to avoid; scoped rules still only match the component. Everything outside the subset warns, as in `.ui.css`. |
| **B. No `<style>`; the document's `.ui.css` styles by class** | Nothing. It works today: the tests style everything this way. | The UI document model as it is: one theme sheet, no scoping. A `<style>` block would have to be refused (lint or compile check), since `injected` is silently dropped. |
| **C. Extend the subset** | `:where()`/`:is()` matching (small, in `stylesheet.ts`); lowercase tag aliases (trivial); `:first-child`/`:nth-child`/`:not` (moderate: needs sibling access in `StyleTarget`); `@media` (moderate: a viewport input to the cascade); transitions, `@keyframes`, `transform` (large: a UI animation model, still an open question in 0077) | Closer to what Svelte users write. Each is a UI core feature, valid with or without Svelte. |

A and B can ship together: A for a component's own styles, B for themes.

## 4. Editor source mapping

- **Locations.** With `dev: true`, compiled templates are wrapped in `$.add_locations(…, filename, [[line, col, children]])`. Every renderer element gets `__svelte_meta = { loc: { file, line, column }, parent, component }` before it's inserted. `parent` is Svelte's dev stack (`if`, `each`, `component`, `render`), so the editor can also say "inside `{#each}` at 12:4".
  - The host recorded it per hosted element (`tree.sourceOf(el)`): `#label` → `src/components/Card.svelte:7:2`.
  - Not covered: text nodes (and so a button's synthetic label), and production builds. Dev-mode runtime size wasn't measured.
- **Spans for patching.** `parse(source, { modern: true })` gives `RegularElement.start/end`, and `attributes[i].start/end` with `value[j].start/end` for literal parts. For `<text id="label" class="label">` that was the element 167–212, `class="label"`, and the value 191–196. Replacing `gap="2"`'s value span with `6` and recompiling worked.
- **What's editable.** Literal attributes on elements written in the file (move, resize, field edits, "Move to class" into the component's `<style>` or a `.ui.css`). Not editable: anything in `{…}`, elements produced by `{#each}` (one source element, many nodes), and a child component's elements, which belong to its own file. This matches 0077 §6's line for Preact ("viewable, not editable"), but with more editable than Preact would have, because the template is a file.
- `parse()` alone is 123 KB gzip of compiler. The editor needs it only for `.svelte` editing.

## 5. DOM gap list

The renderer interface (`svelte/renderer`) compared with a DOM.

| A DOM has | The renderer interface |
|---|---|
| `cloneNode`/`importNode` | Not used: templates are rebuilt per instance (`from_tree`, a nested array). |
| Properties and setters | Attributes only. Svelte's setter detection (`get_setters`) is off for custom renderers, so values arrive raw through `setAttribute`. |
| `classList`, `style` object | Whole `class` and `style` strings, rewritten on every change. |
| Event propagation, delegation, capture, `stopPropagation` | Handlers called directly with whatever the host passes. No bubbling. `onclickcapture` compiles but means nothing. |
| `textContent`, `innerHTML` | `{@html}` is rejected. Injected `<style>` is dropped. |
| Layout reads (`getBoundingClientRect`, `clientWidth`), `focus()` | Nothing. `bind:clientWidth` is rejected. The plugin would have to give elements these (the UI core has `rectOf`). |
| `window`, `document`, `body`, `head` | `<svelte:window|document|body|head>` are rejected. |
| Namespaces, SSR and hydration | None. Custom renderers never hydrate. |

| Svelte feature | With the custom renderer | Workaround |
|---|---|---|
| `bind:value` / `bind:group` / `bind:checked` | **Compile error** | `value={v} oninput={(e) => v = e.element.value}` (tested in `Field.svelte`) |
| `bind:this` | **Compile error** | `{@attach (node) => …}`: it receives the renderer node, and the plugin exposes the `UIDocumentElement` (tested) |
| `bind:clientWidth` and other dimension binds | **Compile error** | A plugin attachment reading the UI core's layout rect each frame |
| `transition:`, `in:`, `out:`, `animate:` | **Compile error** | None until the UI core can animate fields (tween `opacity`, `top`/`left`, sizes). Even then, Svelte's transition engine is CSS/Web Animations-based and wouldn't plug in. It would be a plugin-specific attachment API. |
| `use:` actions, `{@attach}` | Work | They get the renderer node, not a DOM element. Libraries written for the DOM won't work. |
| `style:` directive | Works | Values must be UI properties. `--x` custom properties pass into the style string, and the cascade's `var()` reads only stylesheet variables (not checked). |
| `class:` directive | Works | |
| `<svelte:window onkeydown>` | **Compile error** | Engine `Input`, or the document's `cancel` event |
| `{@html}` | **Compile error** | None (no HTML) |
| `css: 'injected'` | Silently dropped | `css: 'external'` + §3 option A |
| Snippets, components, `{#if}`, `{#each}`, `{#await}`, `{#key}`, `<svelte:element>`, `<svelte:boundary>`, spreads | Work | |

**CSS that Svelte users would expect and the UI subset lacks**, from `stylesheet.ts` and the component fields:

- **Selectors:** `transition`, `animation`/`@keyframes`, `transform`, `@media`/`@container`, pseudo-elements, structural pseudo-classes (`:first-child`, `:nth-child`, `:not`, `:is`/`:where`), attribute selectors, sibling combinators (`+`, `~`), `!important`.
- **Values:** `calc()`.
- **Layout:** per-side `padding`/`margin`/`border-*`, `min-`/`max-width`/`height`, `flex-wrap`, `flex-shrink`/`flex-basis` (`flex-shrink` is fixed per kind), `align-self`, `overflow`/clipping, `z-index`.
- **Painting:** `box-shadow`, gradients, `font-family` by name (fonts are asset fields), `letter-spacing`, `line-height`.

**Could this become "Coherent Gameface-like"?** Gameface implements a real DOM and CSS subset, with transitions, animations and transforms, so unmodified frameworks run on it. This spike shows the structural part is already solved: Svelte's renderer interface maps cleanly onto document elements. The gap is everything above the renderer: a CSS animation and transition model, transforms, richer selectors, layout reads, and DOM-only Svelte features that the compiler refuses outright. Closing it is UI core work (and it helps `.ui.xml` equally), not renderer work. Even then, `bind:` and transitions stay unavailable until Svelte's custom-renderer mode supports them.

## Recommendation

**(a): `.ui.xml` stays the editable default, and Svelte is a component and dynamic-layer plugin** (`src/plugins/svelte-ui/`, `ui.render(selector, Component, props)`), filling 0077 §6's slot.

- **For (a):**
  - It works: the whole sample renders, styles, updates and takes clicks through the existing core, events and cascade. Hosted elements are ordinary document elements.
  - Games that don't use it pay nothing. Games that do pay about 27 KB gzip on top of the 41 KB parsers chunk, which they still need for the host document and themes.
  - The compiler stays in the editor and export.
- **Against (b), Svelte as the single format:**
  - Every UI game would pay the runtime.
  - The editor would need the compiler (219 KB gzip) to show anything.
  - Visual editing would cover only literal attributes, not `{…}`, `{#each}` rows or child components.
  - `bind:`, transitions and `svelte:window` are refused by the compiler.
  - The feature is `experimental` (its API and resolve condition may change), which is a poor base for the only UI format.
  - 0417 just consolidated on documents.
- **Against (c), don't:**
  - 0077 rejected Svelte because it had "no supported custom renderer". That reason no longer holds, and the fit is better than expected.
  - (c) is still reasonable if the owner prefers Preact for §6: the editor already ships it, and its runtime is far smaller. This spike didn't measure Preact.

## What an ADR would need to decide

1. **0077 §6:** Svelte, Preact, or both for the dynamic layer. Update 0077's Svelte alternative, whose stated reason is now false.
2. **Amend 0417:** a document's hosted trees are the second sanctioned creator of UI components. Public API shape (`ui.host(element)` and/or `ui.render`), and what plugins may call.
3. **Engine surface for the plugin** (the table in §1):
   - creating, attributing, moving and removing hosted elements;
   - `addStylesheet`;
   - a mutable id;
   - editor registration with source locations;
   - remounting after a rebuild;
   - a plugin system ordered before `engine.UIDocumentSync` for `flushSync`.
4. **Dependency:** `svelte` pinned exactly (5.59.2). Policy for an experimental API: upgrade checks, and what happens if `customRenderer` changes or goes away. The `svelte-custom-renderer` resolve condition in Vite, Vitest and export.
5. **Authoring rules:**
   - lowercase tag names;
   - attributes as `.ui.xml` attributes;
   - text whitespace collapsed as markup;
   - `style=` at attribute level (and whether markup gets it too);
   - the event name mapping, and handlers receiving `UIEvent`;
   - `runes: true` enforced.
6. **CSS:** §3 option A, B or both. Hash stability (compile filename), and whether `:where` gets real support.
7. **Editor:**
   - hosted elements pickable and inspectable read-only, with jump-to-source from dev locations;
   - whether literal attributes in `.svelte` are patched in place (spans from `parse()`) or refused;
   - loading the compiler lazily in a worker;
   - component hot reload.
8. **Size gate:** the runtime as a lazy chunk loaded only by games that use the plugin, with its own tripwire.
9. **Unsupported features:** `bind:`, transitions, `svelte:window` and `@html` documented as unsupported, with the workarounds above. A future UI animation record decides whether transitions come back as a plugin attachment API.

## Not verified

- A browser run: Babylon actually drawing hosted elements. Only the ECS nodes and fields were checked, but they are the same component types documents make.
- WebKit.
- The editor: picking, hierarchy, Inspector, file patching end to end, HMR.
- InputField typing through the real UI core (handlers were called directly).
- Dev-mode runtime size and speed.
- Performance on the low-end floor device. A production host with O(1) sibling placement.
- Preact's size and fit, for comparison.
- Whether `customRenderer` is stable across Svelte minor versions.
