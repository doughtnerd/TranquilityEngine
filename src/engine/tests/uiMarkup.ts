import { afterEach } from "vitest";
import { flushSync } from "svelte";
import { Vector2 } from "../core/math";
import { Assets } from "../scene/Assets";
import { GameObject } from "../scene/GameObject";
import { UIAudio, UIButton, UICanvas, UIForm, UIImage, UIInputField, UILabel, UIMeter, UIOption, UIPanel, UIProgress, UIRadio, UISelect, UISlider, UISvg, UIText, UITextArea, UIToggle, UIVideo, type UIComponentType } from "../ui/components";
import { setUIHostStyles, type UIHostElement } from "../ui/host/UIHost";
import { parseStylesheet } from "../ui/document/stylesheet";
import { UIView } from "../../plugins/ui/runtime/UIView";
import * as TreeModule from "../../plugins/ui/runtime/testComponents/Tree.svelte";

// Test helpers that make game UI the one way a game can (ADR 0417, 0419): a `UIView` mounting a Svelte component, through
// the engine's renderer onto the UI core's tree host. The component is a generic one (`testComponents/Tree.svelte`) that
// renders an element tree given as data, so a test writes its tree as HTML markup, as a component's template would be.
// Call `loadUITestSupport()` first (in `beforeEach`, once an Engine exists), so views mount as soon as they're added.

/** One element or piece of text of the markup, as `Tree.svelte` takes it. */
type TreeNode = { text: string } | { tag: string; attributes: Record<string, string>; children: TreeNode[] };

const TREE = "ui/__test-tree.svelte";

function useTreeComponent(): void {
  if (!Assets.has(TREE)) Assets.addSource(Assets.fromObject({ [TREE]: TreeModule }));
}

/**
 * Load what a view needs to mount at once (the UI cascade), by mounting an empty one: views added after this mount in
 * `addBehavior`, so `buildUI` returns a built tree.
 */
export async function loadUITestSupport(): Promise<void> {
  useTreeComponent();
  const node = GameObject.create("UI support");
  const view = node.addBehavior(UIView, { component: `asset:${TREE}`, props: { nodes: [] } });
  await view.ready;
  GameObject.destroy(node);
  node.world.applyDestroys();
}

// --- Markup ---------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );

