// Text edits on Svelte component sources (ADR 0423 wave C): each edit changes only its own text, found through
// `parse()` spans, and refuses the dynamic parts (`{…}`, `{#each}` rows, snippets).
import { beforeAll, describe, expect, it } from "vitest";
import {
  addNamedImport,
  duplicateElement,
  elementAtLocation,
  insertAfterElement,
  insertElement,
  lineColumnAt,
  loadSvelteParser,
  moveElement,
  parseSvelte,
  removeAttribute,
  removeElement,
  setAttribute,
  setAttributeExpression,
  setRuleDeclarations,
  setStyleProperty,
  setText,
  setTextExpression,
  SvelteEditError,
} from "./svelteText";

const SRC = `<script lang="ts">
  let { score }: { score: number } = $props();
</script>

<!-- the HUD -->
<section id="hud" gap="2">
  <h1 class="title" style="color: red">Hello</h1>
  <p id="score">Score: {score}</p>
  {#each [1, 2] as i}
    <span class="row">{i}</span>
  {/each}
  <img src={score > 1 ? "a.png" : "b.png"} width=40 />
  <div id="empty"></div>
</section>

<style>
  .title { font-size: 30px; }
</style>
`;

beforeAll(() => loadSvelteParser());

const at = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};

describe("reading a component", () => {
  it("finds elements by their template location, with literal and dynamic parts told apart", () => {
    const src = parseSvelte(SRC);
    const loc = lineColumnAt(SRC, at(SRC, "<h1"));
    expect(loc).toEqual({ line: 7, column: 2 });
    const h1 = elementAtLocation(src, loc.line, loc.column)!;
    expect(h1.name).toBe("h1");
    expect(h1.parent?.name).toBe("section");
    expect(h1.text).toMatchObject({ kind: "literal", text: "Hello" });
    expect(h1.attributes.find((a) => a.name === "class")!.value).toMatchObject({ kind: "literal", text: "title" });
    const p = src.elements.find((e) => e.name === "p")!;
    expect(p.text).toMatchObject({ kind: "dynamic", source: "Score: {score}" });
    const img = src.elements.find((e) => e.name === "img")!;
    expect(img.attributes.find((a) => a.name === "src")!.value).toMatchObject({ kind: "dynamic", source: `{score > 1 ? "a.png" : "b.png"}` });
    expect(src.elements.find((e) => e.name === "span")!.repeated).toBe("it's a row of the {#each} at line 9");
    expect(src.elements.find((e) => e.name === "section")!.children.map((c) => c.name)).toEqual(["h1", "p", "img", "div"]);
    expect(src.style!.rules.map((r) => r.selector)).toEqual([".title"]);
  });
});

describe("attributes", () => {
  it("sets a literal value in place, adds new ones at the end of the open tag, quotes unquoted ones, removes them", () => {
    const h1 = at(SRC, "<h1");
    expect(setAttribute(SRC, h1, "class", "title big")).toBe(SRC.replace(`class="title"`, `class="title big"`));
    expect(setAttribute(SRC, h1, "font-size", "20")).toBe(SRC.replace(`style="color: red">`, `style="color: red" font-size="20">`));
    const img = at(SRC, "<img");
    expect(setAttribute(SRC, img, "width", "50%")).toBe(SRC.replace("width=40", `width="50%"`));
    expect(setAttribute(SRC, img, "height", "8")).toBe(SRC.replace("width=40 />", `width=40 height="8" />`));
    expect(removeAttribute(SRC, h1, "style")).toBe(SRC.replace(` style="color: red"`, ""));
    expect(removeAttribute(SRC, h1, "nope")).toBe(SRC);
  });

  it("refuses expressions and escapes what Svelte would read", () => {
    expect(() => setAttribute(SRC, at(SRC, "<img"), "src", "c.png")).toThrow(SvelteEditError);
    expect(setAttribute(SRC, at(SRC, "<h1"), "title", `a "b" {c}`)).toContain(`title="a &quot;b&quot; &#123;c&#125;"`);
  });

  it("edits a literal style attribute's declarations", () => {
    const h1 = at(SRC, "<h1");
    expect(setStyleProperty(SRC, h1, "color", "blue")).toContain(`style="color: blue"`);
    expect(setStyleProperty(SRC, h1, "width", "10px")).toContain(`style="color: red; width: 10px"`);
    expect(setStyleProperty(SRC, h1, "color", null)).toContain(`<h1 class="title">Hello</h1>`);
  });
});

