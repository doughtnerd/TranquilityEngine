import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject, Input } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIButton, UICanvas, UIInputField, UIPanel, UIText } from "../../../engine/ui/components";
import { UIPointer, stubDocument } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import type { UIViewElement } from "./index";
import * as HudModule from "./testComponents/Hud.svelte";
import * as FormModule from "./testComponents/Form.svelte";
import * as PriceModule from "./testComponents/Price.svelte";
import * as FaderModule from "./testComponents/Fader.svelte";

// ADR 0419 wave A: game UI as Svelte components, mounted by `UIView` through the engine's renderer onto the
// UI core's external tree host. Components compile in the test run (vitest.config.mts's `svelteUI()`), as the
// editor and export will; a compiled module is the asset value of its `.svelte` path.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "ui/hud.svelte": HudModule, "ui/form.svelte": FormModule, "ui/price.svelte": PriceModule, "ui/fader.svelte": FaderModule }));
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const items = () => [
  { id: "a", label: "Apple", price: 2 },
  { id: "b", label: "Bow", price: 3 },
  { id: "c", label: "Crown", price: 50 },
];

async function view(component: string, props: Record<string, unknown>, init: { sortOrder?: number } = {}): Promise<UIView> {
  const node = GameObject.create("UI");
  const v = node.addBehavior(UIView, { component: `asset:${component}`, props, ...init });
  await v.ready;
  return v;
}

/** The rendered tree under `el`, as `tag#id.class "text"` lines (Svelte's hash classes left out). */
function tree(el: UIViewElement, depth = 0): string[] {
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classes.filter((n) => !n.startsWith("svelte-")).map((n) => `.${n}`).join("");
  const c = el.component;
  const text = c instanceof UIText ? ` "${c.text}"` : "";
  return [`${"  ".repeat(depth)}${el.tag}${id}${cls}${text}`, ...el.children.flatMap((ch) => tree(ch, depth + 1))];
}

