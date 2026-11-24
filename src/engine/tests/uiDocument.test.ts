import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject, Input } from "../index";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../ui/components";
import { UIDocument, UIEvents, type UIEvent } from "../ui/UIDocument";
import { World } from "../core/World";
import { parseBindings, parseMarkup } from "../ui/document/markup";
import { matchSelector, parseStylesheet, resolveStyle } from "../ui/document/stylesheet";
import type { MarkupElement, StyleTarget, UIPseudo, UITag } from "../ui/document/types";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { childPath, documentFile, elementAtPath, elementSource } from "../ui/documentSource";
import { UIPointer, stubDocument } from "./uiPointer";

// ADR 0077: UI documents: markup, stylesheets, the cascade, and the UIDocument runtime.

const noFiles = () => null;

describe("markup", () => {
  it("parses elements, attributes with spans, and text", () => {
    const src = `<Canvas>\n  <Panel id="menu" class="box wide" width=200>\n    <Text>Hello {name}</Text>\n    <Button id="play">Play</Button>\n  </Panel>\n</Canvas>`;
    const m = parseMarkup(src, "ui/menu.ui.xml", noFiles);
    expect(m.problems).toEqual([]);
    const panel = m.root!.children[0];
    expect(panel.tag).toBe("Panel");
    const id = panel.attributes.find((a) => a.name === "id")!;
    expect(src.slice(id.span.start, id.span.end)).toBe(`id="menu"`);
    expect(src.slice(id.valueSpan.start, id.valueSpan.end)).toBe("menu");
    const width = panel.attributes.find((a) => a.name === "width")!;
    expect(src.slice(width.valueSpan.start, width.valueSpan.end)).toBe("200");
    expect(src.slice(panel.openTagSpan.start, panel.openTagSpan.end)).toBe(`<Panel id="menu" class="box wide" width=200>`);
    expect(src.slice(panel.span.start, panel.span.end).endsWith("</Panel>")).toBe(true);
    expect(panel.children.map((c) => c.tag)).toEqual(["Text", "Button"]);
    expect(panel.children[0].text).toBe("Hello {name}");
    expect(panel.children[1].text).toBe("Play");
  });

  it("expands <Use>, collects <Style> paths and keeps <Template> apart", () => {
    const files: Record<string, string> = {
      "ui/widgets/bar.ui.xml": `<Panel class="bar"><Style src="bar.ui.css"/><Text>HP</Text></Panel>`,
      "ui/widgets/bar.ui.css": `.bar { height: 8px; }`,
      "ui/menu.ui.css": ``,
    };
    const read = (p: string) => files[p] ?? null;
    const m = parseMarkup(`<Canvas><Style src="menu.ui.css"/><Use src="widgets/bar.ui.xml" id="hp"/><Panel id="rows"><Template><Text>{label}</Text></Template></Panel></Canvas>`, "ui/menu.ui.xml", read);
    expect(m.problems).toEqual([]);
    const [bar, rows] = m.root!.children;
    expect(bar.from).toBe("ui/widgets/bar.ui.xml");
    expect(bar.file).toBe("ui/widgets/bar.ui.xml");
    expect(bar.attributes.find((a) => a.name === "id")?.value).toBe("hp");
    expect(m.styles).toEqual(["ui/menu.ui.css", "ui/widgets/bar.ui.css"]);
    expect(m.files).toEqual(["ui/menu.ui.xml", "ui/menu.ui.css", "ui/widgets/bar.ui.xml", "ui/widgets/bar.ui.css"]);
    expect(rows.children).toEqual([]);
    expect(rows.template?.tag).toBe("Text");
    expect(rows.template?.text).toBe("{label}");
  });

  it("reports problems without throwing", () => {
    const files: Record<string, string> = { "ui/a.ui.xml": `<Panel><Use src="a.ui.xml"/></Panel>` };
    const m = parseMarkup(`<Canvas><Bogus/><Panel><Text>x</Text><Use src="missing.ui.xml"/><Use src="a.ui.xml"/></Canvas>`, "ui/m.ui.xml", (p) => files[p] ?? null);
    const messages = m.problems.map((p) => p.message).join("\n");
    expect(messages).toMatch(/Unknown element <Bogus>/);
    expect(messages).toMatch(/<Panel> isn't closed/);
    expect(messages).toMatch(/there's no file "ui\/missing.ui.xml"/);
    expect(messages).toMatch(/uses itself/);
    expect(m.problems[0].line).toBe(1);
    expect(m.root?.tag).toBe("Canvas");
  });

  it("collapses text content's whitespace as HTML does, but not &#160; or attributes", () => {
    const m = parseMarkup(`<Canvas><Text>\n   Two  spaces\tand\na line  </Text><Text>a&#160;&#160;b</Text><Text text="keep  these"/></Canvas>`, "ui/t.ui.xml", noFiles);
    const [a, b, c] = m.root!.children;
    expect(a.text).toBe("Two spaces and a line");
    expect(b.text).toBe("a  b");
    expect(c.text).toBeNull();
    expect(c.attributes[0].value).toBe("keep  these");
  });

  it("splits bindings", () => {
    expect(parseBindings("Score: {score}!")).toEqual([{ text: "Score: " }, { binding: "score" }, { text: "!" }]);
    expect(parseBindings("{{literal}} {a.b}")).toEqual([{ text: "{literal} " }, { binding: "a.b" }]);
    expect(parseBindings("{ not a binding")).toEqual([{ text: "{ not a binding" }]);
    expect(parseBindings("")).toEqual([{ text: "" }]);
  });
});

function target(tag: UITag, opts: { id?: string; classes?: string[]; state?: Partial<Record<UIPseudo, boolean>>; parent?: StyleTarget | null } = {}): StyleTarget {
  return { tag, id: opts.id ?? null, classes: opts.classes ?? [], state: { hover: false, pressed: false, focus: false, disabled: false, ...opts.state }, parent: opts.parent ?? null };
}

function element(tag: UITag, attributes: Record<string, string> = {}): MarkupElement {
  const span = { start: 0, end: 0 };
  return { kind: "element", tag, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value, span, valueSpan: span })), children: [], text: null, template: null, span, openTagSpan: span, file: "ui/t.ui.xml" };
}

