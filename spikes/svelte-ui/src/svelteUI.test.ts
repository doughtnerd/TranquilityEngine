import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { Assets, Color, Engine, Input } from "../../../src/engine/index";
import { World } from "../../../src/engine/core/World";
import { UIButton, UIPanel, UIText } from "../../../src/engine/ui/components";
import { loadUIDocumentSupport, type UIDocument, type UIDocumentElement } from "../../../src/engine/ui/UIDocument";
import type { GameObject } from "../../../src/engine/scene/GameObject";
import { buildUI } from "../../../src/engine/tests/uiMarkup";
import { UIPointer } from "../../../src/engine/tests/uiPointer";
import Hud from "./components/Hud.svelte";
import { render } from "./renderer";
import { reactive } from "./state.svelte";

// Q1 (renderer fit): a Svelte 5 component rendered through the custom renderer into a UI document's
// element, inspected and clicked headlessly the way the engine's own UI document tests are.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  Assets.clearSources();
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.restoreAllMocks();
});

const CSS = `
.shop { background-color: #112233; padding: 8px; }
.shop .title { color: #ffcc00; }
.row { background-color: #333333; width: 200px; height: 40px; }
.row:hover { background-color: #444444; }
.row.picked { background-color: #00ff00; }
.row.dear Text { color: #ff0000; }
.buy { height: 40px; }
`;

function mountHud() {
  const doc = buildUI(`<Canvas><Panel id="slot"/></Canvas>`, { css: CSS });
  const shop = reactive({
    title: "Shop",
    coins: 10,
    items: [
      { id: "a", label: "Apple", price: 2 },
      { id: "b", label: "Bow", price: 3 },
      { id: "c", label: "Crown", price: 50 },
    ],
  });
  const view = render(doc, "#slot", Hud, { shop }, "src/components/Hud.svelte");
  return { doc, shop, view };
}

/** The node tree under `node`, as `Tag#id.class` lines, with a Text's text: what the ECS holds. */
function tree(doc: UIDocument, el: UIDocumentElement, depth = 0): string[] {
  const c = el.component;
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classList.values().filter((n) => !n.startsWith("svelte-")).map((n) => `.${n}`).join("");
  const text = c instanceof UIText ? ` "${c.text}"` : "";
  return [`${"  ".repeat(depth)}${el.tag}${id}${cls}${text}`, ...el.children.map((ch) => tree(doc, ch, depth + 1)).flat()];
}

function nodeNames(node: GameObject): string[] {
  return node.children.map((n) => n.name);
}

