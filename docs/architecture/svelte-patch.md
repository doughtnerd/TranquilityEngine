# Our Svelte patch: renderer hooks for what a custom renderer refuses

`patches/svelte+5.59.2.patch` (applied by `patch-package` on `npm install`, as `patches/@babylonjs+core+9.32.0.patch` is) changes Svelte 5.59.2 so that features the compiler refuses under a custom renderer work through optional renderer hooks ([ADR 0419](../decisions/0419-game-ui-is-authored-in-svelte-rendered-onto-the-ui-core.md), "Compatibility target"). This page is the write-up for the upstream issues and pull requests: each hook below is its own change, offered upstream on its own. If Svelte ships an equivalent, we delete ours and follow theirs.

| Hook | What it makes work | Section |
|---|---|---|
| `bind(node, name, get, set)` | element `bind:`, and bindings on `<svelte:window>`/`<svelte:document>` | [Element bindings](#element-bindings-bind) |
| `globalTarget(kind)` | `<svelte:window>`, `<svelte:document>`, `<svelte:body>` (events, bindings, actions), `<svelte:head>` and its `<title>` | [Global targets](#global-targets-globaltarget) |
| `addStyles(hash, code)` | `css: 'injected'` | [Injected styles](#injected-styles-addstyles) |
| none (the existing `addEventListener`) | legacy `on:` | [Legacy `on:`](#legacy-on) |

Later hooks from 0419 (`animate`/`measure` for transitions and `animate:`, `html` for `{@html}`) go into the same patch file the same way. They aren't written yet.

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

## What the engine's renderer does with it

`src/plugins/ui/svelte/renderer.ts` and `globalTargets.ts`:

- **`bind`**: `bind:value` on `input` (from the UI core's input and change events, ADR 0309). On the window: `innerWidth`/`innerHeight` (and `outerWidth`/`outerHeight`, the same) are the drawing canvas's size in CSS pixels, `devicePixelRatio`, `online`, and `scrollX`/`scrollY` (always 0). On the document: `activeElement` (the node with the UI's focus, ADR 0340, else the body), `visibilityState`, `fullscreenElement`/`pointerLockElement` (null). They're read-only and follow changes each frame. Other names warn once and do nothing yet (`bind:checked`/`bind:value` on toggles and sliders come with those elements; size bindings on elements with `measure`).
- **`globalTarget`**: three targets fed once a frame from the engine's device snapshot after UI routing (so keys while a text field types, and keys and buttons the UI claimed, never reach them): `keydown`/`keyup` (DOM `key`/`code` and modifier flags), `pointerdown`/`pointerup`/`mousedown`/`mouseup` for buttons pressed outside UI, `pointermove`/`mousemove`, `wheel`, delivered body → document → window until a handler stops it; `resize` and `online`/`offline` on the window; `visibilitychange` on the document. `document.title` (from `<title>`) sets the page's title, which is the window's title in a desktop build. Other `<svelte:head>` content is kept off the UI and warned about once.
- **`addStyles`**: the cascade's rule data. Games ship no CSS parser, so the engine's compile step (`compileSvelteUI`) parses an injected component's CSS when it compiles and the module registers it by hash (`injectStyles`); `addStyles` then adds it to every view, as `:global` rules and imported `.css` are.
- **Legacy `on:`**: elements keep listeners of any type (an action's custom event reaches `on:custom` through `dispatchEvent`); the UI's own events (`click`, `input`, `change`, `submit`, `focus`, `blur`, `pointerenter`, `pointerleave`) happen by themselves. Without event propagation yet (a later record), `capture` changes nothing and `stopPropagation` stops the element's remaining listeners.

## Tests

- `src/plugins/ui/svelte/sveltePatch.test.ts`: each hook's compile output under a custom renderer (and DOM output unchanged); `bind` runs again after its cleanup when the bound state changes; `global_target`, `head` and `append_styles` call the hooks; listeners on a global target go with their component; each missing hook throws its clear error.
- `src/plugins/ui/runtime/uiView.test.ts`: `<input bind:value>` both ways through a `UIView`, and `bind:this` giving the renderer's node.
- `src/plugins/ui/runtime/uiViewGlobals.test.ts`: through a `UIView` and the engine's renderer: window size bindings and `resize` from the canvas, keys from the device snapshot through body, document and window, `document.activeElement` following the UI's focus, `<title>` setting the page's title, `css: 'injected'`, legacy `on:` with modifiers and its listeners going on unmount.
- The conformance harness (`npm run test:svelte-conformance`) runs Svelte's own runtime samples among the rest.

## Upstream shape

Four pull requests, one per section, each: the source changes above, its error message file, a `custom-renderer` test sample with a minimal renderer that has (and one that lacks) the hook, and the hook documented beside `addEventListener` in the renderer interface. `bind` and `globalTarget` share the window/document binding change; whichever lands second carries it. All are additive: renderers without the hooks behave as before, except that a refusal moves from compile time to the feature's first use, and (`addStyles`) an inherited `css: 'injected'` is honoured rather than ignored.
