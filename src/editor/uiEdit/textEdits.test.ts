// Text edits for UI documents (ADR 0077 §4): each edit changes only its own text; comments,
// blank lines, quotes and indentation elsewhere stay byte for byte.
import { describe, expect, it } from "vitest";
import { parseMarkup } from "../../engine/ui/document/markup";
import { addRule, findRule, removeDeclaration, setDeclaration, setDeclarations } from "./cssText";
import {
  addStyle,
  duplicateElement,
  elementAt,
  insertElement,
  MarkupEditError,
  moveElement,
  parseSource,
  removeAttribute,
  removeElement,
  setAttribute,
  setText,
} from "./markupText";

const MENU = `<!-- The menu -->
<Canvas>
  <Style src="menu.ui.css"/>
  <Panel id="menu"   class='column' padding="12">
    <!-- the title -->
    <Text id="title">Score: {score}</Text>

    <Button id="play" class="primary">Play</Button>
    <Image
      id="logo"
      image="ui/logo.png"
    />
  </Panel>
</Canvas>
`;

/** The text before `a` and after `b` (which must be unchanged), for byte-for-byte checks. */
function unchangedAround(before: string, after: string, from: string, to: string): void {
  const s = before.indexOf(from), e = before.indexOf(to) + to.length;
  expect(after.startsWith(before.slice(0, s))).toBe(true);
  expect(after.endsWith(before.slice(e))).toBe(true);
}

describe("markup attributes", () => {
  it("changes a value in place, keeping its quotes and everything else", () => {
    const out = setAttribute(MENU, [0], "class", "row");
    expect(out).toBe(MENU.replace("class='column'", "class='row'"));
    expect(setAttribute(MENU, [0], "padding", "20")).toBe(MENU.replace('padding="12"', 'padding="20"'));
  });

  it("inserts a new one at the end of the open tag, one per line when the tag is written that way", () => {
    expect(setAttribute(MENU, [0, 0], "font-size", "30")).toBe(MENU.replace('<Text id="title">', '<Text id="title" font-size="30">'));
    expect(setAttribute(MENU, [0, 2], "width", "64")).toBe(MENU.replace('image="ui/logo.png"\n', 'image="ui/logo.png"\n      width="64"\n'));
    expect(setAttribute(MENU, [], "mode", "world")).toBe(MENU.replace("<Canvas>", '<Canvas mode="world">'));
  });

  it("escapes values", () => {
    const out = setAttribute(MENU, [0, 1], "name", `a "b" <c> & d`);
    expect(out).toContain(`name="a &quot;b&quot; &lt;c> &amp; d"`);
    expect(parseMarkup(out, "m.ui.xml", () => "").root!.children[0].children[1].attributes.find((a) => a.name === "name")!.value).toBe(`a "b" <c> & d`);
  });

  it("removes one with the space before it", () => {
    expect(removeAttribute(MENU, [0], "class")).toBe(MENU.replace(`   class='column'`, ""));
    expect(removeAttribute(MENU, [0, 2], "image")).toBe(MENU.replace('\n      image="ui/logo.png"', ""));
    expect(removeAttribute(MENU, [0], "nope")).toBe(MENU);
  });

  it("refuses an element that isn't there", () => {
    expect(() => setAttribute(MENU, [0, 9], "a", "b")).toThrow(MarkupEditError);
  });
});

describe("text content", () => {
  it("replaces the text, keeping bindings as written and the comment beside it", () => {
    expect(setText(MENU, [0, 0], "Points: {points}")).toBe(MENU.replace("Score: {score}", "Points: {points}"));
    expect(setText(MENU, [0, 1], "Go & <win>")).toBe(MENU.replace(">Play<", ">Go &amp; &lt;win&gt;<"));
  });

  it("keeps the whitespace around multi-line text, and opens a self-closing element", () => {
    const src = `<Canvas>\n  <Text>\n    Hello\n  </Text>\n  <Text id="t"/>\n</Canvas>`;
    expect(setText(src, [0], "Bye")).toBe(src.replace("Hello", "Bye"));
    expect(setText(src, [1], "New")).toBe(src.replace('<Text id="t"/>', '<Text id="t">New</Text>'));
    expect(setText(src, [0], "")).toBe(src.replace("\n    Hello\n  ", ""));
  });
});

