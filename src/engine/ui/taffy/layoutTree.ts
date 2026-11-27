/**
 * The UI core's layout engine (ADR 0433): Taffy, the Rust CSS flexbox / grid / block engine, compiled to WebAssembly
 * (`native/layout`, committed in `./wasm/`). A `LayoutTree` holds `LayoutNode`s set with CSS keywords and lengths; a
 * measured leaf (text, a replaced element) gets its content size from its `MeasureFunction`; `compute` lays a root out
 * and each node's `layout()` reads its box. Boxes aren't rounded: they are exact in UI pixels.
 *
 * Initial values follow CSS except where the UI core's model differs: every node is `display: flex` and
 * `position: relative` (each element is a containing block for its absolute children, as under Yoga, ADR 0076).
 * `flex-shrink` is 1, min sizes are `auto` (content-based), `align-items` is `normal` (stretch), as in a browser.
 *
 * The module loads once per page (browsers fetch `myco_layout_bg.wasm`, which Vite bundles as an asset beside this
 * module; Node reads it from disk). Internal: not public API.
 */
import type { LayoutTree as WasmTree } from "./wasm/myco_layout.js";

/**
 * A size, margin or inset: pixels, a percentage of the containing block, `calc(px + percent%)` as `{ px, percent }`
 * (resolved against the property's CSS basis during layout), `"auto"`, or undefined (`auto`).
 */
export type LayoutLength = number | `${number}%` | LayoutCalc | "auto" | undefined;

/** A linear `calc()` length: pixels plus a percentage (0–100) of the property's basis. */
export interface LayoutCalc {
  readonly px: number;
  readonly percent: number;
}
export type LayoutEdge = "top" | "right" | "bottom" | "left";
export type LayoutDisplay = "flex" | "none" | "block" | "grid";
export type LayoutFlexDirection = "row" | "column" | "row-reverse" | "column-reverse";
export type LayoutContent = "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly" | "stretch" | "start" | "end" | "normal";
export type LayoutItems = "flex-start" | "center" | "flex-end" | "stretch" | "baseline" | "start" | "end" | "normal";
export type LayoutWrap = "nowrap" | "wrap" | "wrap-reverse";
export type LayoutPosition = "relative" | "absolute" | "static";
export type LayoutOverflow = "visible" | "clip" | "hidden" | "scroll";

/**
 * What a measured leaf is asked. `knownWidth` / `knownHeight` are set when layout has already fixed that size.
 * `availableWidth` / `availableHeight` are the room on each axis: a size in pixels, `Infinity` under a max-content
 * constraint (lay out without wrapping), `-Infinity` under a min-content one (wrap at every chance).
 */
export interface MeasureInput {
  readonly knownWidth: number | undefined;
  readonly knownHeight: number | undefined;
  readonly availableWidth: number;
  readonly availableHeight: number;
}

/**
 * A measured leaf's content size for an input, and its first baseline (text's: where its first line sits), down from the
 * top of its content box. Without one, CSS synthesises it at the box's bottom edge, as for a box with no text.
 */
export type MeasureFunction = (input: MeasureInput) => { readonly width: number; readonly height: number; readonly baseline?: number };

export interface LayoutSides {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** A node's computed box: its border box relative to its parent's border box, and its resolved edges. */
export interface LayoutBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly border: LayoutSides;
  readonly padding: LayoutSides;
  /** Resolved margins (auto margins included). */
  readonly margin: LayoutSides;
  /** The scrollable overflow rectangle (its children's margin boxes and its padding box), relative to its border box. */
  readonly overflow: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  /** The room `overflow: scroll` reserves for scrollbars. */
  readonly scrollbarWidth: number;
  readonly scrollbarHeight: number;
}

