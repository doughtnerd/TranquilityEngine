import { describe, expect, it } from "vitest";
import { compile } from "svelte/compiler";
import { flushSync } from "svelte";
import * as internal from "svelte/internal/client";
import "svelte/internal/flags/custom-renderer"; // effects remember their renderer (compiled components import it too)

// ADR 0419: patches/svelte+5.59.2.patch, the custom renderer's hooks.
// - `bind`: the compiler emits `bind_renderer` for element bindings when a custom renderer is set (bind:this stays
//   `bind_this`, with the renderer's node), and for <svelte:window>/<svelte:document> bindings on the renderer's
//   global target; at runtime the hook runs like an attachment, again when state read through `get()` changes, and a
//   renderer without `bind` fails clearly.
// - `globalTarget(kind)`: <svelte:window>, <svelte:document>, <svelte:body> events and bindings, <svelte:head>
//   content and its <title>; listeners on a global target go when their component does.
// - `addStyles(hash, code)`: `css: 'injected'`.
// - Legacy `on:` compiles to the renderer's `addEventListener`, with Svelte's modifier wrappers.

interface Internal {
  state<T>(v: T): unknown;
  get<T>(s: unknown): T;
  set<T>(s: unknown, v: T): void;
  effect_root(fn: () => void): () => void;
  push_renderer(r: unknown): unknown;
  pop_renderer(previous: unknown): void;
  bind_renderer(node: unknown, name: string, get: () => unknown, set?: (v: unknown) => void): void;
  global_target(kind: string): unknown;
  event(name: string, node: unknown, handler: (e: unknown) => void, capture?: boolean, passive?: boolean): void;
  append_styles(anchor: unknown, css: { hash: string; code: string }): void;
  head(hash: string, render: (anchor: unknown) => void): void;
}

const OPTIONS = { filename: "B.svelte", generate: "client", experimental: { customRenderer: "/renderer.js" } } as const;

/** Run `fn` with `renderer` current, inside an effect root; returns the root's stop function. */
function withRenderer(renderer: unknown, fn: () => void): () => void {
  const previous = $.push_renderer(renderer);
  try {
    return $.effect_root(fn);
  } finally {
    $.pop_renderer(previous);
  }
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

  it("compiles window and document bindings to the hook on the renderer's global target", () => {
    for (const [tag, kind, name] of [["svelte:window", "window", "innerWidth"], ["svelte:document", "document", "activeElement"]]) {
      const code = compile(`<script>let x = $state(0);</script><${tag} bind:${name}={x}/>`, OPTIONS).js.code;
      expect(code).toContain(`$.bind_renderer($.global_target('${kind}'), '${name}'`);
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

  it("compiles <svelte:window>, <svelte:document>, <svelte:body> and <svelte:head> onto the renderer's global targets", () => {
    const code = compile(
      `<script>let t = $state("x");</script>
<svelte:window onkeydown={() => {}} on:resize={() => {}} /><svelte:document on:visibilitychange={() => {}} /><svelte:body onpointerdown={() => {}} />
<svelte:head><title>Game {t}</title></svelte:head>`,
      OPTIONS,
    ).js.code;
    expect(code).toContain("$.event('keydown', $.global_target('window'),");
    expect(code).toContain("$.event('resize', $.global_target('window'),");
    expect(code).toContain("$.event('visibilitychange', $.global_target('document'),");
    expect(code).toContain("$.event('pointerdown', $.global_target('body'),");
    expect(code).toMatch(/\$\.global_target\('document'\)\.title = /);
    expect(code).toContain("$.head(");
    // DOM output is unchanged
    const dom = compile(`<svelte:window onkeydown={() => {}} /><svelte:head><title>A</title></svelte:head>`, { filename: "B.svelte", generate: "client" }).js.code;
    expect(dom).toContain("$.event('keydown', $.window,");
    expect(dom).toContain("$.document.title = 'A'");
    expect(dom).not.toContain("global_target");
  });

  it("compiles legacy on: to the renderer's events, with Svelte's modifier wrappers", () => {
    const code = compile(`<script>let n = $state(0);</script><button on:click|once|preventDefault={() => n++} on:custom={() => {}}>{n}</button>`, OPTIONS).js.code;
    expect(code).toContain("$.event('click', button, $.once($.preventDefault(");
    expect(code).toContain("$.event('custom', button,");
  });

  it("compiles css: 'injected' to the renderer's addStyles, from the option or <svelte:options>", () => {
    const style = `<p>a</p><style>p { color: red; }</style>`;
    for (const [source, extra] of [[`<svelte:options css="injected" />${style}`, {}], [style, { css: "injected" }]] as const) {
      const code = compile(source, { ...OPTIONS, ...extra }).js.code;
      expect(code).toContain("$.append_styles($$anchor, $$css)");
      expect(code).toMatch(/const \$\$css = \{\s*hash: 'svelte-[a-z0-9]+',\s*code: 'p\.svelte-[a-z0-9]+ ?\{color:red;\}'/);
    }
  });

  it("asks the renderer for global targets, removes listeners on them with their component, and fails clearly without the hook", () => {
    const calls: string[] = [];
    const win = { name: "window" };
    const renderer = {
      globalTarget: (kind: string) => (kind === "window" ? win : null),
      addEventListener: (t: unknown, type: string) => calls.push(`add ${type} ${t === win}`),
      removeEventListener: (t: unknown, type: string) => calls.push(`remove ${type} ${t === win}`),
    };
    const stop = withRenderer(renderer, () => {
      expect($.global_target("window")).toBe(win);
      $.event("keydown", $.global_target("window"), () => {});
    });
    expect(calls).toEqual(["add keydown true"]);
    stop();
    expect(calls).toEqual(["add keydown true", "remove keydown true"]);

    expect(() => withRenderer({}, () => $.global_target("window"))).toThrow(/<svelte:window>.*needs the custom renderer to define `globalTarget`|renderer_global_target_unsupported/);
  });

  it("inserts <svelte:head> content into the renderer's head target", () => {
    const head = { children: [] as unknown[] };
    const renderer = {
      globalTarget: (kind: string) => (kind === "head" ? head : null),
      createComment: () => ({ comment: true }),
      insert: (parent: { children: unknown[] }, node: unknown) => parent.children.push(node),
      remove: (node: unknown) => head.children.splice(head.children.indexOf(node), 1),
      getNextSibling: () => null,
    };
    let anchor: unknown = null;
    const stop = withRenderer(renderer, () => $.head("h", (a) => (anchor = a)));
    flushSync();
    expect(head.children).toEqual([{ comment: true }]);
    expect(anchor).toBe(head.children[0]);
    stop();
    expect(head.children).toEqual([]);
  });

  it("hands injected styles to the renderer's addStyles, and fails clearly without it", () => {
    const added: string[] = [];
    withRenderer({ addStyles: (hash: string, code: string) => added.push(`${hash} ${code}`) }, () => $.append_styles(null, { hash: "svelte-x", code: "p.svelte-x{}" }))();
    expect(added).toEqual(["svelte-x p.svelte-x{}"]);
    expect(() => withRenderer({}, () => $.append_styles(null, { hash: "svelte-x", code: "" }))).toThrow(/css: 'injected'.*needs the custom renderer to define `addStyles`|renderer_add_styles_unsupported/);
  });
});