describe("elements", () => {
  it("inserts among siblings with their indentation", () => {
    const out = insertElement(MENU, [0], 1, `<Text>New</Text>`);
    expect(out).toBe(MENU.replace(`    <Button id="play"`, `    <Text>New</Text>\n    <Button id="play"`));
    const last = insertElement(MENU, [0], 99, `<Panel/>`);
    expect(last).toBe(MENU.replace(`    />\n  </Panel>`, `    />\n    <Panel/>\n  </Panel>`));
  });

  it("opens a self-closing parent one level in", () => {
    const src = `<Canvas>\n\t<Panel id="a"/>\n</Canvas>\n`;
    expect(insertElement(src, [0], 0, `<Text/>`)).toBe(`<Canvas>\n\t<Panel id="a">\n\t\t<Text/>\n\t</Panel>\n</Canvas>\n`);
    expect(insertElement(`<Canvas/>`, [], 0, `<Text/>`)).toBe(`<Canvas>\n  <Text/>\n</Canvas>`);
    expect(insertElement(`<Canvas>\n</Canvas>`, [], 0, `<Text/>`)).toBe(`<Canvas>\n  <Text/>\n</Canvas>`);
  });

  it("indents a multi-line snippet's inner lines", () => {
    const out = insertElement(MENU, [0], 0, `<Panel>\n  <Text/>\n</Panel>`);
    expect(out).toContain(`    <!-- the title -->\n    <Panel>\n      <Text/>\n    </Panel>\n    <Text id="title">`);
  });

  it("removes an element's line, leaving its neighbours and comments", () => {
    expect(removeElement(MENU, [0, 1])).toBe(MENU.replace(`    <Button id="play" class="primary">Play</Button>\n`, ""));
    expect(removeElement(MENU, [0, 2])).toBe(MENU.replace(`    <Image\n      id="logo"\n      image="ui/logo.png"\n    />\n`, ""));
    expect(() => removeElement(MENU, [])).toThrow(MarkupEditError);
  });

  it("moves within a parent and into another, re-indenting", () => {
    const up = moveElement(MENU, [0, 1], [0], 0);
    expect(up.path).toEqual([0, 0]);
    expect(up.text).toBe(MENU.replace(`    <Button id="play" class="primary">Play</Button>\n`, "").replace(`    <Text id="title">`, `    <Button id="play" class="primary">Play</Button>\n    <Text id="title">`));
    const down = moveElement(MENU, [0, 0], [0], 2); // after the button: index counts itself
    expect(elementAt(parseSource(down.text), down.path)!.attributes[0].value).toBe("title");
    expect(down.path).toEqual([0, 1]);
    const out = moveElement(MENU, [0, 2], [], 0);
    expect(out.path).toEqual([0]);
    expect(out.text).toContain(`<Style src="menu.ui.css"/>\n  <Image\n    id="logo"\n    image="ui/logo.png"\n  />\n  <Panel id="menu"`);
    expect(() => moveElement(MENU, [0], [0, 1], 0)).toThrow(MarkupEditError);
  });

  it("duplicates with fresh ids", () => {
    const d = duplicateElement(MENU, [0, 1]);
    expect(d.path).toEqual([0, 2]);
    expect(d.text).toBe(MENU.replace(`Play</Button>\n`, `Play</Button>\n    <Button id="play-2" class="primary">Play</Button>\n`));
    const again = duplicateElement(d.text, [0, 1]);
    expect(again.text).toContain(`id="play-3"`);
  });

  it("adds a <Style> after the existing ones, or first in the root", () => {
    expect(addStyle(MENU, "extra.ui.css")).toBe(MENU.replace(`<Style src="menu.ui.css"/>`, `<Style src="menu.ui.css"/>\n  <Style src="extra.ui.css"/>`));
    expect(addStyle(`<Canvas>\n  <Panel/>\n</Canvas>`, "a.ui.css")).toBe(`<Canvas>\n  <Style src="a.ui.css"/>\n  <Panel/>\n</Canvas>`);
  });

  it("leaves the rest of the file byte for byte after a chain of edits", () => {
    let t = MENU;
    t = setAttribute(t, [0, 0], "color", "#ff0000");
    t = setText(t, [0, 0], "Hi");
    t = insertElement(t, [0], 3, `<Text>Footer</Text>`);
    t = removeAttribute(t, [0, 0], "color");
    t = setText(t, [0, 0], "Score: {score}");
    t = removeElement(t, [0, 3]);
    expect(t).toBe(MENU);
    unchangedAround(MENU, setAttribute(MENU, [0, 1], "x", "1"), "<Button", "Play</Button>");
  });
});

