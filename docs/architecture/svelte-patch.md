# Our Svelte patch: renderer hooks for what a custom renderer refuses

`patches/svelte+5.59.2.patch` (applied by `patch-package` on `npm install`, as `patches/@babylonjs+core+9.32.0.patch` is) changes Svelte 5.59.2 so that features the compiler refuses under a custom renderer work through optional renderer hooks ([ADR 0419](../decisions/0419-game-ui-is-authored-in-svelte-rendered-onto-the-ui-core.md), "Compatibility target"). This page is the write-up for the upstream issues and pull requests: each hook below is its own change, offered upstream on its own. If Svelte ships an equivalent, we delete ours and follow theirs.

| Hook | What it makes work | Section |
|---|---|---|
| `bind(node, name, get, set)` | element `bind:`, and bindings on `<svelte:window>`/`<svelte:document>` | [Element bindings](#element-bindings-bind) |
| `globalTarget(kind)` | `<svelte:window>`, `<svelte:document>`, `<svelte:body>` (events, bindings, actions), `<svelte:head>` and its `<title>` | [Global targets](#global-targets-globaltarget) |
| `addStyles(hash, code)` | `css: 'injected'` | [Injected styles](#injected-styles-addstyles) |
| `animate(node, keyframes, options)`, `measure(node)` | `transition:`, `in:`, `out:`, `animate:`, `svelte/transition`, `svelte/animate` | [Transitions and animations](#transitions-and-animations-animate-measure) |
| none (the existing `addEventListener`) | legacy `on:` | [Legacy `on:`](#legacy-on) |
| `html(anchor, value)` | `{@html}` | [Inline HTML](#inline-html-html) |
| `requestAnimationFrame(callback)`, `now()` | `svelte/motion` (`Tween`, `Spring`, `tweened`, `spring`), `tick` transitions and Svelte's frame loop on the renderer's frames and clock | [Frames and clock](#frames-and-clock-requestanimationframe-now) |

Every hook is optional, and a renderer without one behaves as before except where noted. The compiler only has the renderer's module path, never the renderer object, so it can't refuse at compile time when a hook is missing: the runtime throws a clear error (`renderer_*_unsupported`) when the feature is first used. Upstream, each error message would also go into `messages/client-errors/` so `errors.js` is generated as usual.

## Element bindings (`bind`)

### The problem

With `compilerOptions.experimental.customRenderer` set, the analyzer refuses every `bind:` on an element (`incompatible_with_custom_renderer`, from `phases/2-analyze/visitors/BindDirective.js`), even for HTML tag names: `<input bind:value>` compiles in DOM mode and is refused with a custom renderer. The reason is that the client binding helpers (`internal/client/dom/elements/bindings/`) are DOM code: they read `node.value`, listen for `input` events, use `ResizeObserver` and so on. A custom renderer's nodes are not DOM nodes, so those helpers can't work, and the compiler can't know what a renderer's nodes can do.

Bindings on components (`<Child bind:value>`) aren't affected: they're props.

### The change

1. **An optional renderer hook.** The `Renderer` interface (`svelte/renderer`, `types/index.d.ts`) gains:

   ```ts
   bind?(node: N['element'], name: string, get: () => any, set: (value: any) => void): (() => void) | void;
   ```

   The renderer pushes the bound value to the node by reading `get()`, reports changes from the node by calling `set(value)`, and returns a cleanup. Like an attachment, the hook runs inside a render effect: when state read through `get()` changes, the cleanup runs and the hook runs again.

2. **The analyzer allows bindings under a custom renderer** (`phases/2-analyze/visitors/BindDirective.js`): on elements, and on `<svelte:window>`, `<svelte:document>` and `<svelte:body>`, whose node is the renderer's global target (next section). The usual validation (which names apply to which tags) still runs.

3. **The client transform emits the hook.** `phases/3-transform/client/visitors/BindDirective.js`: under a custom renderer, a binding other than `bind:this` compiles to

   ```js
   $.bind_renderer(node, "value", get, set);
   $.bind_renderer($.global_target("window"), "innerWidth", get, set);
   ```

   instead of `$.bind_value(...)`, `$.bind_property(...)`, `$.bind_window_size(...)` and the other DOM helpers. DOM output is unchanged.

4. **`bind:this` is unchanged** and keeps compiling to `$.bind_this`, so it gives the renderer's node.

5. **The runtime helper.** `internal/client/custom-renderer/bind.js` exports `bind_renderer(node, name, get, set)` (re-exported from `internal/client/index.js`). It looks up the current renderer and runs `renderer.bind(node, name, get, set)` in a `render_effect`.

6. **Without `bind`**, `bind_renderer` throws `renderer_bind_unsupported` (`` `bind:value` needs the custom renderer to define `bind` ``) when the binding is created.

## Global targets (`globalTarget`)

### The problem

`<svelte:window>`, `<svelte:document>`, `<svelte:body>` and `<svelte:head>` are refused under a custom renderer (`phases/2-analyze/visitors/Svelte{Window,Document,Body,Head}.js`). The client output names the DOM's objects directly (`$.window`, `$.document`, `$.document.body`, `document.head`, `$.document.title = …`), which a custom renderer's host may not have (a canvas game, a terminal, a native view), and whose events and sizes may not be what the renderer's world calls a window.

### The change

1. **An optional renderer hook:**

   ```ts
   globalTarget?(kind: 'window' | 'document' | 'body' | 'head'): any;
   ```

   It returns the object that stands for the window, the document or the body, and the element `<svelte:head>` content is inserted into. A renderer returns the same object for a kind every time.

2. **The analyzer stops refusing** the four special elements under a custom renderer.

3. **The client transform** (`visitors/shared/special_element.js`, used by the three visitors) makes the node of `<svelte:window>`, `<svelte:document>` and `<svelte:body>` `$.global_target('window' | 'document' | 'body')` under a custom renderer instead of `$.window`, `$.document` and `$.document.body`. So, with no other change:
   - event attributes and `on:` compile to `$.event(type, $.global_target(kind), handler, …)`, which goes through the renderer's `addEventListener`;
   - bindings compile to `$.bind_renderer($.global_target(kind), name, get, set)` (the `bind` hook above);
   - actions and attachments receive the target.

   `visitors/TitleElement.js`: a `<title>` in `<svelte:head>` assigns `$.global_target('document').title` instead of `$.document.title`.

4. **The runtime.** `internal/client/custom-renderer/global.js` exports `global_target(kind)` (re-exported from `internal/client/index.js`): it calls the current renderer's `globalTarget(kind)` and remembers the object.
   - `dom/elements/events.js`, `event()`: the DOM runtime removes listeners added to `window`, `document`, `document.body` and media elements when their component is destroyed, because those outlive it. Under a custom renderer it does the same for the renderer's global targets (and nothing else, as before).
   - `dom/blocks/svelte-head.js`, `head()`: under a custom renderer, head content is inserted into `global_target('head')` instead of `document.head`, through the renderer's `insert` as usual.

5. **Without `globalTarget`**, `global_target` throws `renderer_global_target_unsupported` (`` `<svelte:window>` needs the custom renderer to define `globalTarget` ``) when the component is created.

## Injected styles (`addStyles`)

### The problem

Under a custom renderer, `<svelte:options css="injected" />` is refused and the `css: 'injected'` compiler option is ignored (`phases/2-analyze/index.js`), because injected styles are `<style>` elements added to the document (`internal/client/dom/css.js`, `append_styles`), and a custom renderer's nodes aren't in a document. A renderer that styles its nodes from CSS (a canvas UI with its own cascade) has no way to receive a component's CSS at runtime.

### The change

1. **An optional renderer hook:**

   ```ts
   addStyles?(hash: string, code: string): void;
   ```

   `hash` is the component's scoping class and `code` its scoped CSS, as `css: 'external'` would return it. It's called each time such a component is created; the same `hash` always comes with the same `code`.

2. **The analyzer** injects styles under a custom renderer as it does for the DOM: `<svelte:options css="injected" />` is allowed, and `css: 'injected'` (the option) is honoured instead of ignored. **Behaviour change:** a custom-renderer component compiled with `css: 'injected'` by a tool's default (vite-plugin-svelte without `emitCss`) now calls `addStyles`, and throws if the renderer has none, where its CSS used to be returned as with `css: 'external'`.

3. **The runtime.** `append_styles(anchor, css)` (`dom/css.js`): under a custom renderer, it calls `renderer.addStyles(css.hash, css.code)` instead of adding a `<style>` element.

4. **Without `addStyles`**, `append_styles` throws `renderer_add_styles_unsupported` (`` `css: 'injected'` needs the custom renderer to define `addStyles` ``) when the component is created.

## Legacy `on:`

### The problem

`on:` directives (Svelte 4 syntax, still supported in Svelte 5) are refused under a custom renderer (`phases/2-analyze/visitors/OnDirective.js`), so Svelte 4 components and libraries can't be used with one.

### The change

The analyzer stops refusing them. Their client output was already renderer-neutral: `$.event(type, node, handler, capture, passive)`, which goes through the renderer's `addEventListener(node, type, handler, { capture, passive })`, with the modifiers as Svelte's wrappers (`$.once`, `$.preventDefault`, `$.stopPropagation`, `$.stopImmediatePropagation`, `$.self`, `$.trusted`, which only call the event's own methods), and `on:click` without a handler forwarding to the component's own listeners. No hook is needed. The runes-mode deprecation warning and the rule against mixing `on:` and event attributes in one component are unchanged.

## Transitions and animations (`animate`, `measure`)

### The problem

`transition:`, `in:`, `out:` and `animate:` are refused under a custom renderer (`phases/2-analyze/visitors/TransitionDirective.js`, `AnimateDirective.js`). Their compiled output is already renderer-neutral (`$.transition(flags, node, fn, params)`, `$.animation(node, fn, params)`), but the runtime (`internal/client/dom/elements/transitions.js`) is DOM code:

- it plays keyframes with `element.animate(keyframes, { duration, fill: 'forwards' })` (Web Animations) and reads the handle's `currentTime`, `onfinish` and `cancel()`;
- `tick` transitions run on `requestAnimationFrame` (`loop`), which a custom renderer's world may not have, or not in step with its frames;
- `animate:` measures with `getBoundingClientRect()`, `getComputedStyle()` and `getAnimations()`, and its `fix()` takes a leaving item out of flow by writing `element.style`;
- it sets `element.inert`, and `element.style.overflow` for a Safari bug;
- and `svelte/transition` (`fade`, `fly`, `slide`, `scale`, `blur`, `draw`, `crossfade`) and `svelte/animate` (`flip`) read geometry with the global `getComputedStyle(node)`, `node.getBoundingClientRect()` and `node.clientWidth`.

A custom renderer's nodes are not DOM elements, so none of that works on them.

### The change

1. **Two optional renderer hooks:**

   ```ts
   animate?(node: N['element'], keyframes: Array<Record<string, string>>, options: { duration: number; fill: 'forwards' }): RendererAnimation;
   measure?(node: N['element']): RendererMeasurement;

   interface RendererAnimation {
   	readonly currentTime: number | null; // ms since it started; null once cancelled
   	onfinish: (() => void) | null;       // called once at its end, after the call that created it returned
   	onframe?: (() => void) | null;       // set by Svelte for `tick` transitions: called on each of the renderer's frames while it runs
   	cancel(): void;                      // stops it and removes its values
   }

   interface RendererMeasurement {
   	left: number; top: number; right: number; bottom: number; width: number; height: number; // the box after transforms
   	clientWidth: number; clientHeight: number; // the untransformed inner size
   	style: Record<string, string>;             // computed values by camel-case name
   }
   ```

   `animate` takes what `element.animate` takes from Svelte: keyframes whose values are CSS text by camel-case property (`css_to_keyframe` of the transition's `css(t, u)`, sampled per 60 Hz frame with the easing applied), evenly spaced over `duration` ms (none for a pure delay), the last one held until `cancel()`. `measure` gives what the DOM's `getBoundingClientRect()`, `clientWidth`/`clientHeight` and `getComputedStyle()` give, up to date with changes made before the call (as reading layout is in the DOM: `animate:` measures right after the each block moved its items).

2. **The analyzer stops refusing** the four directives under a custom renderer.

3. **The runtime** (`dom/elements/transitions.js`), with the renderer captured when the transition or animation is created (`current_renderer`), since the work happens later, in microtasks and in the renderer's frame callbacks:
   - `element.animate(...)` goes through `animate_element(renderer, ...)`: the DOM call, or `renderer_animate` (`internal/client/custom-renderer/animate.js`), which calls the hook and keeps the handle in a per-node set until it's cancelled (what `getAnimations()` reports in the DOM);
   - a `tick` transition sets the handle's `onframe` instead of starting a `loop` (unless the renderer supplies Svelte's frames, `requestAnimationFrame` below: then it runs on `loop` as in the DOM);
   - the transition function runs with the renderer pushed as current (`with_renderer`), including a deferred one (`crossfade`'s), so `svelte/transition` measures through it;
   - `animate:` measures with `bounding_rect` and `computed_style` (`internal/client/custom-renderer/measure.js`: the DOM calls, or the current renderer's `measure`), tests `has_renderer_animations(node)` instead of `getAnimations()`, and its `fix()`/`unfix()` append `position: absolute; width; height; transform` to the `style` attribute through the renderer's `getAttribute`/`setAttribute` (custom renderers deal in attributes, as `set_style` does) and put it back after;
   - `inert`, the Safari overflow workaround and `animation.effect = null` stay DOM-only;
   - intro and outro events are dispatched only on nodes that have `dispatchEvent`.

   DOM behaviour is unchanged: with no renderer, every path is the one it was.

4. **`svelte/transition` and `svelte/animate`** call `computed_style(node)`, `bounding_rect(node)` and (`flip`) `client_size(node)` instead of `getComputedStyle`, `getBoundingClientRect` and `clientWidth`/`clientHeight`; under a custom renderer `flip` takes no zoom (the renderer's sizes are in its boxes' units).

5. **Without `animate`**, `$.transition` and `$.animation` throw `renderer_animate_unsupported` (`` `transition:` needs the custom renderer to define `animate` ``; `in:`, `out:`, `animate:` likewise) when they're created. **Without `measure`**, `$.animation` throws `renderer_measure_unsupported` when it's created, and a transition function that measures throws it when it runs.

Semantics stay Svelte's: intros on mount (`mount`'s `intro`), local transitions playing only when their own block changes and `|global` with any, outros delaying removal (and the each block's outro groups), bidirectional `transition:` reversing from its current `t` (`currentTime`), delays as a keyframe-holding animation the length of the delay, `introstart`/`introend`/`outrostart`/`outroend`.

## Inline HTML (`html`)

### The problem

`{@html value}` is refused under a custom renderer (`phases/2-analyze/visitors/HtmlTag.js`). Its runtime (`internal/client/dom/blocks/html.js`) parses the string as HTML through the DOM (`innerHTML` on a `<template>`, `<svg>` or `<math>` wrapper, or on the element itself when the tag is its only content), which a custom renderer's nodes don't have, and what the string should become (an HTML subset, markdown, nothing) is the renderer's to say.

### The change

1. **An optional renderer hook:**

   ```ts
   html?(anchor: N['element'] | N['comment'], value: string): N['fragment'];
   ```

   It returns the string's nodes in a fragment, not yet inserted. `anchor` is where they'll go: the comment they're inserted before, or the element whose only content they are (`{@html}` as an element's only child, `is_controlled`, which is also how `contenteditable` content is written).

2. **The analyzer stops refusing** `{@html}` under a custom renderer. The client output is unchanged (`$.html(node, () => value, …)`).

3. **The runtime.** `html()` (`dom/blocks/html.js`): under a custom renderer, when the value changes, `renderer_html` (`internal/client/custom-renderer/html.js`) removes the nodes the tag showed (for an element's only content, everything the element holds, as `innerHTML` does), asks the hook for the new ones, records them as the effect's nodes and inserts them before the anchor (or into the element). An empty string shows nothing. The DOM path and hydration are unchanged.

4. **Without `html`**, the tag throws `renderer_html_unsupported` (`` `{@html ...}` needs the custom renderer to define `html` ``) when it first renders.

## Frames and clock (`requestAnimationFrame`, `now`)

### The problem

Svelte's frame loop is a module-level object, `raf` (`internal/client/timing.js`): `raf.tick` is the browser's `requestAnimationFrame` (a no-op outside a browser) and `raf.now` is `performance.now()`. `loop()` (`internal/client/loop.js`) runs its tasks on it, and `svelte/motion` (`Tween`, `Spring`, `tweened`, `spring`) and `tick` transitions run on `loop`. A custom renderer's world may have frames of its own (a game engine's, stepped headless in tests), a clock of its own (a paused game's UI on unscaled time), and no `requestAnimationFrame` at all; values a frame computes should show in that frame. Before this change the `animate` hook's handle had an `onframe` property for `tick` transitions (ours, still kept for renderers without this hook), and nothing reached `svelte/motion`.

### The change

1. **Two optional renderer hooks:**

   ```ts
   requestAnimationFrame?(callback: (time: number) => void): void; // once, on the renderer's next frame, before it shows
   now?(): number;                                                // ms, never decreasing, the current frame's time
   ```

2. **The runtime.** `timing.js` keeps a stack of timing sources (`use_renderer_timing(renderer)` → release). `raf.tick` calls the latest source's `requestAnimationFrame` and `raf.now` its `now`, falling back to the browser's as before. `mount(component, { renderer })` (`render.js`, `_mount`) pushes the renderer when it has either hook and releases it after the component is unmounted (after its outros: the release waits for the promise `unmount` returns). Code that assigns `raf.tick`/`raf.now` itself (Svelte's tests) still wins, since it replaces the functions.

3. **`tick` transitions** (`dom/elements/transitions.js`) run on `loop`, as in the DOM, under a renderer with `requestAnimationFrame` (reading the handle's `currentTime` and `playState`); under one without it, they keep using the handle's `onframe`.

4. **No error without the hooks:** Svelte's own frames are used, as before.

Open points: the source is global while Svelte's `raf` is (two renderers with their own frames mounted at once share the latest one's); a value created before the first mount reads the browser's clock until then.

## What the engine's renderer does with it

`src/plugins/ui/svelte/renderer.ts` and `globalTargets.ts`:

- **`bind`**: `bind:value` on `input` (from the UI core's input and change events, ADR 0309). ADR 0425: `bind:textContent`, `bind:innerText` and `bind:innerHTML` on a `contenteditable` text element (written when the bound value differs, read back on each `input`; the renderer brings its nodes up to date with the player's edit first). On the window: `innerWidth`/`innerHeight` (and `outerWidth`/`outerHeight`, the same) are the drawing canvas's size in CSS pixels, `devicePixelRatio`, `online`, and `scrollX`/`scrollY` (always 0). On the document: `activeElement` (the node with the UI's focus, ADR 0340, else the body), `visibilityState`, `fullscreenElement`/`pointerLockElement` (null). They're read-only and follow changes each frame. Other names warn once and do nothing yet (`bind:checked`/`bind:value` on toggles and sliders come with those elements; size bindings on elements with `measure`).
- **`globalTarget`**: three targets fed once a frame from the engine's device snapshot after UI routing (so keys while a text field types, and keys and buttons the UI claimed, never reach them): `keydown`/`keyup` (DOM `key`/`code` and modifier flags), `pointerdown`/`pointerup`/`mousedown`/`mouseup` for buttons pressed outside UI, `pointermove`/`mousemove`, `wheel`, delivered body → document → window until a handler stops it; `resize` and `online`/`offline` on the window; `visibilitychange` on the document. `document.title` (from `<title>`) sets the page's title, which is the window's title in a desktop build. Other `<svelte:head>` content is kept off the UI and warned about once.
- **`addStyles`**: the cascade's rule data. Games ship no CSS parser, so the engine's compile step (`compileSvelteUI`) parses an injected component's CSS when it compiles and the module registers it by hash (`injectStyles`); `addStyles` then adds it to every view, as `:global` rules and imported `.css` are.
- **`animate`** (`animation.ts`): the hosted element's `UIHostElement.animate`, which converts each keyframe's CSS with the cascade's value conversion (`keyframeValues`: shorthands such as `transform`, `padding`, `border-width` expand; variables substitute) into per-field keyframe tracks and plays them on the UI animator (`UIAnimator.play`, ADR 0418 wave 4): per-segment tweens on the tween backend (both backends hold 256 sequences but 4,096 tweens), on unscaled time, the first keyframe shown the frame it's called (one started in an animation's end hook, after a delay, starts in that frame), linear between keyframes (Svelte samples its easing into them), stretches of equal values merged into one segment, the last values held until `cancel()`, kept across restyles and drawn over stylesheet animations, no CSS animation events. `onframe` and `onfinish` run after the frame's values are written (`engine.UIAnimation`, late update). A node outside a mounted view finishes at once; nothing plays in a scene being edited. A property the element can't animate is warned about once per tag and left out: `filter` (`blur`) and SVG's `stroke-*` (`draw`) until ADR 0426, so `blur` fades and `draw` shows the element as it is (`getTotalLength()` is 0, with a warning).
- **`measure`** (`animation.ts`): the node's `getBoundingClientRect()` (the transformed box's bounds in canvas UI pixels), which first lays the UI out when a hosted tree changed since the last layout in that frame (`UIHostTree.layoutNow`: pending restyles, then `UILayoutSource.relayout`, the pointer-routing UI core's `sync` at its last size); `clientWidth`/`clientHeight` from the layout less borders; `UIHostElement.computedStyle()` by camel-case name with `getPropertyValue` (sizes, sides, `transform` as `translate() rotate() scale()` or `none`, `transform-origin` in px, `opacity`, `display`, `position`, `overflow`, colours as `rgba()`; `filter: none`, `zoom: 1`, `stroke-linecap: butt` for what isn't drawn yet; anything else "").
- **`html`** (ADR 0425): the inline HTML parser (`htmlInline.ts`, imported as `myco/ui-html`) reads the string into renderer nodes, which the renderer maps as it maps a template's tags: phrasing elements inside a text element become its inline runs, block elements panels. `<script>`, `<style>` and other code- or document-embedding elements (with their content), comments, event handler attributes, `srcdoc` and `javascript:`/`vbscript:`/`data:` URLs (but an image's `data:image/`) are dropped. The parser is a small tokenizer (entities, void elements, HTML's implied closes of `p`, `li`, `dt`/`dd`, `option`, `tr`/`td`), not `htmlparser2`; `compileSvelteUI` imports it (and registers it with the renderer, `useHtmlParser`) only into components that use `{@html}` or `bind:innerHTML`, so other games never load it. The same parser writes a node's `innerHTML` and `bind:innerHTML`.
- **`requestAnimationFrame`, `now`** (`timing.ts`): Svelte's clock is the active World's unscaled time in milliseconds, summed frame by frame so it never goes back when another World becomes active (the editor's Play), and the same throughout a frame. A callback runs once in the next frame of the active World in play, in the UI step right after the frame's UI events (`onUIHostFrame`, `engine.UIHostFrame`, before behaviors' update), so a tween's value written through `style:` or a `tick` transition's text or inline style shows in that frame, after the late UI sync restyles it; nothing runs in a scene being edited, and headless engines step it like any other (no `requestAnimationFrame`). The `animate` handle's `currentTime` is on the same clock (milliseconds since it started, up to its duration), which is what a playback started in a frame shows in the frames after it, so a `tick` transition and its keyframes agree. ADR 0427: Svelte's `prefersReducedMotion` is a canvas `MediaQuery` (the engine resolves `svelte/motion`'s own `svelte/reactivity` import to the canvas module), so it follows `UIPreferences.reducedMotion`.
- **Legacy `on:`**: elements keep listeners of any type (an action's custom event reaches `on:custom` through `dispatchEvent`); the UI's own events (`click`, `input`, `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`) happen by themselves. Without event propagation yet (a later record), `capture` changes nothing and `stopPropagation` stops the element's remaining listeners.

## Tests

- `src/plugins/ui/svelte/sveltePatch.test.ts`: each hook's compile output under a custom renderer (and DOM output unchanged); `bind` runs again after its cleanup when the bound state changes; `global_target`, `head` and `append_styles` call the hooks; listeners on a global target go with their component; each missing hook throws its clear error.
- `src/plugins/ui/runtime/uiView.test.ts`: `<input bind:value>` both ways through a `UIView`, and `bind:this` giving the renderer's node.
- `src/plugins/ui/runtime/uiViewGlobals.test.ts`: through a `UIView` and the engine's renderer: window size bindings and `resize` from the canvas, keys from the device snapshot through body, document and window, `document.activeElement` following the UI's focus, `<title>` setting the page's title, `css: 'injected'`, legacy `on:` with modifiers and its listeners going on unmount.
- `src/plugins/ui/svelte/sveltePatch.test.ts` also: the four directives compile under a custom renderer as for the DOM; missing `animate`/`measure` throw their errors; `fade`, `fly`, `flip` and `crossfade` measure through the renderer.
- `src/plugins/ui/runtime/uiViewTransitions.test.ts`: through a `UIView`, frame by frame: `fade` in and out with its events and removal after the outro, reversal midway, `in:fly` with `out:fade`, `scale`, `slide` (laid-out height and padding, clipped), a delay, a `tick` transition, unscaled time, `blur` and `draw` degrading with one warning, `animate:flip` on a reorder, `crossfade` between two lists, local versus `|global`, the `measure` hook on a transformed, padded, bordered box, and `svelte/motion` (`Tween`, `Spring`) through `style:`.
- The conformance harness (`npm run test:svelte-conformance`) runs Svelte's own runtime samples among the rest. Its stand-in for the `animate` hook (`tools/svelte-conformance/animationStandIn.ts`) is Svelte's own test helper moved from `element.animate` to the hook: keyframes written to the node's inline style on the test's clock, so transition samples read as against the DOM.

- `src/plugins/ui/svelte/sveltePatch.test.ts` also: a component mounted with a renderer that has `requestAnimationFrame` and `now` runs `svelte/motion` on that renderer's frames and clock, and unmounting gives Svelte its own back. `src/plugins/ui/runtime/uiViewTransitions.test.ts`: `Tween` and `Spring` through `style:` and a `tick` transition writing an inline style, each value shown in the frame it's computed, on engine frames only (unscaled).
- `src/plugins/ui/svelte/sveltePatch.test.ts` also: `{@html}` compiles under a custom renderer; the `html` hook's nodes go before the anchor and are replaced when the value changes, or become an element's whole content; a renderer without the hook fails clearly. `src/plugins/ui/svelte/htmlInline.test.ts`: the parser. `src/plugins/ui/runtime/uiViewRichText.test.ts`: `{@html}` through a `UIView` (runs, panels, dropped scripts and handlers) and `bind:innerHTML`.

## Upstream shape

Seven pull requests, one per section (`animate` and `measure` together: `animate:` needs both), each: the source changes above, its error message files, a `custom-renderer` test sample with a minimal renderer that has (and one that lacks) the hook, and the hook documented beside `addEventListener` in the renderer interface. `bind` and `globalTarget` share the window/document binding change; whichever lands second carries it. The transitions PR also moves Svelte's test `Animation` stand-in (`tests/animation-helpers.js`) behind a test renderer's `animate`, so the existing transition samples run under a custom renderer too. All are additive: renderers without the hooks behave as before, except that a refusal moves from compile time to the feature's first use, and (`addStyles`) an inherited `css: 'injected'` is honoured rather than ignored.

Open points for the transitions PR: the `onframe` property is ours (Web Animations has no per-frame callback); with the frames-and-clock PR, a renderer that supplies Svelte's frames doesn't need it, so the transitions PR could drop it if that one lands first; `measure`'s style is a plain record rather than a `CSSStyleDeclaration`; the keyframes stay pre-sampled CSS text, as for the DOM, though a renderer could do better with the `css` function and easing themselves.