// Property and value codes: native/layout/crates/layout-core/src/lib.rs. Change both together.
const E = { display: 0, flexDirection: 1, justifyContent: 2, alignItems: 3, alignSelf: 4, alignContent: 5, flexWrap: 6, position: 7, overflowX: 8, overflowY: 9, direction: 10, boxSizing: 11, justifySelf: 12, justifyItems: 13 } as const;
const L = { width: 0, height: 1, minWidth: 2, minHeight: 3, maxWidth: 4, maxHeight: 5, flexBasis: 6, margin: 7, padding: 11, border: 15, inset: 19, columnGap: 23, rowGap: 24 } as const;
const N = { flexGrow: 0, flexShrink: 1, aspectRatio: 2, scrollbarWidth: 3 } as const;
const KIND_AUTO = 0, KIND_PX = 1, KIND_PERCENT = 2;
const OUT_LEN = 22;
const EDGE: Record<LayoutEdge, number> = { top: 0, right: 1, bottom: 2, left: 3 };
const DISPLAY: Record<LayoutDisplay, number> = { flex: 0, none: 1, block: 2, grid: 3 };
const DIRECTION: Record<LayoutFlexDirection, number> = { row: 0, column: 1, "row-reverse": 2, "column-reverse": 3 };
const CONTENT: Record<LayoutContent, number> = { "flex-start": 0, center: 1, "flex-end": 2, "space-between": 3, "space-around": 4, "space-evenly": 5, stretch: 6, start: 7, end: 8, normal: 9 };
const ITEMS: Record<LayoutItems | "auto", number> = { "flex-start": 0, center: 1, "flex-end": 2, stretch: 3, baseline: 4, start: 5, end: 6, normal: 7, auto: 255 };
const WRAP: Record<LayoutWrap, number> = { nowrap: 0, wrap: 1, "wrap-reverse": 2 };
const POSITION: Record<LayoutPosition, number> = { relative: 0, absolute: 1, static: 2 };
const OVERFLOW: Record<LayoutOverflow, number> = { visible: 0, clip: 1, hidden: 2, scroll: 3 };

/** The module's glue and memory, once loaded. */
interface LayoutModule {
  readonly Tree: new () => WasmTree;
  readonly setMeasured: (width: number, height: number, baseline: number) => void;
  readonly memory: WebAssembly.Memory;
}

let loading: Promise<LayoutModule> | null = null;
let loaded: LayoutModule | null = null;