/** Read well-formed markup (HTML tags, quoted attributes, `<x/>` or `<x></x>`) into tree nodes. Throws on a problem. */
function parseMarkup(markup: string): TreeNode[] {
  const top: TreeNode[] = [];
  const stack: { tag: string; children: TreeNode[] }[] = [{ tag: "", children: top }];
  const tag = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
  let at = 0;
  const text = (to: number) => {
    if (to > at) stack[stack.length - 1].children.push({ text: decode(markup.slice(at, to)) });
  };
  for (let m = tag.exec(markup); m; m = tag.exec(markup)) {
    text(m.index);
    at = tag.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const open = stack.pop();
      if (!open || open.tag !== m[1]) throw new Error(`</${m[1]}> closes <${open?.tag ?? "nothing"}> in: ${markup}`);
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const a of m[3].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attributes[a[1]] = decode(a[2] ?? a[3] ?? "");
    const el = { tag: m[2], attributes, children: [] as TreeNode[] };
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  text(markup.length);
  if (stack.length > 1) throw new Error(`<${stack[stack.length - 1].tag}> isn't closed in: ${markup}`);
  const check = (nodes: readonly TreeNode[], depth: number) => {
    for (const n of nodes) {
      if ("text" in n) continue;
      if (/^[A-Z]/.test(n.tag) && !(depth === 0 && n.tag === "Canvas")) throw new Error(`<${n.tag}>: write HTML tags (div, p, button, input…), as a Svelte component does.`);
      check(n.children, depth + 1);
    }
  };
  check(top, 0);
  return top;
}

/** The canvas settings a `UIView` owns (ADR 0419), from a `<Canvas>` root's attributes. */
const VIEW_FIELDS: Readonly<Record<string, (value: string) => [string, unknown]>> = {
  mode: (v) => ["mode", v],
  "reference-resolution": (v) => {
    const [x, y] = v.trim().split(/[\s,]+/).map(Number);
    return ["referenceResolution", new Vector2(x, y)];
  },
  "match-height": (v) => ["matchHeight", Number(v)],
  "sort-order": (v) => ["sortOrder", Number(v)],
  "pixel-size": (v) => ["pixelSize", Number(v)],
  modal: (v) => ["modal", v === "true" || v === ""],
  "auto-focus": (v) => ["autoFocus", v === "true" || v === ""],
  "first-selected": (v) => ["firstSelected", v],
  player: (v) => ["player", Number(v)],
};

/** The `UIView` fields that are its canvas's settings. */
const VIEW_OWNED: ReadonlySet<string> = new Set(Object.values(VIEW_FIELDS).map((f) => f("0")[0]));

// --- Building ---------------------------------------------------------------------------------------

/** A tree built by `buildUI`: the view, its canvas, and queries over what it rendered. */
export interface TestUI {
  readonly view: UIView;
  /** The view's node. */
  readonly node: GameObject;
  /** The canvas the view made (a `<Canvas>` root's attributes set its fields). */
  readonly root: UIHostElement;
  /** The first rendered element a selector matches (the canvas excluded), or null. */
  query(selector: string): UIHostElement | null;
  queryAll(selector: string): UIHostElement[];
}

/** The rendered children of each view or element `uiElement` added to, by node: their data, which Svelte watches. */
const childLists = new WeakMap<GameObject, { readonly view: UIView; readonly el: UIHostElement; readonly children: TreeNode[] }>();
const canvasIds = new WeakMap<UIHostElement, string>();
const sheets = new Set<string>();
let count = 0;

afterEach(() => {
  for (const file of sheets) setUIHostStyles(file, null);
  sheets.clear();
});

/**
 * Build `markup` (HTML tags, as a component's template; a `<Canvas …>` root stands for the view's canvas, its
 * attributes the view's settings and the canvas's fields) with `css` as the component's styles, in a `UIView` on a new
 * node under `parent` (the active scene when null). Throws on markup or stylesheet problems.
 */
export function buildUI(markup: string, options: { parent?: GameObject | null; css?: string; name?: string } = {}): TestUI {
  const n = ++count;
  useTreeComponent();
  let nodes = parseMarkup(markup);
  const elements = nodes.filter((x) => !("text" in x));
  let canvas: Record<string, string> = {};
  const first = elements[0] as Extract<TreeNode, { tag: string }> | undefined;
  if (elements.length === 1 && first?.tag === "Canvas") {
    canvas = first.attributes;
    nodes = first.children;
  }
  if (options.css !== undefined) {
    const file = `ui/test-${n}.css`;
    const sheet = parseStylesheet(options.css, file);
    if (sheet.problems.length) throw new Error(sheet.problems.map((p) => p.message).join("\n"));
    setUIHostStyles(file, sheet);
    sheets.add(file);
  }
  const init: Record<string, unknown> = { component: `asset:${TREE}`, props: { nodes } };
  const rest = new Map<string, string>();
  for (const [name, value] of Object.entries(canvas)) {
    const field = VIEW_FIELDS[name];
    if (field) {
      const [key, v] = field(value);
      init[key] = v;
    } else rest.set(name, value);
  }
  const node = GameObject.create(options.name ?? "UI", { parent: options.parent ?? null });
  const view = node.addBehavior(UIView, init as never);
  const root = view.root;
  if (!root || !view.exports) throw new Error(`The test view wasn't mounted (is loadUITestSupport() awaited?): ${markup}`);
  if (rest.size) {
    root.tree.setAttributes(root, new Map([...root.attributes, ...rest]));
    root.tree.restyle(root);
  }
  const id = rest.get("id");
  if (id) canvasIds.set(root, id);
  childLists.set(root.node, { view, el: root, children: view.props.nodes as TreeNode[] });
  return {
    view,
    node,
    root,
    query: (selector) => view.query(selector),
    queryAll: (selector) => view.queryAll(selector),
  };
}

/** The element with `id` in `ui` (the canvas too, by a `<Canvas id>`), its component as `type`. */
export function byId<T extends UIComponentType>(ui: TestUI, id: string, type: abstract new () => T): T {
  const el = canvasIds.get(ui.root) === id ? ui.root : ui.query(`#${id}`);
  if (!el) throw new Error(`No element with id "${id}".`);
  return uiAs(el, type);
}

/** An element's component as `type` (throws for another type or no element). */
export function uiAs<T extends UIComponentType>(el: UIHostElement | null | undefined, type: abstract new () => T): T {
  if (!el) throw new Error(`No element (wanted a ${type.name}).`);
  const c = el.component;
  if (!(c instanceof type)) throw new Error(`${el} is a ${c.constructor.name}, not a ${type.name}.`);
  return c;
}

/**
 * An element's classes as a list to change, written through the tree host as the renderer writes a `class` attribute
 * (`class:` directives, a script's `classList`): restyled in the frame's late sync.
 */
export function classList(el: UIHostElement): { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): boolean; contains(name: string): boolean } {
  const write = (names: readonly string[]) => {
    const attributes = new Map(el.attributes);
    if (names.length) attributes.set("class", names.join(" "));
    else attributes.delete("class");
    el.tree.setAttributes(el, attributes);
  };
  const list = {
    add: (...names: string[]) => write([...new Set([...el.classes, ...names])]),
    remove: (...names: string[]) => write(el.classes.filter((c) => !names.includes(c))),
    toggle(name: string, force?: boolean): boolean {
      const on = force ?? !el.classes.includes(name);
      if (on) list.add(name);
      else list.remove(name);
      return on;
    },
    contains: (name: string) => el.classes.includes(name),
  };
  return list;
}

