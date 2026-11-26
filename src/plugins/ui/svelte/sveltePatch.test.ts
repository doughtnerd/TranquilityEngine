import { describe, expect, it } from "vitest";
import { compile } from "svelte/compiler";
import { flushSync, mount, unmount } from "svelte";
import { Tween } from "svelte/motion";
import * as internal from "svelte/internal/client";
import "svelte/internal/flags/custom-renderer"; // effects remember their renderer (compiled components import it too)
import { crossfade, fade, fly } from "svelte/transition";
import { flip } from "svelte/animate";

// ADR 0419: patches/svelte+5.59.2.patch, the custom renderer's hooks.
// - `bind`: the compiler emits `bind_renderer` for element bindings when a custom renderer is set (bind:this stays
//   `bind_this`, with the renderer's node), and for <svelte:window>/<svelte:document> bindings on the renderer's
//   global target; at runtime the hook runs like an attachment, again when state read through `get()` changes, and a
//   renderer without `bind` fails clearly.
// - `globalTarget(kind)`: <svelte:window>, <svelte:document>, <svelte:body> events and bindings, <svelte:head>
//   content and its <title>; listeners on a global target go when their component does.
// - `addStyles(hash, code)`: `css: 'injected'`.
// - Legacy `on:` compiles to the renderer's `addEventListener`, with Svelte's modifier wrappers.
// - `animate(node, keyframes, options)` and `measure(node)`: `transition:`, `in:`, `out:` and `animate:` compile under a
//   custom renderer; `svelte/transition` and `svelte/animate` read geometry through `measure`; a renderer without the
//   hooks fails clearly. (Playing them end to end: uiViewTransitions.test.ts, through a UIView.)

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
  transition(flags: number, node: unknown, fn: () => unknown, params: (() => unknown) | null): void;
  animation(node: unknown, fn: () => unknown, params: (() => unknown) | null): void;
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

  it("compiles transition:, in:, out: and animate: under a custom renderer, as for the DOM", () => {
    const source = `<script>import { fade, fly } from "svelte/transition"; import { flip } from "svelte/animate"; let list = $state([1]); let on = $state(true);</script>
{#if on}<p transition:fade>a</p><p in:fly={{ y: 10 }} out:fade|global>b</p>{/if}
{#each list as x (x)}<i animate:flip>{x}</i>{/each}`;
    const custom = compile(source, OPTIONS).js.code;
    expect(custom).toContain("$.transition(3, p, () => fade)");
    expect(custom).toContain("$.transition(1, p_1, () => fly,");
    expect(custom).toContain("$.transition(6, p_1, () => fade)");
    expect(custom).toContain("$.animation(i, () => flip, null)");
    const dom = compile(source, { filename: "B.svelte", generate: "client" }).js.code;
    expect(dom).toContain("$.transition(3, p, () => fade)");
  });

  it("fails clearly when the renderer has no animate (transitions) or no measure (animate:)", () => {
    expect(() => withRenderer({}, () => $.transition(3, {}, () => fade, null))).toThrow(/`transition:` needs the custom renderer to define `animate`|renderer_animate_unsupported/);
    expect(() => withRenderer({}, () => $.transition(1, {}, () => fade, null))).toThrow(/`in:` needs the custom renderer to define `animate`|renderer_animate_unsupported/);
    expect(() => withRenderer({ animate() {} }, () => $.animation({}, () => flip, null))).toThrow(/`animate:` needs the custom renderer to define `measure`|renderer_measure_unsupported/);
  });

  it("has svelte/transition and svelte/animate measure through the renderer", () => {
    const node = { name: "node" };
    const other = { name: "other" };
    const boxes = new Map<unknown, { left: number; top: number; width: number; height: number }>([
      [node, { left: 0, top: 0, width: 100, height: 20 }],
      [other, { left: 50, top: 40, width: 100, height: 20 }],
    ]);
    const renderer = {
      measure: (n: unknown) => {
        const b = boxes.get(n)!;
        return { ...b, right: b.left + b.width, bottom: b.top + b.height, clientWidth: b.width, clientHeight: b.height, style: { opacity: "0.5", transform: "none", transformOrigin: "50px 10px" } };
      },
    };
    let fadeCss = "", flyCss = "", flipCss = "", crossCss = "";
    withRenderer(renderer, () => {
      fadeCss = fade(node as never).css!(1, 0);
      flyCss = fly(node as never, { x: 10 }).css!(0, 1).replace(/\s+/g, " ").trim();
      flipCss = flip(node as never, { from: boxes.get(other) as DOMRect, to: boxes.get(node) as DOMRect }, {}).css!(0, 1);
      const [send, receive] = crossfade({});
      send(other as never, { key: 1 });
      const incoming = receive(node as never, { key: 1 }) as unknown as () => { css(t: number, u: number): string };
      crossCss = incoming().css(0, 1).replace(/\s+/g, " ").trim();
    })();
    expect(fadeCss).toBe("opacity: 0.5");
    expect(flyCss).toBe("transform: translate(10px, 0px); opacity: 0");
    expect(flipCss).toBe("transform:  translate(50px, 40px) scale(1, 1);");
    expect(crossCss).toBe("opacity: 0; transform-origin: top left; transform: translate(50px,40px) scale(1, 1);");
  });
});