describe("stylesheets", () => {
  it("parses selectors with specificity and reports what isn't supported", () => {
    const sheet = parseStylesheet(`Panel .a > #b:hover, Text {}\n[x] {}\n@media screen { Panel {} }\nPanel { color: red !important; }`, "ui/s.ui.css");
    const [rule] = sheet.rules;
    expect(rule.selectors).toHaveLength(2);
    expect(rule.selectors[0].specificity).toEqual([1, 2, 1]);
    expect(rule.selectors[0].parts.map((p) => p.combinator)).toEqual([null, " ", ">"]);
    expect(rule.selectorText).toBe("Panel .a > #b:hover, Text");
    const messages = sheet.problems.map((p) => p.message).join("\n");
    expect(messages).toMatch(/Attribute selectors aren't supported/);
    expect(messages).toMatch(/@media isn't supported/);
    expect(messages).toMatch(/!important isn't supported/);
    expect(sheet.rules.at(-1)!.declarations[0].value).toBe("red");
  });

  it("matches descendants, children and pseudo-classes", () => {
    const [desc, child, hover] = parseStylesheet(`Panel Text {} Panel > Text {} Button:hover {}`, "s").rules.map((r) => r.selectors[0]);
    const panel = target("Panel");
    const inner = target("Panel", { parent: panel });
    const text = target("Text", { parent: inner });
    expect(matchSelector(desc, text)).toBe(true);
    expect(matchSelector(child, text)).toBe(true);
    expect(matchSelector(child, target("Text", { parent: target("Button", { parent: panel }) }))).toBe(false);
    expect(matchSelector(hover, target("Button"))).toBe(false);
    expect(matchSelector(hover, target("Button", { state: { hover: true } }))).toBe(true);
  });

  it("matches :lang() against the element's language by BCP 47 prefix, counted like a class (ADR 0356 §4)", () => {
    const sheet = parseStylesheet(`Text:lang(de) {} :lang(zh-Hant) {} Text:lang(de, fr) {}`, "s");
    const [de, hant] = sheet.rules.map((r) => r.selectors[0]);
    expect(de.specificity).toEqual([0, 1, 1]);
    expect(sheet.rules).toHaveLength(2);
    expect(sheet.problems.map((p) => p.message).join("\n")).toMatch(/:lang\(\) takes one language code/);
    const text = (lang?: string) => ({ ...target("Text"), lang });
    expect([matchSelector(de, text("de")), matchSelector(de, text("de-AT")), matchSelector(de, text("DE-at"))]).toEqual([true, true, true]);
    expect([matchSelector(de, text("deu")), matchSelector(de, text("en")), matchSelector(de, text())]).toEqual([false, false, false]);
    expect([matchSelector(hant, text("zh-Hant-TW")), matchSelector(hant, text("zh-Hans"))]).toEqual([true, false]);
  });

  it("cascades by specificity and order, attributes beat rules, text properties inherit, variables resolve", () => {
    const sheet = parseStylesheet(
      `:root { --accent: #ff0000; --gap: 12px; }
       Panel { gap: var(--gap); background-color: blue; color: var(--accent); }
       .card { background-color: rgba(0, 255, 0, 0.5); }
       Panel { padding: 4px; width: 50%; height: 120px; }
       Text { font-size: 20px; }
       .card Text { font-weight: bold; }
       Panel { bogus-thing: 1; }`,
      "ui/s.ui.css",
    );
    expect(sheet.problems).toEqual([]);
    const warnings: string[] = [];
    const panelTarget = target("Panel", { classes: ["card"] });
    const panel = resolveStyle(panelTarget, element("Panel", { padding: "8", class: "card" }), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(panel.get("gap")?.value).toBe(12);
    expect(panel.get("backgroundColor")?.value).toEqual(new Color(0, 1, 0, 0.5)); // .card beats Panel
    expect(panel.get("padding")?.value).toBe(8); // the attribute beats the rule
    expect(panel.get("padding")?.source.kind).toBe("attribute");
    expect(panel.get("width")?.value).toBe("50%");
    expect(panel.get("height")?.value).toBe("120");
    const bg = panel.get("backgroundColor")!.source;
    expect(bg.kind === "rule" && bg.rule.selectorText).toBe(".card");
    expect(warnings.join()).toMatch(/unknown property "bogus-thing"/);

    const text = resolveStyle(target("Text", { parent: panelTarget }), element("Text"), UIText, [sheet], panel, () => {});
    expect(text.get("color")?.value).toEqual(new Color(1, 0, 0, 1)); // inherited from the Panel, which has no color field
    expect(text.get("color")?.source.kind).toBe("inherited");
    expect(text.get("fontSize")?.value).toBe(20);
    expect(text.get("fontWeight")?.value).toBe("bold");
    expect(text.has("gap")).toBe(false); // layout properties don't inherit
  });

  it("takes display, and position as an alias of position-type, from rules and attributes", () => {
    const sheet = parseStylesheet(`.veil { position: absolute; display: none; } .shown { display: flex; } .flow { position-type: relative; }`, "ui/s.ui.css");
    const warnings: string[] = [];
    const veil = resolveStyle(target("Panel", { classes: ["veil"] }), element("Panel"), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(veil.get("positionType")?.value).toBe("absolute");
    expect(veil.get("display")?.value).toBe("none");
    const shown = resolveStyle(target("Panel", { classes: ["veil", "shown"] }), element("Panel"), UIPanel, [sheet], null, () => {});
    expect(shown.get("display")?.value).toBe("flex"); // later rule, same specificity
    const attrs = resolveStyle(target("Panel", { classes: ["flow"] }), element("Panel", { position: "absolute", display: "none" }), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(attrs.get("positionType")?.value).toBe("absolute"); // the attribute beats the rule
    expect(attrs.get("positionType")?.source.kind).toBe("attribute");
    expect(attrs.get("display")?.value).toBe("none");
    resolveStyle(target("Panel"), element("Panel", { display: "block" }), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(warnings).toEqual([expect.stringMatching(/"block" isn't a valid display/)]);
  });

  it("leaves out values that don't convert, and warns", () => {
    const sheet = parseStylesheet(`Panel { padding: lots; flex-direction: sideways; border-color: var(--nope); }`, "s");
    const warnings: string[] = [];
    const out = resolveStyle(target("Panel"), element("Panel"), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(out.has("padding")).toBe(false);
    expect(out.has("flexDirection")).toBe(false);
    expect(out.has("borderColor")).toBe(false);
    expect(warnings).toHaveLength(3);
  });
});

// --- The runtime --------------------------------------------------------------------------------

const DT = 1 / 60;
let engine: Engine;
let files: Record<string, unknown>;
let pointers: UIPointer[] = [];

beforeEach(async () => {
  Input.reset();
  files = {};
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
});

afterEach(() => {
  for (const p of pointers.splice(0)) p.dispose();
  vi.unstubAllGlobals();
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.restoreAllMocks();
});

/** A UI core laying out and routing the World's UI, as the renderer's does: clicks and hovers go through it. */
async function pointer(): Promise<UIPointer> {
  const p = await UIPointer.create(World.require());
  pointers.push(p);
  return p;
}

async function open(path = "ui/menu.ui.xml"): Promise<UIDocument> {
  const node = GameObject.create("UI");
  const doc = node.addBehavior(UIDocument, { document: `asset:${path}` });
  await doc.ready;
  return doc;
}

const MENU = `<Canvas>
  <Style src="menu.ui.css"/>
  <Panel id="menu" class="column">
    <Text id="title">Score: {score}</Text>
    <Button id="play" class="primary">Play</Button>
    <InputField id="name" placeholder="Your name"/>
    <Panel id="rows"><Template><Text class="row">{label} ({n})</Text></Template></Panel>
  </Panel>
</Canvas>`;
const MENU_CSS = `:root { --fg: #ffffff; }
.column { flex-direction: column; gap: 8px; color: var(--fg); }
.primary { background-color: #336699; }
.primary:hover { background-color: #4477aa; }
.primary:hover Text { color: #ffff00; }
.big { font-size: 40px; }
.row { font-size: 12px; }`;

describe("UIDocument", () => {
  beforeEach(() => {
    files["ui/menu.ui.xml"] = MENU;
    files["ui/menu.ui.css"] = MENU_CSS;
  });

  it("builds the elements as child nodes, styled", async () => {
    const doc = await open();
    expect(doc.problems).toEqual([]);
    const canvas = doc.node.children[0];
    expect(canvas.getBehavior(UICanvas)).not.toBeNull();
    const menu = doc.query("#menu")!;
    expect(menu.node.name).toBe("menu");
    expect(menu.as(UIPanel).flexDirection).toBe("column");
    expect(menu.as(UIPanel).gap).toBe(8);
    const play = doc.query("Button.primary")!;
    expect(play.as(UIButton).backgroundColor).toEqual(Color.from("#336699"));
    expect(play.as(UIButton).hoverColor).toEqual(Color.from("#4477aa")); // from the :hover rule
    const label = play.query("Text")!;
    expect(label.as(UIText).text).toBe("Play");
    expect(label.as(UIText).color).toEqual(Color.white); // inherited from .column through the button
    expect(doc.queryAll("Text").map((e) => e.id)).toEqual(["title", null]);
    expect(() => play.as(UIText)).toThrow(/is a UIButton, not a UIText/);
  });

  it("follows data bindings each frame", async () => {
    const doc = await open();
    const title = doc.query("#title")!.as(UIText);
    expect(title.text).toBe("Score: {score}"); // no value yet: left as written
    doc.data.score = 10;
    engine.step(DT);
    expect(title.text).toBe("Score: 10");
    doc.data.score = 20;
    engine.step(DT);
    expect(title.text).toBe("Score: 20");
  });

  it("restyles when classes change", async () => {
    const doc = await open();
    const title = doc.query("#title")!;
    title.classList.add("big");
    engine.step(DT);
    expect(title.as(UIText).fontSize).toBe(40);
    title.classList.remove("big");
    engine.step(DT);
    expect(title.as(UIText).fontSize).toBe(16); // back to the default
  });

  it("hides elements with display: none from a class, and shows them again, their nodes staying active", async () => {
    files["ui/screens.ui.xml"] = `<Canvas><Style src="screens.ui.css"/>
      <Panel id="home"><Button id="go">Go</Button></Panel>
      <Panel id="room" class="hidden"><Text id="who">Crew</Text></Panel>
      <Button id="hover-hide">x</Button>
    </Canvas>`;
    files["ui/screens.ui.css"] = `.hidden { display: none; } #hover-hide:hover { display: none; }`;
    const doc = await open("ui/screens.ui.xml");
    expect(doc.problems).toEqual([]);
    const room = doc.query("#room")!;
    expect(room.as(UIPanel).display).toBe("none");
    expect(room.node.activeInHierarchy).toBe(true);
    expect(doc.query("#who")!.as(UIText).display).toBe("flex"); // its children keep theirs: the parent's hides them
    room.classList.remove("hidden");
    doc.query("#home")!.classList.add("hidden");
    engine.step(DT);
    expect(room.as(UIPanel).display).toBe("flex");
    expect(doc.query("#home")!.as(UIPanel).display).toBe("none");
    // A pseudo-class can toggle it too.
    const hoverHide = doc.query("#hover-hide")!.as(UIButton);
    (await pointer()).hover(hoverHide);
    engine.step(DT);
    expect(hoverHide.display).toBe("none");
  });

  it("takes raycastTarget as an attribute or a raycast-target property, and the pointer then passes the element (ADR 0385)", async () => {
    files["ui/hud.ui.xml"] = `<Canvas><Style src="hud.ui.css"/>
      <Text id="score" width="200" height="40">Score</Text>
      <Text id="hint" raycastTarget="false" width="200" height="40">Hint</Text>
      <Image id="marker" class="decor" width="200" height="40"/>
    </Canvas>`;
    files["ui/hud.ui.css"] = `.decor { raycast-target: false; }`;
    const doc = await open("ui/hud.ui.xml");
    expect(doc.problems).toEqual([]);
    const score = doc.query("#score")!.as(UIText);
    const hint = doc.query("#hint")!.as(UIText);
    const marker = doc.query("#marker")!.as(UIImage);
    expect([score.raycastTarget, hint.raycastTarget, marker.raycastTarget]).toEqual([true, false, false]);
    const p = await pointer();
    p.sync();
    const at = (e: UIText | UIImage) => {
      const r = p.core.rectOf(e)!;
      return p.core.hitTest(r.x + r.width / 2, r.y + r.height / 2);
    };
    expect(at(score)).toBe(score);
    expect(at(hint)).toBeNull();
    expect(at(marker)).toBeNull();
  });

  it("restyles on :hover", async () => {
    const doc = await open();
    const play = doc.query("#play")!;
    const button = play.as(UIButton);
    const p = await pointer();
    p.hover(button);
    engine.step(DT);
    expect(button.hovered).toBe(true);
    expect(play.query("Text")!.as(UIText).color).toEqual(Color.from("#ffff00"));
    p.leave();
    engine.step(DT);
    expect(button.hovered).toBe(false);
    expect(play.query("Text")!.as(UIText).color).toEqual(Color.white);
  });

  it("calls handlers and fills UIEvents for clicks, changes and submits", async () => {
    const doc = await open();
    const play = doc.query("#play")!;
    const seen: string[] = [];
    let buffered: readonly UIEvent[] = [];
    play.on("click", (e) => seen.push(`click ${e.element.id}`));
    const name = doc.query("#name")!;
    let polled = false;
    // The last handler of the frame reads the buffer and the polled state, as a script would that frame.
    name.on("change", (e) => seen.push(`change ${e.element.value}`)).on("submit", () => {
      seen.push("submit");
      buffered = [...UIEvents.read()];
      polled ||= play.clicked && name.changed && name.submitted;
    });
    const dom = stubDocument();
    const p = await pointer();
    // The press on Play (a press takes focus from fields, so a script focuses the name field after it).
    p.hover(play.as(UIButton));
    p.dom.pointerDown(0);
    engine.step(DT);
    expect(seen).toEqual([]);
    // Between frames: the player types and presses Enter in the field, and releases over Play.
    name.as(UIInputField).focused = true;
    p.sync(); // the renderer's sync gives the field DOM focus
    dom.typeText("Ada");
    dom.emit("keydown", { key: "Enter" });
    p.dom.pointerUp(0);
    engine.step(DT);
    expect(seen).toEqual(["click play", "change Ada", "submit"]);
    expect(buffered.map((e) => e.type)).toEqual(["click", "change", "submit"]);
    expect(polled).toBe(true);
    engine.step(DT);
    expect(seen).toHaveLength(3); // once each
    expect(play.clicked).toBe(false);
  });

  it("doesn't report a script's value change as a change", async () => {
    const doc = await open();
    const name = doc.query("#name")!;
    const changes: unknown[] = [];
    name.on("change", (e) => changes.push(e));
    engine.step(DT);
    name.value = "set by script";
    engine.step(DT);
    expect(changes).toHaveLength(0);
  });

  it("makes list rows from the template, reusing them by key", async () => {
    const doc = await open();
    const setups: string[] = [];
    const items = [
      { id: "a", label: "Alpha", n: 1 },
      { id: "b", label: "Beta", n: 2 },
    ];
    const rows = doc.list("#rows", items, (row, item) => setups.push(item.id), { key: "id" });
    expect(rows.map((r) => r.as(UIText).text)).toEqual(["Alpha (1)", "Beta (2)"]);
    expect(rows[0].as(UIText).fontSize).toBe(12);
    expect(rows[0].item).toBe(items[0]);
    expect(doc.query("#rows")!.node.children.map((n) => n.name)).toEqual(["Text", "Text"]);

    const again = doc.list("#rows", [{ id: "b", label: "Beta", n: 3 }, { id: "c", label: "Gamma", n: 4 }], (row, item) => setups.push(item.id), { key: "id" });
    expect(again[0]).toBe(rows[1]); // reused
    expect(rows[0].isValid).toBe(false);
    expect(setups).toEqual(["a", "b", "c"]);
    expect(again.map((r) => r.as(UIText).text)).toEqual(["Beta (3)", "Gamma (4)"]);
    expect(doc.query("#rows")!.children).toEqual(again);
  });

  it("leaves no stray rows when keys repeat or are missing, and warns once about repeats", async () => {
    const doc = await open();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = doc.query("#rows")!;
    const dup = [
      { id: "a", label: "A1", n: 1 },
      { id: "a", label: "A2", n: 2 },
      { id: "b", label: "B", n: 3 },
    ];
    const first = doc.list("#rows", dup, undefined, { key: "id" });
    expect(host.node.children).toHaveLength(3);
    const second = doc.list("#rows", [{ id: "c", label: "C", n: 4 }], undefined, { key: "id" });
    expect(first.every((r) => !r.isValid)).toBe(true);
    expect(host.node.children).toHaveLength(1);
    expect(host.children).toEqual(second);
    doc.list("#rows", dup, undefined, { key: "id" });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("own key")).length).toBe(1);
    // Items without the key field all share `undefined`.
    doc.list("#rows", [{ label: "x", n: 1 }, { label: "y", n: 2 }] as { id?: string; label: string; n: number }[], undefined, { key: "id" });
    doc.list("#rows", [], undefined, { key: "id" });
    expect(host.node.children).toHaveLength(0);
    expect(doc.queryAll(".row")).toHaveLength(0);
    warn.mockRestore();
  });

  it("gives row events their item", async () => {
    files["ui/menu.ui.xml"] = `<Canvas><Panel id="list"><Template><Button>{label}</Button></Template></Panel></Canvas>`;
    const doc = await open();
    const picked: unknown[] = [];
    const rows = doc.list("#list", [{ label: "One" }, { label: "Two" }], (row) => row.on("click", (e) => picked.push(e.item)));
    (await pointer()).click(rows[1].as(UIButton));
    engine.step(DT);
    expect(picked).toEqual([{ label: "Two" }]);
    expect(rows[1].query("Text")!.as(UIText).text).toBe("Two");
  });

  it("rebuilds when a file changes, keeping handlers, data and lists", async () => {
    const doc = await open();
    const play = doc.query("#play")!;
    const clicks: string[] = [];
    play.on("click", () => clicks.push("play"));
    doc.data.score = 5;
    doc.list("#rows", [{ label: "x", n: 1 }]);
    const firstNode = play.node;

    files["ui/menu.ui.css"] = MENU_CSS.replace("#336699", "#000000");
    engine.step(DT);
    expect(firstNode.isValid).toBe(false);
    const rebuilt = doc.query("#play")!;
    expect(rebuilt).toBe(play); // the same element, on new nodes
    expect(rebuilt.as(UIButton).backgroundColor).toEqual(Color.from("#000000"));
    expect(doc.query("#title")!.as(UIText).text).toBe("Score: 5");
    expect(doc.queryAll(".row")).toHaveLength(1);
    (await pointer()).click(rebuilt.as(UIButton));
    engine.step(DT);
    expect(clicks).toEqual(["play"]);
  });

  it("removes its nodes with the component, and hides them while disabled", async () => {
    const doc = await open();
    const canvas = doc.node.children[0];
    doc.enabled = false;
    expect(canvas.active).toBe(false);
    doc.enabled = true;
    expect(canvas.active).toBe(true);
    doc.node.removeBehavior(doc);
    engine.step(DT);
    expect(canvas.isValid).toBe(false);
  });

  it("reports a missing document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await open("ui/nope.ui.xml");
    expect(doc.root).toBeNull();
    expect(doc.problems[0].message).toMatch(/there's no document "ui\/nope.ui.xml"/);
    expect(warn).toHaveBeenCalled();
  });

  it("throws for a bad query selector", async () => {
    const doc = await open();
    expect(() => doc.query("[x]")).toThrow(/Bad selector/);
  });
});

describe("UIDocument in the editor (ADR 0077 wave B)", () => {
  beforeEach(() => {
    files["ui/menu.ui.xml"] = MENU;
    files["ui/menu.ui.css"] = MENU_CSS;
  });

  /** A document under an edit-mode scene root, as the Editor World has it (ADR 0026). */
  function editing(): { scene: GameObject; doc: UIDocument } {
    const scene = GameObject.create("Scene");
    World.require().setEditMode(scene.entity, true);
    const node = GameObject.create("UI", { parent: scene });
    const doc = node.addBehavior(UIDocument, { document: "asset:ui/menu.ui.xml" });
    return { scene, doc };
  }

  it("builds inside a scene being edited, at once when the parsers are loaded", () => {
    const { doc } = editing();
    expect(doc.root).not.toBeNull(); // no await: built as the component activated
    expect(doc.query("#play")!.as(UIButton).backgroundColor).toEqual(Color.from("#336699"));
    expect(documentFile(doc)).toBe("ui/menu.ui.xml");
    expect(doc._sheets.map((s) => s.file)).toEqual(["ui/menu.ui.css"]);
    // It watches the markup it read as well as the stylesheet (the stylesheet: the next test).
    files["ui/menu.ui.xml"] = MENU.replace(">Play<", ">Go<");
    engine.step(DT);
    expect(doc.query("#play Text")!.as(UIText).text).toBe("Go");
  });

  it("hot-reloads in edit mode when a file's asset value changes", () => {
    const { doc } = editing();
    const built = vi.fn();
    const stop = UIDocument._onBuilt(built);
    files["ui/menu.ui.css"] = MENU_CSS.replace("#336699", "#112233");
    engine.step(DT);
    expect(built).toHaveBeenCalledWith(doc);
    expect(doc.query("#play")!.as(UIButton).backgroundColor).toEqual(Color.from("#112233"));
    stop();
  });

  it("rebuilds once a missing document appears", () => {
    const node = GameObject.create("Late");
    const doc = node.addBehavior(UIDocument, { document: "asset:ui/late.ui.xml" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(doc.root).toBeNull();
    files["ui/late.ui.xml"] = `<Canvas><Text id="t">Late</Text></Canvas>`;
    engine.step(DT);
    expect(doc.query("#t")!.as(UIText).text).toBe("Late");
  });

  it("finds elements by component and by their static path, and keeps paths across rebuilds", () => {
    const { doc } = editing();
    const play = doc.query("#play")!;
    expect(UIDocument._elementOf(play.component)).toBe(play);
    expect(elementSource(play)!.path).toBe("/#menu/#play");
    expect(elementSource(doc.root!)!.path).toBe("");
    const label = elementSource(play.children[0])!;
    expect(label.label).toBe(true);
    expect(label.path).toBe("/#menu/#play/label");
    expect(elementAtPath(doc, "/#menu/#play")).toBe(play);
    expect(elementAtPath(doc, "/#menu/#play/label")).toBe(play.children[0]);
    expect(elementAtPath(doc, "/#menu/#nope")).toBeNull();
    // Rows have no path, nor does anything inside them.
    const [row] = doc.list("#rows", [{ label: "a", n: 1 }]);
    expect(elementSource(row)).toBeNull();
    expect(elementSource(row.children[0] ?? row)).toBeNull();
    // A rebuild keeps static paths, and the old component no longer maps.
    const oldComp = play.component;
    files["ui/menu.ui.css"] = MENU_CSS + "\n.extra { gap: 1px; }";
    engine.step(DT);
    const again = elementAtPath(doc, "/#menu/#play")!;
    expect(again).not.toBeNull();
    expect(UIDocument._elementOf(again.component)).toBe(again);
    expect(again.component).not.toBe(oldComp);
  });

  it("collects no events and runs no handlers in a scene being edited", async () => {
    const { doc } = editing();
    const play = doc.query("#play")!;
    const handler = vi.fn();
    play.on("click", handler);
    (await pointer()).click(play.as(UIButton));
    engine.step(DT);
    expect(play.clicked).toBe(true); // the button was clicked...
    expect(handler).not.toHaveBeenCalled(); // ...but the document collects no events while edited
  });

  it("removes its tree with the component, and listeners hear it", () => {
    const { doc } = editing();
    const built = vi.fn();
    const stop = UIDocument._onBuilt(built);
    const canvasNode = doc.root!.node;
    doc.node.removeBehavior(doc);
    engine.step(DT);
    expect(canvasNode.isValid).toBe(false);
    expect(built).toHaveBeenCalledWith(doc);
    stop();
  });

  it("resolves an element's style at another pseudo-class state without writing it", () => {
    const { doc } = editing();
    const play = doc.query("#play")!;
    const hover = doc._resolveAt(play, { hover: true }).get("backgroundColor")!;
    expect(hover.value).toEqual(Color.from("#4477aa"));
    expect(hover.source.kind).toBe("rule");
    expect(play.as(UIButton).backgroundColor).toEqual(Color.from("#336699"));
    expect(play._boundFields()).toEqual([]);
    expect(doc.query("#title")!._boundFields()).toEqual(["text"]);
  });
});

describe("where a UI document's elements are written (ADR 0298)", () => {
  const PAGE = `<Canvas>
  <Panel/>
  <Panel id="a"><Text>Hi</Text></Panel>
  <Text/>
  <Use src="widgets/badge.ui.xml" id="badge"/>
  <Panel><Button>Go</Button></Panel>
</Canvas>`;
  const BADGE = `<Panel class="badge"><Image/><Text>New</Text></Panel>`;

  beforeEach(() => {
    files["ui/page.ui.xml"] = PAGE;
    files["ui/widgets/badge.ui.xml"] = BADGE;
  });

  it("names each element by id, or by its tag counted among same-tag siblings, and a button's label", async () => {
    const doc = await open("ui/page.ui.xml");
    const paths = doc.root!.children.map((c) => elementSource(c)!.path);
    expect(paths).toEqual(["/Panel[0]", "/#a", "/Text[0]", "/#badge", "/Panel[3]"]);
    expect(elementSource(doc.query("#a Text")!)!.path).toBe("/#a/Text[0]");
    expect(elementSource(doc.query("#badge Text")!)!.path).toBe("/#badge/Text[0]");
    const go = doc.query("Button")!;
    expect(elementSource(go)!.path).toBe("/Panel[3]/Button[0]");
    expect(elementSource(go.children[0])!.path).toBe("/Panel[3]/Button[0]/label");
    for (const el of doc.queryAll("*")) expect(elementAtPath(doc, elementSource(el)!.path)).toBe(el);
  });

  it("says where an element's own tag and its <Use> tag are written", async () => {
    const doc = await open("ui/page.ui.xml");
    const root = elementSource(doc.root!)!;
    expect(root).toMatchObject({ file: "ui/page.ui.xml", place: { file: "ui/page.ui.xml", path: [] }, usePlace: null, sitePlace: null, index: -1, childCount: 5 });
    expect(elementSource(doc.query("#a Text")!)).toMatchObject({ place: { file: "ui/page.ui.xml", path: [1, 0] }, usePlace: null, sitePlace: { file: "ui/page.ui.xml", path: [1, 0] }, index: 0, text: "Hi" });
    // A used document's root: its own tag is the used file's root; it sits where its <Use> tag is.
    const badge = elementSource(doc.query("#badge")!)!;
    expect(badge).toMatchObject({ file: "ui/widgets/badge.ui.xml", from: "ui/widgets/badge.ui.xml", place: { file: "ui/widgets/badge.ui.xml", path: [] }, usePlace: { file: "ui/page.ui.xml", path: [3] }, index: 3, childCount: 2 });
    expect(badge.sitePlace).toEqual(badge.usePlace);
    expect(elementSource(doc.query("#badge Text")!)).toMatchObject({ file: "ui/widgets/badge.ui.xml", place: { file: "ui/widgets/badge.ui.xml", path: [1] }, usePlace: null });
    // A button's label has no tag: its text and place are the button's.
    const go = doc.query("Button")!;
    const label = elementSource(go.children[0])!;
    expect(label).toMatchObject({ label: true, place: { file: "ui/page.ui.xml", path: [4, 0] }, sitePlace: null, index: -1, childCount: 0, attributes: [], text: "Go" });
    expect(PAGE.slice(label.openTagSpan.start, label.openTagSpan.end)).toBe("<Button>");
  });

  it("gives the path a child will have, the path a rebuild then gives it", async () => {
    const doc = await open("ui/page.ui.xml");
    const root = doc.root!;
    // Inserting a Panel second: the Panels after it count one more.
    expect(childPath(root, 1, "Panel", null)).toBe("/Panel[1]");
    expect(childPath(root, 99, "Panel", null)).toBe("/Panel[4]");
    expect(childPath(root, 0, "Text", "t")).toBe("/#t");
    // Moving the first Panel to the end: it no longer counts itself; the used root counts as the Panel it is.
    expect(childPath(root, 4, "Panel", null, root.children[0])).toBe("/Panel[3]");
    files["ui/page.ui.xml"] = PAGE.replace(`  <Panel id="a">`, `  <Panel/>\n  <Panel id="a">`);
    engine.step(DT);
    expect(elementSource(elementAtPath(doc, "/Panel[1]")!)!.index).toBe(1);
    files["ui/page.ui.xml"] = PAGE.replace(`  <Panel/>\n`, "").replace(`</Canvas>`, `  <Panel/>\n</Canvas>`);
    engine.step(DT);
    expect(elementSource(elementAtPath(doc, "/Panel[3]")!)!.index).toBe(4);
  });
});