/** Each UI component type as the HTML tag (and attributes) a component writes for it (ADR 0419, 0424, 0426). */
const TAGS = new Map<Function, readonly [string, Record<string, string>]>([
  [UIPanel, ["div", {}]],
  [UIText, ["p", {}]],
  [UIImage, ["img", {}]],
  [UIButton, ["button", {}]],
  [UIInputField, ["input", {}]],
  [UITextArea, ["textarea", {}]],
  [UIToggle, ["input", { type: "checkbox" }]],
  [UIRadio, ["input", { type: "radio" }]],
  [UISlider, ["input", { type: "range" }]],
  [UISelect, ["select", {}]],
  [UIOption, ["option", {}]],
  [UIProgress, ["progress", {}]],
  [UIMeter, ["meter", {}]],
  [UILabel, ["label", {}]],
  [UIForm, ["form", {}]],
  [UISvg, ["svg", {}]],
  [UIVideo, ["video", {}]],
  [UIAudio, ["audio", {}]],
]);

/**
 * One element, its fields then written as a script writes a rendered element's (`(el.component as UIPanel).width = …`).
 * A canvas is a new view's (on a node named `name` under `parent`); any other element is rendered into the view whose
 * canvas or element `parent` is (as the last child), or, under any other node, into a new view there. The element's
 * node is named `name` (its id).
 */
export function uiElement<T extends UIComponentType>(name: string, parent: GameObject | null, type: new () => T, init: Partial<T> = {}): T {
  if ((type as Function) === UICanvas) {
    const ui = buildUI("", { parent, name });
    ui.root.node.name = name;
    // The canvas settings are the view's too (it copies them onto its canvas each frame).
    for (const [key, value] of Object.entries(init)) if (VIEW_OWNED.has(key)) (ui.view as unknown as Record<string, unknown>)[key] = value;
    return Object.assign(uiAs(ui.root, type), init);
  }
  const tag = TAGS.get(type);
  if (!tag) throw new Error(`${type.name} isn't a UI element type.`);
  let list = parent ? childLists.get(parent) : undefined;
  if (!list) list = childLists.get(buildUI("", { parent, name: `${name} view` }).root.node)!;
  list.children.push({ tag: tag[0], attributes: { ...tag[1], id: name }, children: [] });
  flushSync();
  const el = list.el.children.filter((c) => !c.synthetic && c.isValid).at(-1);
  if (!el || el.id !== name) throw new Error(`The element "${name}" wasn't rendered.`);
  childLists.set(el.node, { view: list.view, el, children: (list.children.at(-1) as Extract<TreeNode, { tag: string }>).children });
  return Object.assign(uiAs(el, type), init);
}