/** Loads the layout module once (later calls share the first load). */
export function loadLayoutEngine(): Promise<void> {
  loading ??= (async () => {
    const glue = await import("./wasm/myco_layout.js");
    const url = new URL("./wasm/myco_layout_bg.wasm", import.meta.url);
    let source: URL | Uint8Array = url;
    if (url.protocol === "file:") {
      // Node has no fetch for file URLs. A variable specifier keeps bundlers from pulling node:fs into web builds.
      const fsModule = "node:fs/promises";
      const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile(path: URL): Promise<Uint8Array> };
      source = await readFile(url);
    }
    const out = await glue.default({ module_or_path: source });
    return (loaded = { Tree: glue.LayoutTree, setMeasured: glue.setMeasured, memory: out.memory });
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading.then(() => undefined);
}

/** True once `loadLayoutEngine` has finished: trees can be made synchronously. */
export function layoutEngineLoaded(): boolean {
  return loaded !== null;
}

function length(v: Exclude<LayoutLength, LayoutCalc>): [number, number] {
  if (typeof v === "number") return Number.isFinite(v) ? [KIND_PX, v] : [KIND_AUTO, 0];
  if (typeof v === "string" && v.endsWith("%")) {
    const n = Number(v.slice(0, -1));
    if (Number.isFinite(n)) return [KIND_PERCENT, n];
  }
  return [KIND_AUTO, 0];
}

/** A tree of layout nodes. `free()` releases it (and every node in it). */
export class LayoutTree {
  private readonly wasm: WasmTree;
  private readonly module: LayoutModule;
  private readonly measures = new Map<number, MeasureFunction>();
  private view: Float32Array | null = null;
  private freed = false;
  /** The module's measure entry: dispatches to the node's function and hands its answer back. */
  private readonly dispatch = (handle: number, kw: number, kh: number, aw: number, ah: number): void => {
    const fn = this.measures.get(handle);
    if (!fn) return;
    const size = fn({ knownWidth: Number.isNaN(kw) ? undefined : kw, knownHeight: Number.isNaN(kh) ? undefined : kh, availableWidth: aw, availableHeight: ah });
    this.module.setMeasured(size.width, size.height, size.baseline ?? NaN);
  };

  /** A new, empty tree. Throws unless `loadLayoutEngine()` has finished. */
  constructor() {
    if (!loaded) throw new Error("LayoutTree: the layout engine hasn't loaded (await loadLayoutEngine() first)");
    this.module = loaded;
    this.wasm = new loaded.Tree();
  }

  /** A new node with the initial style; given a `measure` function it is a measured leaf (it never has children). */
  create(measure?: MeasureFunction): LayoutNode {
    const handle = this.wasm.create(measure !== undefined);
    if (measure) this.measures.set(handle, measure);
    return new LayoutNode(this, handle);
  }

  /**
   * Lays out the tree under `root` in a width and height, as a page's root element in its viewport: a number is
   * definite room (percentages resolve against it; an auto-sized root still fits its content, so give the root a
   * size, or `"100%"`, to fill it); undefined or `Infinity` is max-content room, `-Infinity` min-content.
   */
  compute(root: LayoutNode, width?: number, height?: number): void {
    this.wasm.compute(root.handle, width ?? Infinity, height ?? Infinity, this.dispatch);
  }

  /** Releases the tree's memory; its nodes can't be used after. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.measures.clear();
    this.wasm.free();
  }

  /** @internal The calls `LayoutNode` makes. */
  get raw(): WasmTree {
    return this.wasm;
  }

  /** @internal */
  forget(handle: number): void {
    this.measures.delete(handle);
  }

  /** @internal Reads a node's box from the module's buffer. */
  read(handle: number): LayoutBox {
    this.wasm.layout(handle);
    const buffer = this.module.memory.buffer;
    if (!this.view || this.view.buffer !== buffer) this.view = new Float32Array(buffer, this.wasm.outPtr(), OUT_LEN);
    const o = this.view;
    return {
      x: o[0]!, y: o[1]!, width: o[2]!, height: o[3]!,
      border: { top: o[4]!, right: o[5]!, bottom: o[6]!, left: o[7]! },
      padding: { top: o[8]!, right: o[9]!, bottom: o[10]!, left: o[11]! },
      margin: { top: o[12]!, right: o[13]!, bottom: o[14]!, left: o[15]! },
      overflow: { left: o[16]!, top: o[17]!, right: o[18]!, bottom: o[19]! },
      scrollbarWidth: o[20]!, scrollbarHeight: o[21]!,
    };
  }
}

/** One node of a `LayoutTree`. Setters take CSS keywords; anything unknown sets the initial value. */
export class LayoutNode {
  /** @internal */
  constructor(private readonly tree: LayoutTree, readonly handle: number) {}

  private e(prop: number, v: number | undefined): void {
    this.tree.raw.setEnum(this.handle, prop, v ?? 0);
  }

  private l(prop: number, v: LayoutLength): void {
    if (typeof v === "object") {
      if (v.percent === 0) this.tree.raw.setLength(this.handle, prop, KIND_PX, v.px);
      else if (v.px === 0) this.tree.raw.setLength(this.handle, prop, KIND_PERCENT, v.percent);
      else this.tree.raw.setCalc(this.handle, prop, v.px, v.percent);
      return;
    }
    const [kind, n] = length(v);
    this.tree.raw.setLength(this.handle, prop, kind, n);
  }

  setDisplay(v: LayoutDisplay): void { this.e(E.display, DISPLAY[v]); }
  setFlexDirection(v: LayoutFlexDirection): void { this.e(E.flexDirection, DIRECTION[v]); }
  setJustifyContent(v: LayoutContent): void { this.e(E.justifyContent, CONTENT[v] ?? CONTENT["flex-start"]); }
  setAlignItems(v: LayoutItems): void { this.e(E.alignItems, ITEMS[v] ?? ITEMS.normal); }
  setAlignSelf(v: LayoutItems | "auto"): void { this.e(E.alignSelf, ITEMS[v] ?? ITEMS.auto); }
  setAlignContent(v: LayoutContent): void { this.e(E.alignContent, CONTENT[v] ?? CONTENT.normal); }
  setJustifyItems(v: LayoutItems): void { this.e(E.justifyItems, ITEMS[v] ?? ITEMS.normal); }
  setJustifySelf(v: LayoutItems | "auto"): void { this.e(E.justifySelf, ITEMS[v] ?? ITEMS.auto); }
  setFlexWrap(v: LayoutWrap): void { this.e(E.flexWrap, WRAP[v]); }
  setPosition(v: LayoutPosition): void { this.e(E.position, POSITION[v]); }
  /** `overflow` on both axes, or `overflow-x` and `overflow-y`. */
  setOverflow(x: LayoutOverflow, y: LayoutOverflow = x): void {
    this.e(E.overflowX, OVERFLOW[x]);
    this.e(E.overflowY, OVERFLOW[y]);
  }
  /** `direction`. Taffy doesn't inherit it: set each node's resolved direction. */
  setDirection(v: "ltr" | "rtl"): void { this.e(E.direction, v === "rtl" ? 1 : 0); }
  setBoxSizing(v: "border-box" | "content-box"): void { this.e(E.boxSizing, v === "content-box" ? 1 : 0); }

  setWidth(v: LayoutLength): void { this.l(L.width, v); }
  setHeight(v: LayoutLength): void { this.l(L.height, v); }
  /** `min-width`; `auto` (or undefined) is the content-based automatic minimum. */
  setMinWidth(v: LayoutLength): void { this.l(L.minWidth, v); }
  setMinHeight(v: LayoutLength): void { this.l(L.minHeight, v); }
  /** `max-width`; `auto` (or undefined) is `none`. */
  setMaxWidth(v: LayoutLength): void { this.l(L.maxWidth, v); }
  setMaxHeight(v: LayoutLength): void { this.l(L.maxHeight, v); }
  setFlexBasis(v: LayoutLength): void { this.l(L.flexBasis, v); }
  setMargin(edge: LayoutEdge, v: LayoutLength): void { this.l(L.margin + EDGE[edge], v); }
  /** Padding; `auto` is 0. */
  setPadding(edge: LayoutEdge, v: LayoutLength): void { this.l(L.padding + EDGE[edge], v); }
  /** A border width; `auto` is 0. */
  setBorder(edge: LayoutEdge, v: LayoutLength): void { this.l(L.border + EDGE[edge], v); }
  /** `top` / `right` / `bottom` / `left`. */
  setInset(edge: LayoutEdge, v: LayoutLength): void { this.l(L.inset + EDGE[edge], v); }
  /** `column-gap` and `row-gap` (`gap: n` sets both). */
  setGap(column: LayoutLength, row: LayoutLength = column): void {
    this.l(L.columnGap, column);
    this.l(L.rowGap, row);
  }
  setFlexGrow(v: number): void { this.tree.raw.setNumber(this.handle, N.flexGrow, v); }
  setFlexShrink(v: number): void { this.tree.raw.setNumber(this.handle, N.flexShrink, v); }
  /** Width over height; undefined (or a non-positive value) unsets it. */
  setAspectRatio(v: number | undefined): void { this.tree.raw.setNumber(this.handle, N.aspectRatio, v ?? NaN); }
  /** The room `overflow: scroll` reserves for a scrollbar (0 by default). */
  setScrollbarWidth(v: number): void { this.tree.raw.setNumber(this.handle, N.scrollbarWidth, v); }

  /** Makes `children` this node's children, in order (each leaves any earlier parent). */
  setChildren(children: readonly LayoutNode[]): void {
    this.tree.raw.setChildren(this.handle, Uint32Array.from(children, (c) => c.handle));
  }

  /** A measured leaf's content changed: it is measured again at the next `compute`. */
  markDirty(): void {
    this.tree.raw.markDirty(this.handle);
  }

  /** The box from the last `compute`. */
  layout(): LayoutBox {
    return this.tree.read(this.handle);
  }

  /** Removes the node from the tree (and from its parent); it can't be used after. */
  free(): void {
    this.tree.forget(this.handle);
    this.tree.raw.remove(this.handle);
  }
}
