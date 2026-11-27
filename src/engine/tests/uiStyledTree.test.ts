// ADR 0438: the styled tree, driven through its own interface (what the UI host calls), with a small host of plain
// elements: what restyles when, per sheet set; node references; and the generated `::before`/`::after` it asks its host
// for. The host-level and Svelte-level behaviour (selectors, `:has()`, units, pseudo-elements, animation) stays tested
// through views (`uiSelectors`, `uiHasAndUnits`, `uiPseudoElements`, `uiAnimation`…).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Engine } from "../index";
import { World } from "../core/World";
import { GameObject } from "../scene/GameObject";
import { UIButton, UICanvas, UIPanel, UIText, type UIComponentType } from "../ui/components";
import { uiTypeOfTag } from "../ui/elementKinds";
import { parseStylesheet } from "../ui/document/stylesheet";
import { UIStyledTree, type UIElementStyle, type UIStyledNode, type UIStyledTreeHost } from "../ui/document/styledTree";
import type { UIStylesheet, UITag } from "../ui/document/types";

let engine: Engine;

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  engine.dispose();
  vi.restoreAllMocks();
});

/** A plain element, as a host keeps one. */
class Element implements UIStyledNode<Element> {
  _style!: UIElementStyle<Element>;
  _alive = true;
  parent: Element | null = null;
  children: Element[] = [];
  attributes: ReadonlyMap<string, string> = new Map();
  readonly source = null;
  constructor(
    readonly tag: string,
    readonly uiTag: UITag,
    readonly node: GameObject,
    readonly component: UIComponentType,
    readonly synthetic = false,
  ) {}
}

/** A host of plain elements over one World, recording what the styled tree asked of it. */
class Host implements UIStyledTreeHost<Element> {
  readonly world = World.require();
  readonly file = "ui/test.svelte";
  readonly sheets = { version: 0, files: new Map<string, UIStylesheet>() };
  readonly asked: string[] = [];
  readonly root: Element;
  readonly styles: UIStyledTree<Element>;

  constructor(css = "") {
    this.setCss(css);
    const node = this.world._createNode("Canvas", GameObject.create("View").entity);
    this.root = new Element("Canvas", "Canvas", node, this.world._addComponent(node.entity, UICanvas));
    this.styles = new UIStyledTree(this, this.root);
  }

  setCss(css: string): void {
    this.sheets.files.set("ui/test.css", parseStylesheet(css, "ui/test.css"));
    this.sheets.version++;
  }

  /** Make an element under `parent` (the canvas), as the host's `create` does; not styled yet. */
  make(tag: string, uiTag: UITag, attributes: Record<string, string> = {}, parent: Element = this.root): Element {
    const node = this.world._createNode(tag, parent.node.entity);
    const el = new Element(tag, uiTag, node, this.world._addComponent(node.entity, uiTypeOfTag(uiTag)));
    el.parent = parent;
    el.attributes = new Map(Object.entries(attributes));
    this.styles.attach(el, el.attributes);
    parent.children.push(el);
    this.styles.inserted(el, true);
    return el;
  }

  setAttributes(el: Element, attributes: Record<string, string>): void {
    el.attributes = new Map(Object.entries(attributes));
    this.styles.attributesChanged(el, el.attributes);
  }

  remove(el: Element): void {
    const parent = el.parent!;
    parent.children.splice(parent.children.indexOf(el), 1);
    el._alive = false;
    this.styles.removed(el, parent);
  }

  makeGenerated(origin: Element, which: "before" | "after", uiTag: UITag): Element {
    this.asked.push(`make ::${which} ${uiTag}`);
    const node = this.world._createNode(`::${which}`, origin.node.entity);
    const g = new Element(`::${which}`, uiTag, node, this.world._addComponent(node.entity, uiTypeOfTag(uiTag)), true);
    g.parent = origin;
    return g;
  }

  makeLabel(box: Element, tag: string): Element {
    this.asked.push(`label ${tag}`);
    const node = this.world._createNode(tag, box.node.entity);
    const label = new Element(tag, "Text", node, this.world._addComponent(node.entity, UIText), true);
    label.parent = box;
    box.children = [label];
    return label;
  }

  destroyGenerated(g: Element): void {
    this.asked.push(`destroy ${g.tag}`);
    g._alive = false;
    if (g.parent?.children.includes(g)) g.parent.children = g.parent.children.filter((c) => c !== g);
  }

  changed(): void {}
}

const RED = Color.from("#ff0000");
const BLUE = Color.from("#0000ff");