describe("text", () => {
  it("sets literal text, keeps whitespace, refuses text with expressions", () => {
    expect(setText(SRC, at(SRC, "<h1"), "Hi <you>")).toContain(`<h1 class="title" style="color: red">Hi &lt;you></h1>`);
    expect(() => setText(SRC, at(SRC, `<p id="score"`), "x")).toThrow(/expressions/);
    expect(setText(SRC, at(SRC, `<div id="empty"`), "Now")).toContain(`<div id="empty">Now</div>`);
    expect(setText(SRC, at(SRC, "<img"), "x")).toContain(`width=40>x</img>`);
  });
});

describe("structure", () => {
  it("inserts children (last, at an index, into an empty or self-closing element) and reports where they start", () => {
    const section = at(SRC, "<section");
    const last = insertElement(SRC, section, 99, `<button>Go</button>`);
    expect(last.text).toContain(`<div id="empty"></div>\n  <button>Go</button>\n</section>`);
    expect(last.text.slice(last.start, last.start + 8)).toBe("<button>");
    const first = insertElement(SRC, section, 0, `<hr />`);
    expect(first.text).toContain(`<section id="hud" gap="2">\n  <hr />\n  <h1`);
    expect(first.text.slice(first.start, first.start + 3)).toBe("<hr");
    const empty = insertElement(SRC, at(SRC, `<div id="empty"`), 0, `<span>x</span>`);
    expect(empty.text).toContain(`<div id="empty">\n    <span>x</span>\n  </div>`);
    expect(empty.text.slice(empty.start, empty.start + 5)).toBe("<span");
    const self = insertElement(SRC, at(SRC, "<img"), 0, `<b/>`);
    expect(self.text).toContain(`width=40>\n    <b/>\n  </img>`);
    expect(self.text.slice(self.start, self.start + 3)).toBe("<b/");
    const after = insertAfterElement(SRC, at(SRC, "<h1"), `<hr />`);
    expect(after.text).toContain(`Hello</h1>\n  <hr />\n  <p`);
    expect(after.text.slice(after.start, after.start + 3)).toBe("<hr");
  });

  it("removes, duplicates (fresh ids) and moves elements; refuses {#each} rows", () => {
    expect(removeElement(SRC, at(SRC, `<p id="score"`))).toBe(SRC.replace(`  <p id="score">Score: {score}</p>\n`, ""));
    const dup = duplicateElement(SRC, at(SRC, `<p id="score"`));
    expect(dup.text).toContain(`<p id="score">Score: {score}</p>\n  <p id="score-2">Score: {score}</p>`);
    expect(dup.text.slice(dup.start, dup.start + 17)).toBe(`<p id="score-2">S`);
    const moved = moveElement(SRC, at(SRC, `<div id="empty"`), at(SRC, "<section"), 0);
    expect(moved.text).toContain(`<section id="hud" gap="2">\n  <div id="empty"></div>\n  <h1`);
    expect(moved.text.slice(moved.start, moved.start + 4)).toBe("<div");
    const down = moveElement(SRC, at(SRC, "<h1"), at(SRC, "<section"), 2);
    expect(down.text).toContain(`{/each}\n  <h1 class="title" style="color: red">Hello</h1>\n  <img`);
    expect(() => removeElement(SRC, at(SRC, `<span class="row"`))).toThrow(/\{#each\}/);
  });
});

describe("the component's <style>", () => {
  it("extends a rule, adds one, or makes the style block", () => {
    expect(setRuleDeclarations(SRC, ".title", [["color", "#ff0000"], ["font-size", "12px"]])).toContain(`.title { font-size: 12px; color: #ff0000; }`);
    expect(setRuleDeclarations(SRC, ".box", [["gap", "4px"]])).toContain(`.title { font-size: 30px; }\n  .box { gap: 4px; }\n</style>`);
    const bare = `<div class="a"></div>\n`;
    expect(setRuleDeclarations(bare, ".a", [["gap", "4px"]])).toBe(`<div class="a"></div>\n\n<style>\n  .a { gap: 4px; }\n</style>\n`);
  });
});

describe("localised text (ADR 0356 §9, 0423 wave F)", () => {
  const LOC = `<script lang="ts">
  import { Locale } from "myco";
  import Badge from "./Badge.svelte";
</script>

<p id="a" title="Hello &amp; welcome">  Press start  </p>
<p id="b">{t("menu.go")} and {@html tHtml(\`menu.rich\`, { n })} {t(key)}</p>
<input id="c" placeholder={t("menu.name", { max: 8 })} />
`;

  it("reads text and expression tags in order, t()/tHtml() calls with literal keys, and the script's imports", () => {
    const src = parseSvelte(LOC);
    const b = src.elements.find((e) => e.name === "p" && e.content.length > 1)!;
    expect(b.content.map((c) => (c.kind === "text" ? ["text", c.text] : ["expression", c.html, c.call]))).toEqual([
      ["expression", false, { name: "t", key: "menu.go", args: false }],
      ["text", " and "],
      ["expression", true, { name: "tHtml", key: "menu.rich", args: true }],
      ["expression", false, null],
    ]);
    const a = src.elements[0];
    expect(a.content).toEqual([expect.objectContaining({ kind: "text", text: "  Press start  " })]);
    expect(a.attributes[1].value).toMatchObject({ kind: "literal", text: "Hello & welcome" });
    expect(src.elements.find((e) => e.name === "input")!.attributes[1].value).toMatchObject({ kind: "dynamic", call: { name: "t", key: "menu.name", args: true } });
    expect(src.script!.imports.map((i) => [i.from, i.named.map((n) => n.local), i.others])).toEqual([["myco", ["Locale"], []], ["./Badge.svelte", [], ["Badge"]]]);
  });

  it("replaces literal text or a literal attribute with an expression, refusing dynamic parts", () => {
    expect(setTextExpression(LOC, at(LOC, `<p id="a"`), `t("menu.start")`)).toContain(`<p id="a" title="Hello &amp; welcome">  {t("menu.start")}  </p>`);
    expect(setAttributeExpression(LOC, at(LOC, `<p id="a"`), "title", `t("menu.hello")`)).toContain(`<p id="a" title={t("menu.hello")}>`);
    expect(() => setTextExpression(LOC, at(LOC, `<p id="b"`), `t("x")`)).toThrow(/expressions/);
    expect(() => setAttributeExpression(LOC, at(LOC, "<input"), "placeholder", `t("x")`)).toThrow(/expression/);
    expect(() => setAttributeExpression(LOC, at(LOC, "<input"), "title", `t("x")`)).toThrow(/no title/);
  });

  it("adds a named import to the script: into the module's import, after the last import, into an empty script, or in a new script", () => {
    expect(addNamedImport(LOC, "t", "myco")).toContain(`import { Locale, t } from "myco";`);
    expect(addNamedImport(addNamedImport(LOC, "t", "myco"), "t", "myco")).toBe(addNamedImport(LOC, "t", "myco"));
    expect(addNamedImport(`<script>\n  import X from "./x";\n  let a = 1;\n</script>\n<p>a</p>`, "t", "myco")).toBe(`<script>\n  import X from "./x";\n  import { t } from "myco";\n  let a = 1;\n</script>\n<p>a</p>`);
    expect(addNamedImport(`<script lang="ts">\n  let a = 1;\n</script>\n<p>a</p>`, "t", "myco")).toBe(`<script lang="ts">\n  import { t } from "myco";\n  let a = 1;\n</script>\n<p>a</p>`);
    expect(addNamedImport(`<script></script>\n<p>a</p>`, "t", "myco")).toBe(`<script>\n  import { t } from "myco";\n</script>\n<p>a</p>`);
    expect(addNamedImport(`<p>a</p>\n`, "t", "myco")).toBe(`<script lang="ts">\n  import { t } from "myco";\n</script>\n\n<p>a</p>\n`);
    expect(() => addNamedImport(`<script>\n  import { t } from "./i18n";\n</script>\n<p>a</p>`, "t", "myco")).toThrow(/another t/);
  });
});
