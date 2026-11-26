import { describe, expect, it } from "vitest";
import { compile } from "svelte/compiler";
import { flushSync } from "svelte";
import * as internal from "svelte/internal/client";

// ADR 0419: patches/svelte+5.59.2.patch, the custom renderer's `bind` hook. The compiler emits `bind_renderer`
// for element bindings when a custom renderer is set (bind:this stays `bind_this`, with the renderer's node);
// bindings on <svelte:window>/<svelte:document>/<svelte:body> are still refused; at runtime the hook runs like
// an attachment, again when state read through `get()` changes, and a renderer without `bind` fails clearly.

interface Internal {
  state<T>(v: T): unknown;
  get<T>(s: unknown): T;
  set<T>(s: unknown, v: T): void;
  effect_root(fn: () => void): () => void;
  push_renderer(r: unknown): unknown;
  pop_renderer(previous: unknown): void;
  bind_renderer(node: unknown, name: string, get: () => unknown, set?: (v: unknown) => void): void;
}
const $ = internal as unknown as Internal;

const SOURCE = `<script>let v = $state("a"); let el = $state(); let w = $state(0);</script>
<input bind:value={v} bind:this={el} /><div bind:clientWidth={w}></div><p>{v}</p>`;

describe("the custom renderer bind hook (svelte patch)", () => {
  it("compiles element bindings to the hook under a custom renderer, and leaves DOM output alone", () => {
    const custom = compile(SOURCE, { filename: "A.svelte", generate: "client", experimental: { customRenderer: "/renderer.js" } }).js.code;
    expect(custom).toContain(`$.bind_renderer(input, 'value', () => $.get(v), ($$value) => $.set(v, $$value))`);
    expect(custom).toContain(`$.bind_renderer(div, 'clientWidth'`);
    expect(custom).toMatch(/\$\.bind_this\(input,/);
    const dom = compile(SOURCE, { filename: "A.svelte", generate: "client" }).js.code;
    expect(dom).toContain("$.bind_value(input,");
    expect(dom).not.toContain("bind_renderer");
  });

  it("still refuses bindings on <svelte:window>, <svelte:document> and <svelte:body>", () => {
    for (const tag of ["svelte:window", "svelte:document", "svelte:body"]) {
      expect(() => compile(`<script>let x = $state(0);</script><${tag} bind:innerWidth={x}/>`, { filename: "B.svelte", experimental: { customRenderer: "/renderer.js" } })).toThrow(/is not compatible with `customRenderer`/);
    }
  });

  it("runs the hook with get and set, again (after its cleanup) when the bound state changes", () => {
    const calls: string[] = [];
    const node = { name: "input" };
    const renderer = {
      bind(n: unknown, name: string, get: () => unknown, set: (v: unknown) => void) {
        calls.push(`bind ${name} ${String(get())}`);
        if (calls.length === 1) set("typed"); // the node reporting a change
        return () => calls.push("cleanup");
      },
    };
    const v = $.state("a");
    const previous = $.push_renderer(renderer);
    let stop: () => void;
    try {
      stop = $.effect_root(() => $.bind_renderer(node, "value", () => $.get(v), (x) => $.set(v, x)));
    } finally {
      $.pop_renderer(previous);
    }
    flushSync();
    expect($.get(v)).toBe("typed");
    expect(calls).toEqual(["bind value a", "cleanup", "bind value typed"]);
    stop!();
    expect(calls.at(-1)).toBe("cleanup");
  });

  it("throws a clear error when the renderer has no bind", () => {
    const previous = $.push_renderer({});
    try {
      expect(() => $.effect_root(() => $.bind_renderer({}, "value", () => "")) ).toThrow(/bind:value.*needs the custom renderer to define `bind`|renderer_bind_unsupported/);
    } finally {
      $.pop_renderer(previous);
    }
  });
});
