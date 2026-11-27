import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIPanel, UIText } from "../../../engine/ui/components";
import { UIPointer } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import * as StructureModule from "./testComponents/Structure.svelte";

// ADR 0422 wave 5 through a UIView: structural, attribute and sibling selectors restyle as Svelte adds, removes and
// reorders elements and changes attributes; `calc()` mixing % and px resolves at layout; canvas `@media` and Svelte's
// `MediaQuery` follow the canvas in UI pixels as it's resized (the view's canvas is 1280×720 reference pixels,
// matching height).

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "ui/structure.svelte": StructureModule }));
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.restoreAllMocks();
});

async function view(props: Record<string, unknown>): Promise<UIView> {
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/structure.svelte", props });
  await v.ready;
  return v;
}

async function resize(width: number, height: number): Promise<void> {
  pointer?.dispose();
  pointer = await UIPointer.create(World.require(), width, height);
}

const panel = (v: UIView, id: string) => v.query(`#${id}`)!.as(UIPanel);
/** Each row's id with the fields the row rules set. */
const rows = (v: UIView) =>
  v.queryAll("li").map((el) => {
    const p = el.as(UIPanel);
    return `${el.id} gap=${p.gap} grow=${p.flexGrow} opacity=${p.opacity} shrink=${p.flexShrink ?? "-"} pad=${p.padding}`;
  });

describe("UIView: wave 5 selectors", () => {
  it("restyles structural and sibling selectors when rows are added, removed and reordered", async () => {
    const v = await view({ items: ["a", "b", "c"], flag: "closed" });
    engine.step(DT);
    expect(rows(v)).toEqual([
      "a gap=2 grow=0 opacity=1 shrink=- pad=0",
      "b gap=1 grow=0 opacity=0.5 shrink=3 pad=6",
      "c gap=1 grow=5 opacity=1 shrink=3 pad=0",
    ]);

    v.props.items = ["x", "a", "b", "c"];
    engine.step(DT);
    expect(rows(v)).toEqual([
      "x gap=2 grow=0 opacity=1 shrink=- pad=0",
      "a gap=1 grow=0 opacity=0.5 shrink=3 pad=6",
      "b gap=1 grow=0 opacity=1 shrink=3 pad=6",
      "c gap=1 grow=5 opacity=0.5 shrink=3 pad=0",
    ]);

    v.props.items = ["c", "x", "a"]; // a keyed reorder, with b removed
    engine.step(DT);
    expect(rows(v)).toEqual([
      "c gap=2 grow=0 opacity=1 shrink=- pad=0",
      "x gap=1 grow=0 opacity=0.5 shrink=3 pad=6",
      "a gap=1 grow=5 opacity=1 shrink=3 pad=0",
    ]);
  });

  it("matches attribute selectors against the attributes as written, and restyles the next sibling when one changes", async () => {
    const v = await view({ items: ["a"], flag: "closed" });
    engine.step(DT);
    const after = v.query("#after")!.as(UIText);
    const normal = after.fontSize;
    expect(panel(v, "flag").gap).toBe(0);
    expect(v.query("[data-state=closed]")?.id).toBe("flag"); // queries read `data-*`, which no field takes

    v.props.flag = "open";
    engine.step(DT);
    expect(panel(v, "flag").gap).toBe(7);
    expect(after.fontSize).toBe(30);

    v.props.flag = "shut";
    engine.step(DT);
    expect(panel(v, "flag").gap).toBe(0);
    expect(after.fontSize).toBe(normal);
  });

  it("matches :empty on elements without child elements or text", async () => {
    const v = await view({ items: ["a"], flag: "closed" });
    engine.step(DT);
    expect(panel(v, "flag").opacity).toBe(0.25);
    expect(panel(v, "calc").opacity).toBe(1);
    expect(panel(v, "inner").opacity).toBe(1); // it has text
    expect(v.queryAll(":empty").map((e) => e.id)).toEqual(["flag"]);
  });
});

describe("UIView: calc() and canvas @media", () => {
  it("resolves calc() mixing % and px against the containing box at layout, and again when it changes", async () => {
    const v = await view({ items: ["a"], flag: "closed" });
    await resize(1280, 720);
    engine.step(DT);
    pointer!.sync();
    expect(panel(v, "calc").height).toBe("30");
    expect(v.query("#calc")!.rect()).toMatchObject({ width: 600, height: 30 }); // 50% of 1280, less 40
    expect(v.query("#inner")!.rect()!.width).toBe(580); // 100% of its parent's 600, less 20

    await resize(1600, 720); // the canvas is wider: one relayout picks up the new parent size
    engine.step(DT);
    pointer!.sync();
    expect(v.query("#calc")!.rect()!.width).toBe(760);
    expect(v.query("#inner")!.rect()!.width).toBe(740);
  });

  it("matches @media against the canvas in UI pixels and matches again when it's resized; MediaQuery follows it", async () => {
    const v = await view({ items: ["a"], flag: "closed" });
    await resize(1280, 720);
    engine.step(DT);
    engine.step(DT);
    expect(panel(v, "calc").gap).toBe(9);
    expect(v.query("#media")!.as(UIText).text).toBe("wide landscape");

    await resize(800, 600); // 800×600 scaled to match 720 high: 960×720 UI pixels
    engine.step(DT);
    engine.step(DT);
    expect(panel(v, "calc").gap).toBe(4);
    expect(v.query("#media")!.as(UIText).text).toBe("narrow landscape");

    await resize(600, 800); // 540×720 UI pixels
    engine.step(DT);
    engine.step(DT);
    expect(v.query("#media")!.as(UIText).text).toBe("narrow portrait");
  });
});