// ADR 0425: the `html(anchor, value)` hook: `{@html}` compiles under a custom renderer, the renderer turns the string into
// nodes (a fragment) that replace the tag's previous ones before its anchor (or become its element's only content), and a
// renderer without the hook fails clearly.
describe("the custom renderer html hook (svelte patch)", () => {
  interface Html {
    html(node: unknown, get: () => string, controlled?: boolean): void;
  }
  const h = internal as unknown as Html;
  type N = { name: string; parent: N | null; children: N[] };
  const node = (name: string): N => ({ name, parent: null, children: [] });
  /** A tree renderer whose `html` makes a text node per word. */
  const treeRenderer = () => {
    const insert = (parent: N, n: N, anchor: N | null): void => {
      if (n.name === "#fragment") {
        for (const c of [...n.children]) insert(parent, c, anchor);
        return;
      }
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at < 0) parent.children.push(n);
      else parent.children.splice(at, 0, n);
    };
    const r = {
      calls: [] as string[],
      html(anchor: N, value: string): N {
        r.calls.push(`html ${anchor.name} ${value}`);
        const fragment = node("#fragment");
        for (const w of value.split(" ")) insert(fragment, node(w), null);
        return fragment;
      },
      insert,
      remove: (n: N) => n.parent && n.parent.children.splice(n.parent.children.indexOf(n), 1) && ((n.parent = null), undefined),
      getParent: (n: N) => n.parent,
      getFirstChild: (n: N) => n.children[0] ?? null,
      getLastChild: (n: N) => n.children.at(-1) ?? null,
      getNextSibling: (n: N) => (n.parent ? (n.parent.children[n.parent.children.indexOf(n) + 1] ?? null) : null),
      getNodeType: (n: N) => (n.name === "<!>" ? "comment" : n.name === "#fragment" ? "fragment" : "element"),
    };
    return r;
  };
  const names = (n: N) => n.children.map((c) => c.name);

  it("compiles {@html} under a custom renderer, as for the DOM", () => {
    const code = compile(`<script>let v = $state("<b>x</b>");</script><p>a {@html v}</p><div>{@html v}</div>`, OPTIONS).js.code;
    expect(code).toContain("$.html(");
  });

  it("inserts the renderer's nodes before the anchor, replacing them when the value changes, or as an element's content", () => {
    const r = treeRenderer();
    const parent = node("p");
    const anchor = node("<!>");
    r.insert(parent, node("before"), null);
    r.insert(parent, anchor, null);
    const v = $.state("a b");
    const stop = withRenderer(r, () => h.html(anchor, () => $.get(v)));
    flushSync();
    expect(names(parent)).toEqual(["before", "a", "b", "<!>"]);
    $.set(v, "c");
    flushSync();
    expect(names(parent)).toEqual(["before", "c", "<!>"]);
    expect(r.calls).toEqual(["html <!> a b", "html <!> c"]);
    stop();

    // The tag as its element's only content (contenteditable's case): whatever the element holds goes.
    const div = node("div");
    r.insert(div, node("typed"), null);
    const w = $.state("x y");
    const stop2 = withRenderer(r, () => h.html(div, () => $.get(w), true));
    flushSync();
    expect(names(div)).toEqual(["x", "y"]);
    $.set(w, "");
    flushSync();
    expect(names(div)).toEqual([]);
    stop2();
  });

  it("fails clearly when the renderer has no html", () => {
    const r = { ...treeRenderer(), html: undefined };
    const parent = node("p");
    const anchor = node("<!>");
    r.insert(parent, anchor, null);
    expect(() => withRenderer(r, () => h.html(anchor, () => "x"))).toThrow(/needs the custom renderer to define `html`|renderer_html_unsupported/);
  });
});

