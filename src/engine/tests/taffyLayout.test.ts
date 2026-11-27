import { beforeAll, describe, expect, it } from "vitest";
import { LayoutTree, layoutEngineLoaded, loadLayoutEngine, type LayoutNode, type MeasureInput } from "../ui/taffy/layoutTree";

// ADR 0433: the UI core's layout engine (Taffy in WebAssembly), through the adapter's own interface.

beforeAll(async () => {
  await loadLayoutEngine();
});

function tree(): LayoutTree {
  return new LayoutTree();
}

function rect(n: LayoutNode): [number, number, number, number] {
  const b = n.layout();
  return [b.x, b.y, b.width, b.height];
}

describe("layout engine", () => {
  it("loads once and reports it", async () => {
    await loadLayoutEngine();
    expect(layoutEngineLoaded()).toBe(true);
  });

  it("keeps the King of Pirates HUD's bottom bar on screen when the middle panel holds only empty text", () => {
    // Yoga 3.2.1 measures `#lines` as 684 tall here (its fit-content shortcut with no room across) and puts the
    // bottom bar at 760, below the 720 px screen. A browser gives 24 and 640.
    const t = tree();
    const root = t.create();
    root.setWidth(1280);
    root.setHeight(720);
    root.setFlexDirection("column");
    root.setJustifyContent("space-between");
    const top = t.create();
    top.setHeight(40);
    const row = t.create();
    row.setJustifyContent("center");
    const panel = t.create();
    panel.setFlexDirection("column");
    panel.setAlignItems("center");
    for (const e of ["top", "right", "bottom", "left"] as const) panel.setPadding(e, 18);
    const lines = t.create();
    lines.setFlexDirection("column");
    lines.setAlignItems("center");
    const line = t.create();
    line.setWidth(0);
    line.setHeight(24);
    const bottom = t.create();
    bottom.setHeight(80);
    lines.setChildren([line]);
    panel.setChildren([lines]);
    row.setChildren([panel]);
    root.setChildren([top, row, bottom]);
    t.compute(root, 1280, 720);
    expect(rect(root)).toEqual([0, 0, 1280, 720]);
    expect(rect(lines)[3]).toBe(24);
    expect(rect(panel)).toEqual([622, 0, 36, 60]);
    expect(rect(bottom)).toEqual([0, 640, 1280, 80]);
    t.free();
  });

  it("asks a measured leaf for its size with the room it has", () => {
    const t = tree();
    const root = t.create();
    root.setWidth(100);
    root.setAlignItems("flex-start");
    const inputs: MeasureInput[] = [];
    // 300 px of text in 10 px lines; min-content is a 30 px word.
    const text = t.create((input) => {
      inputs.push(input);
      const room = input.knownWidth ?? (input.availableWidth === -Infinity ? 30 : input.availableWidth);
      const width = Math.min(room, 300);
      return { width, height: Math.ceil(300 / width) * 10 };
    });
    root.setChildren([text]);
    t.compute(root);
    expect(rect(text)).toEqual([0, 0, 100, 30]);
    expect(rect(root)).toEqual([0, 0, 100, 30]);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.some((i) => i.availableWidth === 100 || i.knownWidth === 100)).toBe(true);
    t.free();
  });

  it("measures a leaf again only after markDirty", () => {
    const t = tree();
    const root = t.create();
    let size = 10;
    const text = t.create(() => ({ width: size, height: size }));
    root.setChildren([text]);
    root.setAlignItems("flex-start");
    t.compute(root, 200, 200);
    expect(rect(text)).toEqual([0, 0, 10, 10]);
    size = 20;
    t.compute(root, 200, 200);
    expect(rect(text)[2]).toBe(10);
    text.markDirty();
    t.compute(root, 200, 200);
    expect(rect(text)).toEqual([0, 0, 20, 20]);
    t.free();
  });

  it("reads borders, padding, resolved auto margins and overflow", () => {
    const t = tree();
    const root = t.create();
    root.setWidth(300);
    root.setPadding("left", 10);
    root.setBorder("top", 2);
    const child = t.create();
    child.setWidth("50%");
    child.setHeight(20);
    child.setMargin("left", "auto");
    child.setFlexShrink(0);
    const big = t.create();
    big.setWidth(500);
    big.setHeight(10);
    big.setFlexShrink(0);
    root.setChildren([child, big]);
    t.compute(root, 300, 100);
    const r = root.layout();
    expect(r.border).toEqual({ top: 2, right: 0, bottom: 0, left: 0 });
    expect(r.padding.left).toBe(10);
    // 50% of the 290 px content box; the auto margin takes nothing (the big item overflows).
    expect(rect(child)).toEqual([10, 2, 145, 20]);
    expect(child.layout().margin.left).toBe(0);
    expect(r.overflow.right).toBe(655);
    t.free();
  });

  it("places absolute children against their parent's padding box, with insets and percentages", () => {
    const t = tree();
    const root = t.create();
    const parent = t.create();
    parent.setWidth(200);
    parent.setHeight(100);
    parent.setBorder("left", 4);
    const abs = t.create();
    abs.setPosition("absolute");
    abs.setInset("right", 10);
    abs.setInset("top", "10%");
    abs.setWidth(20);
    abs.setHeight(20);
    parent.setChildren([abs]);
    root.setChildren([parent]);
    t.compute(root, 400, 300);
    expect(rect(abs)).toEqual([170, 10, 20, 20]);
    t.free();
  });

  it("lays out wrapping rows with gaps", () => {
    const t = tree();
    const root = t.create();
    root.setWidth(300);
    root.setFlexWrap("wrap");
    root.setAlignContent("flex-start");
    root.setGap(10, 5);
    const kids = [0, 1, 2].map(() => {
      const k = t.create();
      k.setWidth("40%");
      k.setHeight(20);
      return k;
    });
    root.setChildren(kids);
    t.compute(root, 300, 200);
    expect(kids.map(rect)).toEqual([[0, 0, 120, 20], [130, 0, 120, 20], [0, 25, 120, 20]]);
    t.free();
  });

  it("hides display: none nodes and forgets freed ones", () => {
    const t = tree();
    const root = t.create();
    const [a, b, c] = [t.create(), t.create(), t.create()];
    for (const k of [a, b, c]) k.setWidth(30);
    root.setChildren([a, b, c]);
    a.setDisplay("none");
    b.free();
    t.compute(root, 100, 100);
    expect(rect(a)).toEqual([0, 0, 0, 0]);
    expect(rect(c)[0]).toBe(0);
    t.free();
  });

  it("follows rtl direction and reversed flex directions", () => {
    const t = tree();
    const root = t.create();
    root.setWidth(100);
    root.setDirection("rtl");
    const a = t.create();
    a.setWidth(30);
    a.setDirection("rtl");
    root.setChildren([a]);
    t.compute(root, 100, 50);
    expect(rect(a)[0]).toBe(70);
    root.setDirection("ltr");
    root.setFlexDirection("row-reverse");
    t.compute(root, 100, 50);
    expect(rect(a)[0]).toBe(70);
    t.free();
  });

  it("fits an auto-sized root to its content in the room it's given, as CSS does", () => {
    const t = tree();
    const root = t.create();
    const k = t.create();
    k.setWidth(30);
    k.setHeight(10);
    root.setChildren([k]);
    t.compute(root, 300, 200);
    expect(rect(root)).toEqual([0, 0, 30, 10]);
    root.setWidth("100%");
    root.setHeight("100%");
    t.compute(root, 300, 200);
    expect(rect(root)).toEqual([0, 0, 300, 200]);
    t.free();
  });

  it("sizes to content under max-content room", () => {
    const t = tree();
    const root = t.create();
    root.setPadding("top", 5);
    const k = t.create(() => ({ width: 42, height: 7 }));
    root.setChildren([k]);
    t.compute(root);
    expect(rect(root)).toEqual([0, 0, 42, 12]);
    t.free();
  });
});
