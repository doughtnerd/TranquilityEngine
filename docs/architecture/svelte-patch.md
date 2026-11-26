# Our Svelte patch: element bindings under a custom renderer

`patches/svelte+5.59.2.patch` (applied by `patch-package` on `npm install`, as `patches/@babylonjs+core+9.32.0.patch` is) changes Svelte 5.59.2 so that `bind:` on elements works under a custom renderer ([ADR 0419](../decisions/0419-game-ui-is-authored-in-svelte-rendered-onto-the-ui-core.md)). This page is the write-up for the upstream issue and pull request. If Svelte ships element bindings for custom renderers, we delete the patch and follow theirs.

Later hooks from 0419 (`animate`/`measure`, `globalTarget`, `html`, `addStyles`, legacy `on:`, `<svelte:head>`) go into the same patch file, each as its own change offered upstream separately. They aren't written yet.

## The problem

With `compilerOptions.experimental.customRenderer` set, the analyzer refuses every `bind:` on an element (`incompatible_with_custom_renderer`, from `phases/2-analyze/visitors/BindDirective.js`), even for HTML tag names: `<input bind:value>` compiles in DOM mode and is refused with a custom renderer. The reason is that the client binding helpers (`internal/client/dom/elements/bindings/`) are DOM code: they read `node.value`, listen for `input` events, use `ResizeObserver` and so on. A custom renderer's nodes are not DOM nodes, so those helpers can't work, and the compiler can't know what a renderer's nodes can do.

Bindings on components (`<Child bind:value>`) aren't affected: they're props.

## The change

1. **An optional renderer hook.** The `Renderer` interface (`svelte/renderer`, `types/index.d.ts`) gains:

   ```ts
   bind?(node: N['element'], name: string, get: () => any, set: (value: any) => void): (() => void) | void;
   ```

   The renderer pushes the bound value to the node by reading `get()`, reports changes from the node by calling `set(value)`, and returns a cleanup. Like an attachment, the hook runs inside a render effect: when state read through `get()` changes, the cleanup runs and the hook runs again.

2. **The analyzer allows element bindings under a custom renderer.** `phases/2-analyze/visitors/BindDirective.js` refuses `bind:` under a custom renderer only on `<svelte:window>`, `<svelte:document>` and `<svelte:body>`, which have no renderer node to bind to (a later `globalTarget` hook covers those). `RegularElement` and `SvelteElement` parents are allowed. The usual per-element validation (which names apply to which tags) still runs.

3. **The client transform emits the hook.** `phases/3-transform/client/visitors/BindDirective.js`: under a custom renderer, an element binding other than `bind:this` compiles to

   ```js
   $.bind_renderer(node, "value", get, set);
   ```

   instead of `$.bind_value(...)`, `$.bind_property(...)` and the other DOM helpers. DOM output is unchanged.

4. **`bind:this` is unchanged** and keeps compiling to `$.bind_this`, so it gives the renderer's node.

5. **The runtime helper.** `internal/client/custom-renderer/bind.js` exports `bind_renderer(node, name, get, set)` (re-exported from `internal/client/index.js`). It looks up the current renderer and runs `renderer.bind(node, name, get, set)` in a `render_effect`.

6. **A clear error when the renderer has no `bind`.** The compiler can't see the renderer object (it only has the module path), so it can't refuse at compile time. `bind_renderer` throws `renderer_bind_unsupported` (`` `bind:value` needs the custom renderer to define `bind` ``, in `internal/client/errors.js`) when the binding is created. Upstream, the message would also go into `messages/client-errors/` so `errors.js` is generated as usual.

## What the engine's renderer does with it

`src/plugins/ui/svelte/renderer.ts` implements `bind` for `bind:value` on `input` (from the UI core's input and change events, ADR 0309). Other names warn once and do nothing yet (`bind:checked`/`bind:value` on toggles and sliders come with those elements; size bindings with `measure`).

## Tests

- `src/plugins/ui/svelte/sveltePatch.test.ts`: element bindings compile to the hook under a custom renderer and DOM output is unchanged; window/document/body bindings are still refused; the hook gets `get` and `set` and runs again (after its cleanup) when the bound state changes; a renderer without `bind` throws the clear error.
- `src/plugins/ui/runtime/uiView.test.ts`: `<input bind:value>` both ways through a `UIView`, and `bind:this` giving the renderer's node.
- The conformance harness (`npm run test:svelte-conformance`) runs Svelte's binding samples among the rest.

## Upstream shape

An upstream PR would be the same four source changes plus the error message file, a `custom-renderer` test sample for `bind:value` with a minimal renderer, and the `bind` member documented beside `addEventListener` in the renderer interface. It is additive: renderers without `bind` behave as before, except that the refusal moves from compile time to the binding's creation.