describe("the styled tree (ADR 0438)", () => {
  it("styles a new subtree on restyle, and an attribute change at the next sync or pending restyle, not before", () => {
    const host = new Host(`.a { background-color: #ff0000 } .b { background-color: #0000ff }`);
    const el = host.make("div", "Panel", { class: "a" });
    host.styles.restyle(el);
    const panel = el.component as UIPanel;
    expect(panel.backgroundColor).toEqual(RED);
    host.setAttributes(el, { class: "b" });
    expect(panel.backgroundColor).toEqual(RED);
    host.styles.restylePending();
    expect(panel.backgroundColor).toEqual(BLUE);
    host.setAttributes(el, { class: "a" });
    host.styles.sync();
    expect(panel.backgroundColor).toEqual(RED);
  });

  it("follows a pseudo-state change at sync, and records the paint states its own rules name (ADR 0437)", () => {
    const host = new Host(`button { background-color: #0000ff } button:disabled { background-color: #ff0000 } button:hover { border-color: #ff0000 }`);
    const el = host.make("button", "Button");
    host.styles.restyle(el);
    const button = el.component as UIButton;
    expect(button.backgroundColor).toEqual(BLUE);
    expect(button._styledStates).toBeNull();
    button.interactable = false;
    expect(button.backgroundColor).toEqual(BLUE);
    host.styles.sync();
    expect(el._style.target.state.disabled).toBe(true);
    expect(button.backgroundColor).toEqual(RED);
  });

  it("restyles the whole tree when the sheets change, with the new sheet set's rules", () => {
    const host = new Host(`div { opacity: 0.5 }`);
    const a = host.make("div", "Panel");
    const b = host.make("div", "Panel", {}, a);
    host.styles.restyle(a);
    expect([(a.component as UIPanel).opacity, (b.component as UIPanel).opacity]).toEqual([0.5, 0.5]);
    host.setCss(`div { opacity: 0.25 }`);
    expect((b.component as UIPanel).opacity).toBe(0.5);
    host.styles.sync();
    expect([(a.component as UIPanel).opacity, (b.component as UIPanel).opacity]).toEqual([0.25, 0.25]);
    host.setCss(``);
    host.styles.sync();
    expect((b.component as UIPanel).opacity).toBe(new UIPanel().opacity); // a field the cascade stops setting goes back
  });

  it("restyles siblings on a tree change when the sheet set has structural selectors", () => {
    const host = new Host(`div:first-child { opacity: 0.5 }`);
    const a = host.make("div", "Panel");
    host.styles.restyle(a);
    expect((a.component as UIPanel).opacity).toBe(0.5);
    const first = host.make("div", "Panel");
    host.root.children.unshift(host.root.children.pop()!); // made before `a`
    host.styles.inserted(first, true);
    host.styles.restyle(first);
    host.styles.sync();
    expect((a.component as UIPanel).opacity).toBe(1);
    expect((first.component as UIPanel).opacity).toBe(0.5);
  });

  it("restyles a :has() anchor when something inside it goes", () => {
    const host = new Host(`.card:has(.badge) { background-color: #ff0000 }`);
    const card = host.make("div", "Panel", { class: "card" });
    const badge = host.make("p", "Text", { class: "badge" }, card);
    host.styles.restyle(card);
    expect((card.component as UIPanel).backgroundColor).toEqual(RED);
    host.remove(badge);
    host.styles.sync();
    expect((card.component as UIPanel).backgroundColor).not.toEqual(RED);
  });

  it("resolves node references by element id in the tree, and clears one whose element goes (ADR 0340)", () => {
    const host = new Host();
    const play = host.make("button", "Button", { id: "play" });
    const quit = host.make("button", "Button", { id: "quit", "nav-up": "#play" });
    host.styles.restyle(host.root);
    expect((quit.component as UIButton).navUp).toBe(play.node);
    host.remove(play);
    host.styles.sync();
    expect((quit.component as UIButton).navUp).toBeNull();
  });

  it("asks its host for ::before/::after and their labels by content, and to destroy them when it goes", () => {
    const host = new Host(`.tag::before { content: "New"; color: #ff0000 } .tag.empty::before { content: "" }`);
    const el = host.make("div", "Panel", { class: "tag" });
    host.styles.restyle(el);
    expect(host.asked).toEqual(["make ::before Panel", "label #text"]);
    const label = el._style.before!.children[0];
    expect((label.component as UIText).text).toBe("New");
    expect((label.component as UIText).color).toEqual(RED); // inherited from the box
    host.setAttributes(el, { class: "tag empty" });
    host.styles.sync();
    expect(host.asked.slice(2)).toEqual(["destroy #text"]);
    expect(el._style.before!.children).toEqual([]);
    host.setAttributes(el, {});
    host.styles.sync();
    expect(host.asked.slice(3)).toEqual(["destroy ::before"]);
    expect(el._style.before).toBeNull();
  });
});