// ADR 0419 wave Z3: the `requestAnimationFrame(callback)` and `now()` hooks: while a component mounted with a renderer
// that has them is mounted, Svelte's frame loop (`svelte/motion`, `tick` transitions) runs on the renderer's frames and
// clock instead of the browser's; unmounting gives them back.
describe("the custom renderer timing hooks (svelte patch)", () => {
  type N = { name: string; parent: N | null; children: N[] };
  const node = (name: string): N => ({ name, parent: null, children: [] });
  /** The least a renderer needs to mount a component that renders nothing, with Svelte's frames and clock. */
  const timedRenderer = () => {
    const insert = (parent: N, n: N, anchor: N | null): void => {
      if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      n.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at < 0) parent.children.push(n);
      else parent.children.splice(at, 0, n);
    };
    const r = {
      clock: 1000,
      frames: [] as ((time: number) => void)[],
      /** One of the renderer's frames: the clock moves on, then the callbacks asked for run. */
      frame(ms: number) {
        r.clock += ms;
        for (const f of r.frames.splice(0)) f(r.clock);
      },
      requestAnimationFrame: (callback: (time: number) => void) => void r.frames.push(callback),
      now: () => r.clock,
      createFragment: () => node("#fragment"),
      createElement: (name: string) => node(name),
      createText: () => node("#text"),
      createComment: () => node("<!>"),
      getNodeType: (n: N) => (n.name === "<!>" ? "comment" : n.name === "#fragment" ? "fragment" : n.name === "#text" ? "text" : "element"),
      getText: () => "",
      setText() {},
      getAttribute: () => null,
      setAttribute() {},
      removeAttribute() {},
      hasAttribute: () => false,
      insert,
      remove: (n: N) => void (n.parent && (n.parent.children.splice(n.parent.children.indexOf(n), 1), (n.parent = null))),
      getParent: (n: N) => n.parent,
      getFirstChild: (n: N) => n.children[0] ?? null,
      getLastChild: (n: N) => n.children.at(-1) ?? null,
      getNextSibling: (n: N) => (n.parent ? (n.parent.children[n.parent.children.indexOf(n) + 1] ?? null) : null),
      addEventListener() {},
      removeEventListener() {},
    };
    return r;
  };

  it("runs svelte/motion on the renderer's frames and clock while the component is mounted, and gives them back after", async () => {
    const r = timedRenderer();
    let tween!: Tween<number>;
    const app = mount(((_anchor: unknown) => {
      tween = new Tween(0, { duration: 100 });
      void tween.set(100);
    }) as never, { target: node("root") as never, renderer: r } as never);
    expect(r.frames).toHaveLength(1); // the tween's loop asked for the renderer's next frame
    r.frame(25);
    expect(tween.current).toBe(25);
    r.frame(80); // past its end
    expect(tween.current).toBe(100);
    expect(r.frames).toHaveLength(0); // done: no more frames asked for

    await unmount(app);
    void new Tween(0, { duration: 100 }).set(1);
    expect(r.frames).toHaveLength(0); // unmounted: Svelte's own frames again (none in Node)
  });
});