const CSS = `/* Theme */
:root { --fg: #ffeedd; }

.column {
  flex-direction: column; /* stacked */
  color: var(--fg)
}
.primary { background-color: #336699; }
`;

describe("stylesheets", () => {
  it("changes a declaration's value in place", () => {
    expect(setDeclaration(CSS, ".primary", "background-color", "#ff0000")).toBe(CSS.replace("#336699", "#ff0000"));
    expect(setDeclaration(CSS, ".column", "color", "red")).toBe(CSS.replace("color: var(--fg)", "color: red"));
  });

  it("adds declarations in the rule's own style, fixing a missing semicolon", () => {
    expect(setDeclaration(CSS, ".column", "gap", "4px")).toBe(CSS.replace("color: var(--fg)\n", "color: var(--fg);\n  gap: 4px;\n"));
    expect(setDeclaration(CSS, ".primary", "padding", "8px")).toBe(CSS.replace("#336699; }", "#336699; padding: 8px; }"));
    expect(setDeclaration(`.a {}`, ".a", "gap", "1px")).toBe(`.a { gap: 1px; }`);
    expect(setDeclaration(`.a {\n}\n`, ".a", "gap", "1px")).toBe(`.a {\n  gap: 1px;\n}\n`);
  });

  it("removes declarations, their line when alone on it", () => {
    expect(removeDeclaration(CSS, ".column", "color")).toBe(CSS.replace("\n  color: var(--fg)", ""));
    expect(removeDeclaration(CSS, ".column", "flex-direction")).toBe(CSS.replace("flex-direction: column; ", ""));
    expect(removeDeclaration(CSS, ".primary", "background-color")).toBe(CSS.replace(" background-color: #336699;", ""));
    expect(removeDeclaration(CSS, ".primary", "nope")).toBe(CSS);
  });

  it("adds rules at the end, matching the sheet's indentation", () => {
    expect(addRule(CSS, ".big", [["font-size", "30px"], ["color", "#ffffff"]])).toBe(`${CSS}\n.big {\n  font-size: 30px;\n  color: #ffffff;\n}\n`);
    expect(setDeclaration(CSS, "#title", "width", "10px")).toBe(`${CSS}\n#title {\n  width: 10px;\n}\n`);
    expect(addRule("", ".a", [["gap", "1px"]])).toBe(".a {\n  gap: 1px;\n}\n");
    expect(setDeclarations(CSS, ".primary", [["gap", "1px"], ["background-color", "red"]])).toBe(CSS.replace("#336699; }", "red; gap: 1px; }"));
  });

  it("finds rules by selector, ignoring whitespace", () => {
    expect(findRule(`Panel  >  .a { gap: 1px }`, "Panel > .a")).not.toBeNull();
    expect(findRule(CSS, ".nope")).toBeNull();
  });
});
