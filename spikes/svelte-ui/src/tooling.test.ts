import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compile, parse } from "svelte/compiler";
import * as csstree from "css-tree";
import { Assets, Color, Engine } from "../../../src/engine/index";
import { UIPanel, UIText } from "../../../src/engine/ui/components";
import { loadUIDocumentSupport } from "../../../src/engine/ui/UIDocument";
import { parseStylesheet } from "../../../src/engine/ui/document/stylesheet";
import { buildUI } from "../../../src/engine/tests/uiMarkup";
import { svelteOptions } from "../svelteCompile.mjs";
import { render } from "./renderer";

// Q3 (CSS) and Q4 (editor source mapping), measured on Card.svelte.

const CARD = new URL("./components/Card.svelte", import.meta.url);
const source = readFileSync(CARD, "utf8");
const OUT = new URL("../out/", import.meta.url);

/** Print a finding (the README quotes these). */
function report(title: string, value: unknown): void {
  console.log(`\n### ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

describe("Q3: a component's scoped <style> through the UI stylesheet parser", () => {
  const out = compile(source, svelteOptions("src/components/Card.svelte"));
  const css = out.css!.code;

  it("captures Svelte's emitted CSS and class attributes, and what the UI parser rejects", () => {
    report("emitted CSS", css);
    const hash = /svelte-[a-z0-9]+/.exec(css)![0];
    report("class attributes in the compiled template", [...out.js.code.matchAll(/class: '([^']*)'/g)].map((m) => m[1]));
    expect(out.js.code).toContain(`class: 'card ${hash}'`);
    const sheet = parseStylesheet(css, "Card.svelte.css");
    report("UI parser problems", sheet.problems.map((p) => p.message));
    report("rules kept", sheet.rules.map((r) => r.selectorText));
    const messages = sheet.problems.map((p) => p.message).join("\n");
    expect(messages).toMatch(/:where isn't supported/);
    expect(messages).toMatch(/Unknown element "text"/);
    expect(messages).toMatch(/@media isn't supported/);
    expect(messages).toMatch(/Pseudo-elements aren't supported/);
    expect(messages).toMatch(/:first-child isn't supported/);
  });

  it("an adapter (lowercase tags → UI tags, :where(.svelte-x) → .svelte-x) leaves only what the subset lacks", () => {
    const adapted = adaptSvelteCss(css);
    report("adapted CSS", adapted);
    const sheet = parseStylesheet(adapted, "Card.svelte.css");
    report("UI parser problems after the adapter", sheet.problems.map((p) => p.message));
    const messages = sheet.problems.map((p) => p.message);
    expect(messages.some((m) => /:where|Unknown element/.test(m))).toBe(false);
    expect(sheet.rules.map((r) => r.selectorText)).toContain(".card.svelte-HASH Text.svelte-HASH".replaceAll("HASH", /svelte-([a-z0-9]+)/.exec(css)![1]));
  });
});

const TAGS: Record<string, string> = { canvas: "Canvas", panel: "Panel", text: "Text", image: "Image", button: "Button", "input-field": "InputField" };

/** The CSS adapter option of README §3: rewrite Svelte's output into the UI subset's spelling. */
export function adaptSvelteCss(css: string): string {
  const ast = csstree.parse(css);
  csstree.walk(ast, {
    visit: "Selector",
    enter(selector) {
      const list = selector.children;
      list.forEach((node, item) => {
        if (node.type === "TypeSelector" && TAGS[node.name]) node.name = TAGS[node.name];
        // `:where(.svelte-x)` → `.svelte-x` (adds the 0,1,0 Svelte meant to avoid; harmless for scoping).
        if (node.type === "PseudoClassSelector" && node.name === "where" && node.children) {
          const inner = node.children.first;
          const cls = inner && inner.type === "SelectorList" ? (inner.children.first as csstree.Selector | null)?.children.first : null;
          if (cls && cls.type === "ClassSelector") list.replace(item, list.createItem({ type: "ClassSelector", name: cls.name }));
        }
      });
    },
  });
  return csstree.generate(ast).replace(/}/g, "}\n");
}

describe("Q3: the adapted component sheet styles the component's hosted elements", () => {
  let engine: Engine;
  beforeEach(async () => {
    Assets.clearSources();
    engine = await Engine.create({ headless: true });
    await loadUIDocumentSupport();
  });
  afterEach(() => engine.dispose());

  it("scoped rules match through the hash class Svelte puts on each element", async () => {
    const Card = (await import("./components/Card.svelte")).default;
    const doc = buildUI(`<Canvas><Panel id="slot"/></Canvas>`, { css: `.card { gap: 9px; }` });
    // The same filename the Vite plugin compiled it with: Svelte's scoping hash is derived from it.
    const css = compile(source, svelteOptions(fileURLToPath(CARD))).css!.code;
    // INTERNAL: a document's sheets are private; the plugin needs `doc.addStylesheet(text, file)` (README §1).
    const sheets = (doc as unknown as { sheets: ReturnType<typeof parseStylesheet>[] }).sheets;
    const before = sheets.reduce((n, s) => n + s.rules.length, 0);
    sheets.push(parseStylesheet(adaptSvelteCss(css), "Card.svelte.css", before));
    render(doc, "#slot", Card, { label: "Hi", tags: ["a"] });
    const card = doc.query("#card")!.as(UIPanel);
    expect(card.backgroundColor).toEqual(Color.from("#202020")); // the component's scoped rule
    expect(card.gap).toBe(2); // its attribute beats both sheets
    expect(card.padding).toBe(4);
    expect(doc.query("#label")!.as(UIText).color).toEqual(Color.from("#eeeeee")); // `.card text` (scoped descendant)
    expect(doc.query(".tag")!.as(UIText).fontSize).toBe(12); // `.tags > .tag`
  });
});

describe("Q4: source locations in dev builds, and parse() spans for patching", () => {
  let engine: Engine;
  beforeEach(async () => {
    Assets.clearSources();
    engine = await Engine.create({ headless: true });
    await loadUIDocumentSupport();
  });
  afterEach(() => engine.dispose());

  it("dev: true puts each element's template line/column on the renderer node; parse() turns it into a span", async () => {
    const dev = compile(source, svelteOptions("src/components/Card.svelte", { dev: true }));
    mkdirSync(OUT, { recursive: true });
    writeFileSync(new URL("Card.dev.js", OUT), dev.js.code);
    const file = new URL("Card.dev.js", OUT).href;
    const Card = (await import(/* @vite-ignore */ file)).default;
    const doc = buildUI(`<Canvas><Panel id="slot"/></Canvas>`);
    const view = render(doc, "#slot", Card, { label: "Hi", tags: ["a", "b"] }, "src/components/Card.svelte");

    const located = ["#card", "#label", "#tags", ".tag", "#toggle"].map((sel) => {
      const el = doc.query(sel)!;
      return [sel, view.tree.sourceOf(el)];
    });
    report("dev locations on hosted elements", located);
    expect(view.tree.sourceOf(doc.query("#label")!)).toEqual({ file: "src/components/Card.svelte", line: 7, column: 2 });
    // A button's label is a synthetic Text from a text node: text nodes carry no location.
    expect(view.tree.sourceOf(doc.query("#toggle Text")!)).toBeNull();

    // parse() (modern AST): from line/column to the element node, its attributes and their value spans.
    const ast = parse(source, { modern: true });
    const at = offsetOf(source, 7, 2);
    const element = findElementAt(ast.fragment, at)!;
    expect(element.name).toBe("text");
    const cls = element.attributes.find((a: { name?: string }) => a.name === "class") as { start: number; end: number; value: { start: number; end: number; data: string }[] };
    report("parse() spans for <text id=label class=label>", { element: [element.start, element.end], classAttribute: source.slice(cls.start, cls.end), value: [cls.value[0].start, cls.value[0].end] });
    expect(source.slice(cls.value[0].start, cls.value[0].end)).toBe("label");

    // Patch a static attribute through the span, as the editor patches .ui.xml (ADR 0077 §4), and recompile.
    const card = findElementAt(ast.fragment, offsetOf(source, 6, 0))!;
    const gap = card.attributes.find((a: { name?: string }) => a.name === "gap") as { value: { start: number; end: number }[] };
    const patched = source.slice(0, gap.value[0].start) + "6" + source.slice(gap.value[0].end);
    expect(patched).toContain(`<panel id="card" class="card" gap="6">`);
    expect(() => compile(patched, svelteOptions("Card.svelte"))).not.toThrow();
    view.unmount();
  });
});

function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
  return offset + column;
}

type AnyNode = { type: string; start: number; end: number; name?: string; attributes?: any[]; fragment?: { nodes: AnyNode[] }; consequent?: { nodes: AnyNode[] }; alternate?: { nodes: AnyNode[] } | null; body?: { nodes: AnyNode[] } };

/** The RegularElement starting at `offset`. */
function findElementAt(fragment: { nodes: AnyNode[] }, offset: number): (AnyNode & { name: string; attributes: any[] }) | null {
  for (const n of fragment.nodes) {
    if (n.type === "RegularElement" && n.start === offset) return n as never;
    for (const f of [n.fragment, n.consequent, n.alternate, n.body]) {
      if (f && n.start <= offset && offset < n.end) {
        const found = findElementAt(f, offset);
        if (found) return found;
      }
    }
  }
  return null;
}