describe("Svelte 5 custom renderer → UI document elements", () => {
  it("builds props, $derived, {#if}, keyed {#each}, a child component and a snippet as UI nodes, styled by the document", () => {
    const { doc } = mountHud();
    const slot = doc.query("#slot")!;
    expect(tree(doc, slot)).toEqual([
      "Panel#slot",
      "  Panel#shop.shop",
      '    Text#title.title "Shop (10 left)"',
      '    Text#hint.hint "Pick something"',
      "    Button#item-a.row",
      '      Text "Apple"',
      '      Text.price "2g"',
      "    Button#item-b.row",
      '      Text "Bow"',
      '      Text.price "3g"',
      "    Button#item-c.row.dear",
      '      Text "Crown"',
      '      Text.price "50g"',
      "    Button#buy.buy",
      '      Text "Buy"',
      '    Text#footer.footer "Bought 0"',
    ]);
    // The ECS node tree has the same shape and order (comments and whitespace text never become nodes).
    expect(nodeNames(slot.node)).toEqual(["shop"]);
    expect(nodeNames(doc.query("#shop")!.node)).toEqual(["title", "hint", "item-a", "item-b", "item-c", "buy", "footer"]);

    // Attributes convert as markup attributes do; the document's stylesheet applies through class and descendants.
    const shop = doc.query("#shop")!.as(UIPanel);
    expect(shop.flexDirection).toBe("column");
    expect(shop.gap).toBe(4);
    expect(shop.padding).toBe(8);
    expect(shop.backgroundColor).toEqual(Color.from("#112233"));
    const title = doc.query("#title")!.as(UIText);
    expect(title.fontSize).toBe(24); // `font-size={24}`: a number, passed as text to the cascade
    expect(title.color).toEqual(Color.from("#ffcc00"));
    expect(doc.query("#item-c Text")!.as(UIText).color).toEqual(Color.from("#ff0000")); // class:dear → `.row.dear Text`
    expect(doc.query("#buy")!.as(UIButton).width).toBe("80"); // `style:width` → the style attribute → attribute-level
    expect(doc.queryAll(".row")).toHaveLength(3); // ui.query sees hosted elements
  });

  it("routes clicks from the UI core to onclick, and shows state changes in the same frame", async () => {
    const { doc } = mountHud();
    pointer = await UIPointer.create(World.require());
    const events: string[] = [];
    const bowButton = doc.query("#item-b")!;
    const bowNode = bowButton.node;
    bowButton.on("click", (e) => events.push(`script saw ${e.type} on ${e.element.id}`)); // a script's handler on a hosted element

    pointer.click(bowButton.as(UIButton));
    engine.step(DT);
    // onclick ran (selected = "b"), Svelte flushed before the documents' late sync, the cascade restyled.
    expect(doc.query("#title")!.as(UIText).text).toBe("Shop (7 left)");
    expect(doc.query("#hint")).toBeNull(); // {#if} branch removed
    expect(bowButton.classList.contains("picked")).toBe(true); // class:picked
    expect(bowButton.as(UIButton).backgroundColor).toEqual(Color.from("#00ff00"));
    expect(doc.query("#item-a")!.classList.contains("picked")).toBe(false);
    expect(bowButton.node).toBe(bowNode); // updated in place, not rebuilt
    expect(nodeNames(doc.query("#shop")!.node)).toEqual(["title", "item-a", "item-b", "item-c", "buy", "footer"]);

    engine.step(DT); // a frame between clicks (the engine's own markup buttons drop a click in the very next frame too)
    pointer.click(doc.query("#buy")!.as(UIButton));
    engine.step(DT);
    expect(doc.query("#footer")!.as(UIText).text).toBe("Bought 1"); // the snippet's argument
    expect(doc.query("#buy")!.as(UIButton).width).toBe("90");
    expect(events).toEqual(["script saw click on item-b"]);
  });

  it("follows prop changes: keyed reorders move the same nodes, removals destroy them, additions build them", () => {
    const { doc, shop } = mountHud();
    const nodes = Object.fromEntries(["a", "b", "c"].map((id) => [id, doc.query(`#item-${id}`)!.node]));

    shop.items = [shop.items[2], shop.items[0], shop.items[1]];
    flushSync();
    expect(nodeNames(doc.query("#shop")!.node)).toEqual(["title", "hint", "item-c", "item-a", "item-b", "buy", "footer"]);
    expect(doc.query("#item-c")!.node).toBe(nodes.c); // moved, not remade
    expect(doc.queryAll(".row").map((e) => e.id)).toEqual(["item-c", "item-a", "item-b"]); // element tree order too

    shop.items = shop.items.filter((i) => i.id !== "a");
    shop.items.push({ id: "d", label: "Dagger", price: 4 });
    shop.title = "Store";
    flushSync();
    expect(nodes.a.isValid).toBe(false);
    expect(nodeNames(doc.query("#shop")!.node)).toEqual(["title", "hint", "item-c", "item-b", "item-d", "buy", "footer"]);
    expect(doc.query("#item-d Text")!.as(UIText).text).toBe("Dagger");
    expect(doc.query("#title")!.as(UIText).text).toBe("Store (10 left)");

    shop.coins = 100; // class:dear off → `.row.dear Text` stops matching once the late sync restyles
    flushSync();
    engine.step(DT);
    expect(doc.query("#item-c")!.classList.contains("dear")).toBe(false);
    expect(doc.query("#item-c Text")!.as(UIText).color).toEqual(Color.white);
  });

  it("unmounts to an empty host", () => {
    const { doc, view } = mountHud();
    const shopNode = doc.query("#shop")!.node;
    view.unmount();
    flushSync();
    expect(shopNode.isValid).toBe(false);
    expect(doc.query("#slot")!.children).toHaveLength(0);
    expect(view.tree.size).toBe(0);
  });

  it("loses the hosted tree when the document rebuilds (no static paths): the plugin must mount again", () => {
    const { doc, view } = mountHud();
    doc.reload();
    expect(doc.query("#shop")).toBeNull();
    expect(view.tree.alive).toBe(true); // the host element is reused by path, but its hosted children are gone
  });
});

describe("element refs and two-way input without bind:", () => {
  it("an attachment receives the renderer node (whose hosted element a plugin can expose); value + oninput replace bind:value", async () => {
    const { default: Field } = await import("./components/Field.svelte");
    const doc = buildUI(`<Canvas><Panel id="slot"/></Canvas>`);
    let seen: unknown = null;
    render(doc, "#slot", Field, { onelement: (n: unknown) => (seen = n) });
    expect((seen as { hosted: UIDocumentElement }).hosted).toBe(doc.query("#name"));
    expect(doc.query("#name")!.value).toBe("Ada");
    expect(doc.query("#echo")!.as(UIText).text).toBe("Hello Ada");
    // The player typing: the UI core sets the value and logs a change; the document dispatches it next frame.
    // Driven here through the element's own handler layer, as `_collectEvents` would call it.
    const field = doc.query("#name")!;
    field.value = "Bea";
    for (const h of field._handlers.get("change") ?? []) h({ type: "change", element: field, document: doc, item: undefined }); // INTERNAL
    flushSync();
    expect(doc.query("#echo")!.as(UIText).text).toBe("Hello Bea");
  });
});

describe("rough cost (this container, not a budget)", () => {
  it("mounts and updates 200 keyed rows vs ui.list() with 200 rows", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}`, price: i }));
    const time = (fn: () => void) => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    const runs: Record<string, number[]> = { svelteMount: [], svelteReverse: [], listMount: [], listReverse: [] };
    for (let k = 0; k < 5; k++) {
      const doc = buildUI(`<Canvas><Panel id="slot"/><Panel id="rows"><Template><Button class="row">{label}<Text class="price">{price}g</Text></Button></Template></Panel></Canvas>`, { css: CSS });
      const shop = reactive({ title: "Shop", coins: 10, items: [...items] });
      runs.svelteMount.push(time(() => render(doc, "#slot", Hud, { shop })));
      runs.svelteReverse.push(time(() => {
        shop.items = [...shop.items].reverse();
        flushSync();
      }));
      runs.listMount.push(time(() => doc.list("#rows", items, undefined, { key: "id" })));
      runs.listReverse.push(time(() => doc.list("#rows", [...items].reverse(), undefined, { key: "id" })));
      expect(doc.queryAll(".row")).toHaveLength(400);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log(`\n### 200 rows, median of 5 (ms)\n${JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, +median(v).toFixed(2)])))}`);
  });
});