describe("UIView", () => {
  it("renders HTML tags as UI elements under a canvas it makes, styled by the component's scoped and global CSS", async () => {
    const v = await view("ui/hud.svelte", { shop: { title: "Shop", coins: 10, items: items() } }, { sortOrder: 3 });
    expect(tree(v.root!)).toEqual([
      "Canvas",
      "  section#shop.shop",
      '    h1#title.title "Shop (10 left)"',
      '    p#hint "Pick something"', // `<b>` inside a Text is part of its text
      "    button#item-a.row",
      '      #text "Apple"',
      '      span.price "2g"',
      "    button#item-b.row",
      '      #text "Bow"',
      '      span.price "3g"',
      "    button#item-c.row.dear",
      '      #text "Crown"',
      '      span.price "50g"',
      "    button#buy",
      '      #text "Buy"',
      '    p#footer.themed "Bought 0"',
    ]);
    // The canvas is the view's: its settings come from the view's fields; the node tree is the UI tree.
    const canvas = v.root!.as(UICanvas);
    expect(canvas.sortOrder).toBe(3);
    expect(v.root!.node.parent).toBe(v.node);
    expect(v.query("#shop")!.node.children.map((n) => n.name)).toEqual(["title", "hint", "item-a", "item-b", "item-c", "buy", "footer"]);

    // Tags map onto UI elements; attributes are fields; the scoped <style> applies through Svelte's hash classes.
    const shop = v.query("#shop")!.as(UIPanel);
    expect(shop.flexDirection).toBe("column");
    expect(shop.gap).toBe(4);
    expect(shop.padding).toBe(8);
    expect(shop.backgroundColor).toEqual(Color.from("#112233"));
    expect(v.query("#title")!.as(UIText).fontSize).toBe(24);
    expect(v.query("#title")!.as(UIText).color).toEqual(Color.from("#ffcc00"));
    expect(v.query("#item-c span")!.as(UIText).color).toEqual(Color.from("#ff0000")); // class:dear
    expect(v.query("#item-a")!.as(UIButton).height).toBe("40"); // a tag selector, `button`, scoped by :where()
    expect(v.query("#buy")!.as(UIButton).width).toBe("80"); // style:width → the inline style
    expect(v.query("#footer")!.as(UIText).color).toEqual(Color.from("#abcdef")); // :global(:root) variable through :global(.themed)
    expect(v.queryAll("button.row")).toHaveLength(3);
  });

  it("routes UI core clicks to onclick and shows the result in the same frame", async () => {
    const v = await view("ui/hud.svelte", { shop: { title: "Shop", coins: 10, items: items() } });
    pointer = await UIPointer.create(World.require());
    const bow = v.query("#item-b")!;
    const bowNode = bow.node;
    pointer.click(bow.as(UIButton));
    engine.step(DT);
    expect(v.query("#title")!.as(UIText).text).toBe("Shop (7 left)");
    expect(v.query("#hint")).toBeNull();
    expect(bow.classes).toContain("picked");
    expect(bow.as(UIButton).backgroundColor).toEqual(Color.from("#00ff00"));
    expect(bow.node).toBe(bowNode);

    engine.step(DT);
    pointer.click(v.query("#buy")!.as(UIButton));
    engine.step(DT);
    expect(v.query("#footer")!.as(UIText).text).toBe("Bought 1");
    expect(v.query("#buy")!.as(UIButton).width).toBe("90");
  });

  it("follows props: keyed reorders move the same nodes, removals destroy them, additions build them", async () => {
    const v = await view("ui/hud.svelte", { shop: { title: "Shop", coins: 10, items: items() } });
    const shop = v.props.shop as { title: string; coins: number; items: ReturnType<typeof items> };
    const nodes = Object.fromEntries(["a", "b", "c"].map((id) => [id, v.query(`#item-${id}`)!.node]));

    shop.items = [shop.items[2], shop.items[0], shop.items[1]];
    engine.step(DT);
    expect(v.query("#shop")!.node.children.map((n) => n.name)).toEqual(["title", "hint", "item-c", "item-a", "item-b", "buy", "footer"]);
    expect(v.query("#item-c")!.node).toBe(nodes.c);
    expect(v.queryAll(".row").map((e) => e.id)).toEqual(["item-c", "item-a", "item-b"]);

    shop.items = shop.items.filter((i) => i.id !== "a");
    shop.items.push({ id: "d", label: "Dagger", price: 4 });
    shop.title = "Store";
    engine.step(DT);
    expect(nodes.a.isValid).toBe(false);
    expect(v.query("#shop")!.node.children.map((n) => n.name)).toEqual(["title", "hint", "item-c", "item-b", "item-d", "buy", "footer"]);
    expect(v.query("#title")!.as(UIText).text).toBe("Store (10 left)");

    // A whole prop replaced through the view: class:dear goes off, and the restyle shows it the same frame.
    v.props.shop = { ...shop, coins: 100 };
    engine.step(DT);
    expect(v.query("#item-c")!.classes).not.toContain("dear");
    expect(v.query("#item-c span")!.as(UIText).color).toEqual(Color.white);
  });

  it("binds an input's value both ways and delivers input, change, submit, focus, blur, pointerenter and pointerleave", async () => {
    const log: string[] = [];
    let node: { value: string; tagName: string; element: UIViewElement | null; getBoundingClientRect(): { width: number } } | null = null;
    const dom = stubDocument();
    const v = await view("ui/form.svelte", { log: (s: string) => log.push(s), onnode: (n: never) => (node = n) });
    pointer = await UIPointer.create(World.require());
    const name = v.query("#name")!;
    expect(name.as(UIInputField).value).toBe("Ada"); // bind:value pushed the state
    expect(name.as(UIInputField).placeholder).toBe("Your name");
    expect(v.query("#echo")!.as(UIText).text).toBe("Hello Ada");
    engine.step(DT);
    // bind:this gives the renderer's node, with an Element subset over the hosted element.
    expect(node!.tagName).toBe("INPUT");
    expect(node!.element).toBe(name);
    expect(node!.getBoundingClientRect().width).toBeGreaterThan(0);

    // The player focuses the field, types and presses Enter.
    name.as(UIInputField).focused = true;
    pointer.sync();
    dom.typeText("Bea");
    engine.step(DT);
    expect(log).toEqual(["input Bea"]);
    expect(v.query("#echo")!.as(UIText).text).toBe("Hello Bea"); // the state followed, same frame
    dom.emit("keydown", { key: "Enter" });
    engine.step(DT);
    expect(log).toEqual(["input Bea", "change Bea", "submit"]);

    // The script side of the binding: the button clears the state, and the field follows.
    log.length = 0;
    pointer.hover(v.query("#reset")!.as(UIButton));
    engine.step(DT);
    pointer.click(v.query("#reset")!.as(UIButton));
    engine.step(DT);
    expect(name.as(UIInputField).value).toBe("");
    pointer.leave();
    engine.step(DT);
    expect(log).toContain("enter");
    expect(log).toContain("blur"); // the press took focus from the field
    expect(log.at(-1)).toBe("leave");
  });

  it("re-renders when props change from a script, unmounts on disable, mounts fresh on enable, and remounts on a new component version", async () => {
    const v = await view("ui/hud.svelte", { shop: { title: "Shop", coins: 10, items: items() } });
    (v.props.shop as { title: string }).title = "Bazaar";
    engine.step(DT);
    expect(v.query("#title")!.as(UIText).text).toBe("Bazaar (10 left)");

    const canvasNode = v.root!.node;
    v.enabled = false;
    expect(canvasNode.isValid).toBe(false);
    expect(v.query("#title")).toBeNull();
    v.enabled = true;
    await v.ready;
    expect(v.query("#title")!.as(UIText).text).toBe("Bazaar (10 left)"); // props kept

    // Hot reload: the asset's value changes (a recompiled module); the view mounts the new one that frame.
    const before = v.query("#shop")!.node;
    Assets.addSource(Assets.fromObject({ "ui/hud.svelte": { ...HudModule } }));
    engine.step(DT);
    expect(before.isValid).toBe(false);
    expect(v.query("#title")!.as(UIText).text).toBe("Bazaar (10 left)");

    const canvas = v.root!.node;
    GameObject.destroy(v.node);
    engine.step(DT);
    expect(v.query("#title")).toBeNull();
    expect(canvas.isValid).toBe(false);
  });

  it("still refuses UI components from addComponent", () => {
    expect(() => GameObject.create("X").addComponent(UIPanel)).toThrow(/UIView/);
  });

  it("hears a stylesheet transition's end through ontransitionend (ADR 0418 wave 4)", async () => {
    const ended: string[] = [];
    const v = await view("ui/fader.svelte", { on: false, ended: (name: string) => ended.push(name) });
    engine.step(DT);
    v.props = { on: true, ended: (name: string) => ended.push(name) };
    for (let i = 0; i < 20 && ended.length === 0; i++) engine.step(DT);
    expect(ended).toEqual(["opacity"]);
    const box = v.root!.children.find((c) => c.id === "box")!;
    expect((box.component as UIPanel).opacity).toBe(1);
  });
});
