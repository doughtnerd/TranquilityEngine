# Svelte conformance triage (ADR 0419)

ADR 0419: "every failure is either fixed or listed as out of scope with the reason". This file classifies every
runtime-runes fixture of Svelte 5.59.2 that doesn't pass against the engine's renderer. The out-of-scope ones are
also listed, with their reasons, in `baseline.json`'s `outOfScope`, which the harness reads to report the in-scope
pass rate. Out-of-scope samples still run: one that starts passing is named in the run's summary.

Run it: `npm run test:svelte-conformance` (`SVELTE_CONFORMANCE_CACHE=<dir>` keeps a run's fixtures and compiled output
apart from another's; `FILTER=<regex> DEBUG=1` shows each failure, `DEBUG=stack` with its stack). `UPDATE_BASELINE=1`
rewrites `baseline.json`, keeping `outOfScope`.

## Counts (2026-11-26)

| | Before the triage | After the triage | After the patch round (class c) |
|---|---|---|---|
| Pass | 1130 | 1210 | 1241 |
| Fail | 181 | 99 | 68 |
| Skip | 53 | 55 (two `skip_async` fixtures, which Svelte's async-mode run skips too) | 55 |
| Pass rate over every sample run | 86.2% of 1311 | 92.4% of 1309 | 94.8% of 1309 |
| Out of scope (run, listed) | not listed | 28 | 29 |
| **Pass rate in scope** | not measured | **94.5% (1210 of 1281)** | **97.0% (1241 of 1280)** |

The 68 failures by class: **a** 39 engine or renderer gaps (open), **b** 12 harness or jsdom-only expectations,
**d** 17 out of scope per 0419. Class **c** (patch changes) is done: 29 of its 30 samples pass, and `if-transition-inert`
turned out to be a jsdom-only expectation (now class b). The patch round also fixed `svelte-meta-component` and
`svelte-meta-component-async` (class a). The 39 in scope (class a) still fail; the gate before wave D needs them fixed
or ruled out of scope by the owner.

What the triage changed:

- **Harness** (where it misrepresented behaviour; no faked passes): configs that read jsdom's global `window` and
  `document` get the page as a game has it (`pageGlobals.ts`: the renderer's `<svelte:window>`/`<svelte:document>`
  targets, queries answered by the mounted target); Svelte's `raf` helper (its jsdom `animate` patch dropped);
  `rootDir` as Svelte compiles (file names in dev warnings and `__svelte_meta`); `console.log` returning undefined
  (`{console.log(x)}` rendered "1"); `console.group` labels as logs; a listener's exception reported as jsdom
  reports it (an `error` event on the window, uncaught unless stopped) rather than lost; a fresh page per sample
  (title, `$props.id()` counter, a config's window listeners); `skip_async` skipped; the page's global `name`;
  `svelte/reactivity` resolved to the engine's, as games get it, with `matchMedia` spied on as Svelte's harness mocks
  it; class lists compared as token sets and inline styles as declarations.
- **Harness (patch round)**: `inert` is left out of HTML comparisons on both sides (Svelte's outros set
  `element.inert`, which a browser reflects and jsdom, lacking `inert`, keeps as an expando, so the fixtures never show
  it); `svelte/motion`'s own `svelte/reactivity` import resolves to the engine's.
- **UI core**: a click toggles a checkbox or radio *before* its handlers, HTML's order (0424 as built toggled after),
  and back if one prevents it; `click()` from a script runs the activation through the UI core (`UIHostElement.click`),
  with its `input`, `change` and `submit` at once.
- **Renderer nodes**: `click()` through that activation; `namespaceURI`; reflected `hidden`, `inert`, `disabled`,
  `open`, `draggable`, `translate`, `type`, `name`, `title`, `lang`, `dir`, `tabIndex`, `id`; `stepUp`/`stepDown`;
  `getElementsByTagName`/`getElementsByClassName`; `selectedOptions` and an iterable `<select>`; `srcObject` as a
  property; booleans written as HTML's boolean attributes only where the element has one (`data-x={true}` is "true",
  `translate={false}` is "no"); a DOM `Event` a script dispatches gets `target` and `currentTarget`; an `<input>`
  keeps its value when its type changes; `bind:open` on `<details>`/`<dialog>`; number coercion read at each change.

## Every sample that doesn't pass

### a: engine or renderer gap (in scope, open): 39

| Samples | Reason / status |
|---|---|
| `accessors-props`, `bind-this-component-in-state`, `bind-this-component-in-state-dev` | engine: `UIView` doesn't expose the root component's exports (`mount`'s return); needs an API decision (a `UIView.exports`-style member is a public API change) |
| `async-abort-signal-fork-global-run-unheld`, `async-branch-reintro`, `async-derived-assign-fork-write-after`, `async-eager-real-world-keeps-record`, `async-fork-discard-settled-result`, `async-fork-each-item-adopted-variants`, `async-fork-no-rerun`, `async-merge-discard-after-error`, `async-resume-script-first-value-skipped`, `async-slot`, `derived-unowned-10`, `inspect-trace-reassignment` | open: Svelte's async/fork batching gives extra or missing effect runs under the engine's renderer; not yet traced (Svelte runtime under `custom_renderers_flag`, or the host's flush order) |
| `async-binding-update-while-focused-2` | engine: a focused field's bound value isn't rewritten while focused the way Svelte's DOM binding does (it skips only while the input's own value matches); not yet traced |
| `async-binding-update-while-focused-3`, `async-select-dynamic-options-while-focused` | engine: a focused `<select>` whose options or bound value change doesn't choose as the DOM does; not yet traced |
| `async-error-boundary`, `async-error-boundary-2`, `async-error-boundary-3`, `error-boundary-26`, `error-boundary-27`, `error-boundary-reset-destroyed` | engine: `mount`'s `transformError` option can't be given through `UIView` (a framework hook, SvelteKit's handleError); needs an API decision |
| `bind-current-time-remove-listener` | engine: `bind:currentTime`'s listener keeps firing after its `<audio>` is removed; not yet traced |
| `bindings-form-reset` | engine: `form.reset()` from a script doesn't bring the bound values back (Svelte's bindings re-read after reset) |
| `bound-store-sub` | engine: writing `value` on a `type=number` field then dispatching `input` binds null instead of 10; not yet traced |
| `deferred-events-consistency` | engine: a button disabled by a handler in a microtask still runs `click()`'s listeners; not yet traced (likely the disabled state reaching the UI element a flush later) |
| `dynamic-component-transition`, `dynamic-if-component-transition` | harness or Svelte timing: the fade's first frame reads `opacity: 0.01` where Svelte's DOM run reads 0 (the animation stand-in's sampling, or Svelte's `raf` under Z3's timing hook); not yet traced |
| `dynamic-spread-and-attribute-directive` | engine: `class:` with a class attribute and a spread loses the directive's class; not yet traced |
| `event-spread-timing` | engine: `focus()` from an action during mount sends its `focus` event with the frame's events, not at once as the DOM does |
| `form-default-value`, `form-default-value-select`, `form-default-value-spread`, `select-default-value-preserve-selection` | engine: `defaultValue`/`defaultChecked`/`defaultSelected` (as attributes from Svelte) aren't the controls' reset defaults |
| `muted-without-bind-works` | engine: changing the `muted` attribute on `<audio>` sends no `volumechange` (the media element doesn't report attribute-driven changes) |
| `option-rich-content` | engine: an option holding elements (`<option><span>…</span> A</option>`) reads its label as the select's value instead of its `value`; not yet traced |
| `select-option-added` | engine: `select.value = …` then a `change`, then options added: `selectedOptions` is empty; not yet traced |

### c: needs a patch change: done (2026-11-26)

All 14 changes below are in `patches/svelte+5.59.2.patch` (`docs/architecture/svelte-patch.md`, "Event delegation" and
"Fixes to custom-renderer paths"), and their samples pass, but `if-transition-inert` (class b: once `inert` matched,
its remaining difference is jsdom's computed `opacity`). The `svelte/motion` item needed no patch change: the harness
now resolves `svelte/motion`'s `svelte/reactivity` import to the engine's, as the engine's builds do (Z3).

### b: harness or jsdom-only expectation (out of scope: listed in baseline.json): 12

| Samples | Reason / status |
|---|---|
| `inspect`, `inspect-console-trace`, `inspect-derived-2`, `inspect-fork-discarded`, `inspect-multiple`, `inspect-nested-state`, `inspect-new-property`, `inspect-recursive` | jsdom-only expectation: the logged stack frame names the DOM's class (`at HTMLButtonElement.click`); the values and the call site match |
| `if-transition-inert` | jsdom-only expectation: `fade` multiplies by `getComputedStyle(node).opacity`, which jsdom reports as "" (0), hence the expected `opacity: 0`; a browser, and the renderer's `measure`, report 1. (`inert`, the triage's reason, is now set through the renderer and compared as below.) |
| `select-default-value-single-observer` | tests Svelte's DOM implementation (counts `MutationObserver`s, which the DOM path uses for selects); a renderer has no observers |
| `style-update` | serialisation only: CSSOM drops the unknown declaration `other-key: 0`; the renderer keeps the style as written (no behaviour either way) |
| `svelte-meta-component-2` | reads the DOM's global `Element.prototype` |

### d: out of scope per ADR 0419 (listed in baseline.json): 17

| Samples | Reason / status |
|---|---|
| `async-custom-element-attribute`, `custom-element-attributes`, `custom-element-injected-styles`, `custom-element-slot-in-snippet`, `custom-element-spread-unregistered`, `element-is-attribute`, `svelte-meta-native-slot` | customElement compilation / the custom elements registry (out of scope, ADR 0419) |
| `effect-tracking-binding-set`, `event-attribute-delegation-8`, `event-cleanup-before-attachment`, `event-listener-moved-outside-container`, `svelte-meta-non-dev-component` | the component's own code uses the global `document`/`window` beyond the Element subset and the hooks (out of scope, ADR 0419) |
| `hmr-dynamic-component` | Svelte's `hmr` compile option (its Vite plugin's dev feature); the editor hot-reloads a view by remounting it (ADR 0419), and the config imports Svelte's own build output |
| `if-dependency-order-2`, `multiple-head` | reads `document.head`'s markup: a game has no page head; `<svelte:head>` keeps only `<title>` (the window title, which is right), as 0419 decided |
| `nested-script-tag` | `<script>` in markup executing (as `<script>` in `{@html}`: out of scope, ADR 0419) |
| `state-in-template` | `new FormData(form)`: a browser API over a DOM form, beyond the Element subset (out of scope, ADR 0419) |

### Skipped: 55

Not run, so in neither rate. The harness records why (`results.json`).

| Reason | Samples |
|---|---|
| the fixture's `mode` or `skip_mode` leaves out `client`: server rendering and hydration (out of scope, ADR 0419) (44) | `async-attach-hydration-mismatch`, `async-derived-prop-closure-hydration`, `async-each-item-duplication`, `async-error-boundary-5`, `async-error-in-script`, `async-hydrate-html-tag`, `async-hydration-attribute-unchanged`, `async-hydration-binding`, `async-hydration-pending-boundary-sequential-script-write`, `async-hydration-pending-boundary-state`, `async-hydration-query-refetch`, `async-if-else`, `async-if-hydration`, `async-no-pending-await-in-block`, `async-no-pending-throws-sync`, `async-ondestroy-ordering`, `async-push-element-dev`, `async-render-component-hydration`, `async-render-hydration`, `async-store-sub-teardown`, `attribute-boolean-case-insensitivity`, `await-html-hydration`, `class-directive-mutations`, `derived-fn-destructure`, `derived-update-server`, `dynamic-element-svg`, `error-boundary-hydrate-1`, `error-boundary-hydrate-2`, `error-boundary-hydrate-skip`, `event-global-hydration-error-cleanup`, `form-default-checked-radio-spread`, `form-default-value-from-spread`, `head-payload-validation`, `hydratable-error-on-missing`, `hydratable-script-escape`, `hydratable-unused-keys`, `hydratable-unused-keys-nesting-partial`, `hydrate-modified-input`, `hydrate-modified-input-group`, `hydrate-modified-input-numeric`, `hydration-custom-element-error-boundary`, `invalid-html-ssr`, `invalid-html-ssr-ancestor`, `style-directive-mutations` |
| `skip: true` in the fixture (Svelte doesn't run it either) (9) | `async-abort-signal-after-await`, `async-abort-signal-after-await-fork`, `async-each-const-await-error-boundary`, `async-each-item-kept-offscreen-live`, `async-if-branch-kept-offscreen-live`, `deferred-events-consistency-2`, `effect-teardown-paused-old-value`, `error-boundary-18`, `tick-timing` |
| `skip_async: true`: Svelte's default run is async mode, as the harness's is (2) | `const-tag-boundary-deprecated-usage`, `untrack-own-deriveds` |

## Patch changes (class c, done)

As written up for the patch's holder; each is now in `patches/svelte+5.59.2.patch`, with what was built where it differs. Paths are in `node_modules/svelte/src/internal/client/`. Each change
is optional for renderers that lack the hook, like the rest of the patch (`docs/architecture/svelte-patch.md`).

1. **Namespaces** (`dynamic-element-dynamic-namespace`): `dom/operations.js` `create_element` returns
   `current_renderer.createElement(tag)`, dropping `namespace`. Pass it:
   `current_renderer.createElement(tag, namespace ?? NAMESPACE_HTML)`, and type the renderer's
   `createElement(name: string, namespace?: string)`. The engine's renderer already keeps a second argument as the
   node's `namespaceURI`; without one it works the namespace out from where the node is (right except for an explicit
   HTML element inside an `<svg>`, which this fixture is).
2. **`inert` during outros** (`if-nested-template`, `if-transition-inert`): `dom/elements/transitions.js` guards
   `element.inert` with `renderer === null` (lines ~272, 304, 345). Drop the guards: renderer nodes now reflect
   `inert` (read and written as the attribute). (Making the UI core treat `inert` as not interactable is an engine
   follow-up.)
3. **Handler names in dev warnings** (`event-handler-invalid-warning`, `-invalid-values`,
   `-component-invalid-warning`): `dom/elements/events.js` `apply()` computes
   `args[0]?.eventPhase < Event.BUBBLING_PHASE ? 'capture' : ''`. Under a renderer nothing is delegated, so a listener
   runs at the target (phase 2) and is named `clickcapture`. Use `args[0]?.eventPhase === 1 ? 'capture' : ''` (which
   also stops reading the global `Event`).
   *Built:* `apply()` is unchanged: with item 13, delegated handlers run from the root listener in the bubbling phase, as on the DOM, so the warning names `click`.
4. **Snippet anchor check** (`snippet-invalid-call`): `dev/validation.js` `validate_snippet_args` skips the anchor
   check under a renderer (`!current_renderer && …`). Under a renderer refuse `typeof anchor !== 'object' || anchor === null`
   (the renderer's nodes aren't `Node`s); today the call reaches the renderer with `undefined` and crashes there.
5. **`invalid_default_snippet` vs. `snippet_renderer_mismatch`** (`snippet-slot-let-error`,
   `snippet-slot-let-renamed-children-error`): `dom/blocks/snippet.js` `validate_snippet_renderer` throws
   `snippet_renderer_mismatch` for the compiler's `$.invalid_default_snippet` stand-in (it has no `__renderer`), before
   the stand-in can throw its own dev error. Exempt it (mark it with `__renderer` or test for it).
6. **Snippet stringification** (`snippet-block-without-render-tag-dev`, `snippet-children-without-render-tag-dev`):
   `shared/validate.js` `prevent_snippet_stringification` puts a throwing `toString` on the snippet; the function the
   renderer path renders (tagged with `__renderer`) doesn't carry it, so `{snippet}` renders text instead of throwing
   `snippet_without_render_tag`. Copy the `toString` onto the tagged function (or tag the original).
7. **`createRawSnippet`** (`snippet-raw*`, `svelte-meta-raw-snippet*`, `create-raw-snippet-invalid-render`): refused
   under a renderer (`invalid_snippet_in_custom_renderer`; a raw snippet also has no `__renderer`, so
   `snippet_renderer_mismatch`). It can be supported through the `html` hook: `current_renderer.html(anchor, render())`
   gives the nodes, `setup(element)` gets the single element, and the snippet is tagged with the renderer.
   *Built:* as written; the engine's inline HTML parser now keeps comments as comment nodes (as `innerHTML` does), so `create-raw-snippet-invalid-render`'s leading comment warns; `compileSvelteUI` (and rune modules) import the parser for `createRawSnippet` too.
8. **`{@html}` dev locations** (`svelte-meta-html-snippet`, `svelte-meta-html-update`): the DOM path of
   `dom/blocks/html.js` sets `__svelte_meta` (component and `loc`) on the top-level nodes it inserts; the `html` hook
   path doesn't. Set it on the nodes the hook returns, in dev.
9. **Option values** (`select-falsy-value`): `dom/elements/attributes.js` `set_value` returns early when the first
   value is nullish (`attributes.value === (attributes.value = value ?? undefined)`), so under a renderer
   `<option value={undefined}>` writes nothing, where the DOM path writes `value=""`. For an `OPTION` under a renderer,
   write `value ?? ''` on the first call (the spread path, `set_attributes`, likewise). The engine's renderer already
   turns a nullish option value into "" when it is called.
   *Built:* in the compiler instead: under a renderer `<option value={x}>` compiles to `$.set_value(option, x ?? '')`, and spreads pass `attribute_effect` the tag (a renderer's node has no `nodeName` for Svelte to read).
10. **`<select multiple>` warning** (`select-multiple-invalid-value`): `w.select_multiple_invalid_value()` is in the DOM
    binding (`dom/elements/bindings/select.js`); `bind_renderer` should warn the same for a non-array value bound to a
    `<select multiple>` before calling the renderer's `bind`.
    *Built:* the sample is `<select multiple value={...}>`, an attribute, not a binding: the compiler passes `set_value` an `is_select` flag under a renderer, and it warns (and keeps the selection) for a non-array value when the renderer's node has `multiple`.
11. **Dev array warnings** (`state-proxy-equality-mismatch`): `init_array_prototype_warnings()` is installed by the DOM
    operations' `init_operations` (`dom/operations.js`), which a renderer mount never reaches. Call it (in dev) when a
    renderer mounts too.
12. **`mount()` inside a component** (`manual-mount`, `mount-intro-transition`, `mount-unmount-anchor`): a component
    calling `mount(Child, { target: someNode })` without a `renderer` option takes the DOM path (and needs
    `document`). Default the option to the active renderer (`current_renderer`) when a renderer is rendering.
    *Built:* handlers (direct and delegated) also run with their renderer current, since the samples mount from click handlers, where no renderer was current; `mount()` then defaults to it (unless the target is a DOM `Node`).
13. **Root delegation order** (`event-attribute-delegation-5`, `event-on-stop-propagation`): on the DOM, `onclick`
    attributes are delegated and run as the event reaches the root, after direct `on:click` listeners along the path;
    under a renderer both are direct listeners, so registration order decides. Pass the renderer a `delegated` flag
    (`addEventListener(el, type, fn, { delegated: true })`) so it can run those in a root phase after bubbling.
    *Built:* no renderer flag: Svelte's own delegation runs under a renderer (the analyzer delegates, `mount` listens on the target through the renderer, the path is the target's ancestors by `getParent`, and `create_event` runs the delegated handlers below its node first), because `on:`/`on()` interleave with delegated handlers in a way a root phase alone can't give (`event-attribute-delegation-5`). The renderer's `dispatchEvent` now clears a script event's stop flags when done, as the DOM's dispatch does.
14. **`svelte/motion` at import** (`side-effect-derived-spring`, `side-effect-derived-tween`; Z3's area): `motion/index.js`
    builds `prefersReducedMotion` with Svelte's own `MediaQuery` on the global `window` when it's imported, which
    throws headless and reads the page, not the canvas, in a game. It should ask the renderer's window target, as the
    engine's `svelte/reactivity` does (`src/plugins/ui/svelte/reactivity.ts`).
    *Built:* no patch change: Z3 already resolves it in the engine's builds (`vite.shared.ts`, the UI bundle); the harness didn't, and now does.

## How out-of-scope is decided

- **d**: ADR 0419's list: server rendering and hydration, `customElement` compilation, `<script>` in markup, and
  components whose own code uses the global `document`/`window` beyond the Element subset and the hooks (also
  browser APIs over DOM nodes, such as `FormData`). A game has no page head either: `<svelte:head>` keeps `<title>`.
- **b**: expectations only jsdom can meet without faking: a DOM class name in a stack trace, the DOM's global classes,
  a count of the DOM path's `MutationObserver`s, CSSOM dropping a declaration it doesn't know (no behaviour).
- Everything else is in scope: fixed, or open in class a above.
