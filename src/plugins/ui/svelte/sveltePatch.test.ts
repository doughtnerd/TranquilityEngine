import { describe, expect, it, vi } from "vitest";
import { compile } from "svelte/compiler";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { Tween } from "svelte/motion";
import * as internal from "svelte/internal/client";
import "svelte/internal/flags/custom-renderer"; // effects remember their renderer (compiled components import it too)
import { crossfade, fade, fly } from "svelte/transition";
import { flip } from "svelte/animate";

// ADR 0423: patches/svelte+5.59.2.patch, the custom renderer's hooks.
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

  it("tells the hook, through ownChange, whether the batch being applied is one its own set started", () => {
    let report!: (v: unknown) => void;
    const seen: [unknown, boolean][] = [];
    const renderer = {
      bind(_n: unknown, _name: string, get: () => unknown, set: (v: unknown) => void, ownChange: () => boolean) {
        report = set;
        seen.push([get(), ownChange()]);
      },
    };
    const v = $.state("a");
    const stop = withRenderer(renderer, () => $.bind_renderer({}, "value", () => $.get(v), (x) => $.set(v, x)));
    flushSync();
    report("typed"); // the node reporting a change
    flushSync();
    $.set(v, "elsewhere"); // a change the node didn't start
    flushSync();
    expect(seen).toEqual([["a", false], ["typed", true], ["elsewhere", false]]);
    stop();
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

// ADR 0429: the `html(anchor, value)` hook: `{@html}` compiles under a custom renderer, the renderer turns the string into
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

// ADR 0423 wave Z3: the `requestAnimationFrame(callback)` and `now()` hooks: while a component mounted with a renderer
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

// Conformance round 2: what Svelte's custom-renderer paths skipped, or did differently, that its DOM paths do
// (docs/architecture/svelte-patch.md, "Event delegation" and "Fixes to custom-renderer paths").
describe("custom renderer paths doing what the DOM paths do (svelte patch)", () => {
  interface Extra {
    delegated(type: string, node: unknown, handler: (e: unknown) => void): void;
    delegate(types: string[]): void;
    validate_snippet_renderer<T>(fn: T): T;
    set_value(node: unknown, value: unknown, isSelect?: boolean): void;
    attribute_effect(node: unknown, fn: () => Record<string, unknown>, sync?: unknown[], async?: unknown[], blockers?: unknown[], cssHash?: string, removeDefaults?: boolean, skipWarning?: boolean, tag?: string): void;
    from_tree(structure: unknown[], flags: number): () => unknown;
  }
  const x = internal as unknown as Extra;
  type N = { name: string; ns?: string; parent: N | null; children: N[]; attrs: Map<string, unknown>; listeners: Map<string, ((e: unknown) => void)[]> };
  const node = (name: string, ns?: string): N => ({ name, ns, parent: null, children: [], attrs: new Map(), listeners: new Map() });
  /** A tree renderer with listeners (bubbling dispatch, `cancelBubble`) and an `html` hook making a node per word. */
  const eventRenderer = () => {
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
      created: [] as N[],
      /** Dispatch a bubbling event at `target`: its listeners, then each ancestor's, until one stops it. */
      click(target: N) {
        const e = { type: "click", target, cancelBubble: false, eventPhase: 2, stopPropagation: () => void (e.cancelBubble = true) };
        for (let n: N | null = target; n && !e.cancelBubble; n = n.parent) {
          for (const l of [...(n.listeners.get("click") ?? [])]) l(e);
          e.eventPhase = 3;
        }
      },
      createFragment: () => node("#fragment"),
      createElement: (name: string, ns?: string) => {
        const n = node(name, ns);
        r.created.push(n);
        return n;
      },
      createText: () => node("#text"),
      createComment: () => node("<!>"),
      getNodeType: (n: N) => (n.name === "<!>" ? "comment" : n.name === "#fragment" ? "fragment" : n.name === "#text" ? "text" : "element"),
      getText: () => "",
      setText() {},
      getAttribute: (n: N, k: string) => (n.attrs.has(k) ? String(n.attrs.get(k)) : null),
      setAttribute: (n: N, k: string, v: unknown) => void n.attrs.set(k, v),
      removeAttribute: (n: N, k: string) => void n.attrs.delete(k),
      hasAttribute: (n: N, k: string) => n.attrs.has(k),
      html(_anchor: N, value: string): N {
        const fragment = node("#fragment");
        for (const w of value.split(" ")) insert(fragment, node(w), null);
        return fragment;
      },
      insert,
      remove: (n: N) => void (n.parent && (n.parent.children.splice(n.parent.children.indexOf(n), 1), (n.parent = null))),
      getParent: (n: N) => n.parent,
      getFirstChild: (n: N) => n.children[0] ?? null,
      getLastChild: (n: N) => n.children.at(-1) ?? null,
      getNextSibling: (n: N) => (n.parent ? (n.parent.children[n.parent.children.indexOf(n) + 1] ?? null) : null),
      addEventListener: (n: N, type: string, fn: (e: unknown) => void) => {
        if (!n.listeners.has(type)) n.listeners.set(type, []);
        n.listeners.get(type)!.push(fn);
      },
      removeEventListener: (n: N, type: string, fn: (e: unknown) => void) => {
        const list = n.listeners.get(type) ?? [];
        if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
      },
    };
    return r;
  };

  it("compiles event attributes delegated, an option's nullish value as '', and a select's value with its check", () => {
    const code = compile(`<script>let v = $state(); let f = () => {};</script><button onclick={f}>b</button><select multiple value={v}><option value={v}>o</option></select>`, OPTIONS).js.code;
    expect(code).toContain("$.delegated('click', button,");
    expect(code).toContain("$.delegate(['click'])");
    expect(code).toMatch(/\$\.set_value\(option, [^;]*\?\? ''\)/);
    expect(code).toMatch(/\$\.set_value\(select, [^;]*, true\)/);
    const dom = compile(`<script>let v = $state();</script><select><option value={v}>o</option></select>`, { filename: "B.svelte", generate: "client" }).js.code;
    expect(dom).not.toContain("$.set_value(");
  });

  it("runs delegated handlers from the mount target, after the direct listeners below it, and with the renderer current", () => {
    const r = eventRenderer();
    const log: string[] = [];
    let inner!: N;
    let outer!: N;
    const app = mount(((anchor: N) => {
      outer = r.createElement("div");
      inner = r.createElement("button");
      r.insert(outer, inner, null);
      r.insert(anchor.parent!, outer, anchor);
      x.delegated("click", inner, () => log.push("inner onclick"));
      $.event("click", inner, () => log.push("inner on:click"));
      x.delegated("click", outer, () => {
        log.push("outer onclick");
        // `mount()` in a handler renders with the handler's renderer
        mount(((a: N) => void r.insert(a.parent!, r.createElement("mounted"), a)) as never, { target: outer as never });
      });
      x.delegate(["click"]);
    }) as never, { target: node("root") as never, renderer: r } as never);
    r.click(inner);
    expect(log).toEqual(["inner on:click", "inner onclick", "outer onclick"]);
    expect(outer.children.map((c) => c.name)).toContain("mounted");
    void unmount(app);
  });

  it("passes the namespace to createElement, and builds a raw snippet through the html hook", () => {
    const r = eventRenderer();
    const parent = node("p");
    const anchor = node("<!>");
    r.insert(parent, anchor, null);
    let setUp: unknown = null;
    const raw = createRawSnippet(() => ({ render: () => " one ", setup: (el: unknown) => void (setUp = el) }));
    expect(x.validate_snippet_renderer(raw)).toBe(raw); // raw snippets render with whichever renderer is current
    const stop = withRenderer(r, () => {
      (raw as unknown as (a: N) => void)(anchor);
      r.insert(parent, x.from_tree([["svg", null, ["path", null]], ["div", null]], 1)() as N, anchor);
    });
    flushSync();
    expect(parent.children.map((c) => c.name)).toEqual(["one", "svg", "div", "<!>"]);
    expect(setUp).toBe(parent.children[0]);
    expect(r.created.map((n) => [n.name, n.ns])).toEqual([
      ["svg", "http://www.w3.org/2000/svg"],
      ["path", "http://www.w3.org/2000/svg"],
      ["div", "http://www.w3.org/1999/xhtml"],
    ]);
    stop();
  });

  it("keeps a <select multiple>'s selection when its value isn't an array, with Svelte's warning", () => {
    const r = eventRenderer();
    const select = node("select");
    r.setAttribute(select, "multiple", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = withRenderer(r, () => {
      x.set_value(select, 123, true);
      x.set_value(select, ["a"], true);
    });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("select_multiple_invalid_value")]);
    expect(select.attrs.get("value")).toEqual(["a"]);
    warn.mockRestore();
    stop();
  });

  it("tells the renderer of a select's first nullish value (the DOM sets `select.value`), and only a select's", () => {
    const r = eventRenderer();
    const select = node("select");
    const input = node("input");
    const stop = withRenderer(r, () => {
      x.set_value(select, null, true);
      x.set_value(input, null);
    });
    expect(select.attrs.has("value")).toBe(true);
    expect(select.attrs.get("value")).toBeNull();
    expect(input.attrs.has("value")).toBe(false);
    stop();
  });

  it("keeps a spread's default when its first checked or value is nullish, and removes a later nullish one", () => {
    const r = eventRenderer();
    const input = node("input");
    r.setAttribute(input, "checked", "");
    const checked = $.state<boolean | undefined>(undefined);
    const stop = withRenderer(r, () => x.attribute_effect(input, () => ({ checked: $.get(checked) }), [], [], [], undefined, false, false, "input"));
    flushSync();
    expect(input.attrs.has("checked")).toBe(true);
    $.set(checked, true);
    flushSync();
    $.set(checked, undefined);
    flushSync();
    expect(input.attrs.has("checked")).toBe(false);
    stop();
  });
});
