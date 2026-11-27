import { describe, expect, it } from "vitest";
import { parseSelectorQuery } from "../ui/document/selectorQuery";
import { parseStylesheet } from "../ui/document/stylesheet";

// ADR 0419: queries (`UIView.query`) read selectors without css-tree, into the same data the stylesheet
// parser makes, so games using only Svelte UI never load the parser.

const viaParser = (selector: string) => {
  const sheet = parseStylesheet(`${selector}{}`, "q.css");
  expect(sheet.problems).toEqual([]);
  return sheet.rules[0].selectors;
};

describe("parseSelectorQuery", () => {
  it.each([
    "#play",
    "button",
    "*",
    ".row.dear span",
    "section > h1.title",
    "div   >   p",
    ".shop.svelte-70eda5 .title:where(.svelte-70eda5)",
    "button:hover, button:focus",
    ":is(#a, .b) span:disabled",
    "p:lang(de-AT)",
    "Panel > Text",
    // ADR 0418 wave 5
    "li + li",
    "h1 ~ p.note",
    "li:not(.done, #x)",
    "li:not(.a .b)",
    "li:first-child, li:last-child, li:only-child",
    "li:nth-child(2n+1)",
    "li:nth-child(odd), li:nth-child(even), li:nth-child(-n+3), li:nth-child(5)",
    "li:nth-last-child(2 of .item)",
    "p:first-of-type, p:last-of-type, p:only-of-type, p:nth-of-type(3n), p:nth-last-of-type(1)",
    "[data-open]",
    "input[type=checkbox]",
    '[lang|="en"], [class~=a], [href^=http], [href$=".png"], [title*=x i]',
    "div:empty",
    ":root",
    ":root .theme",
  ])("reads %s as the stylesheet parser does", (selector) => {
    expect(parseSelectorQuery(selector)).toEqual(viaParser(selector));
  });

  it.each([
    ["p::first-line", /::first-line isn.t supported/],
    ["a:visited", /:visited isn't supported/],
    ["p:nth-child(x)", /takes an\+b/],
    ["p:nth-of-type(2 of .a)", /takes no "of"/],
    ["[href=]", /expected an attribute value/],
    ["[href", /expected "\]"/],
    ["div > + p", /expected a selector/],
    ["blink", /unknown element "blink"/],
    ["div >", /expected a selector/],
    ["", /expected a selector/],
    [":is(.a", /isn't closed/],
    ["#", /expected an id/],
  ])("refuses %s", (selector, message) => {
    expect(() => parseSelectorQuery(selector)).toThrow(message);
  });

  it("reads an+b, attribute operators and specificity as CSS does (ADR 0418 wave 5)", () => {
    const nth = (s: string) => parseSelectorQuery(s)[0].parts[0].selector.nth;
    expect(nth(":nth-child(2n + 1)")).toEqual([{ a: 2, b: 1 }]);
    expect(nth(":nth-child(-n+3)")).toEqual([{ a: -1, b: 3 }]);
    expect(nth(":nth-last-child(n)")).toEqual([{ a: 1, b: 0, last: true }]);
    expect(nth(":only-of-type")).toEqual([{ a: 0, b: 1, ofType: true }, { a: 0, b: 1, last: true, ofType: true }]);
    expect(parseSelectorQuery('[Title*="A b" i]')[0].parts[0].selector.attributes).toEqual([{ name: "title", op: "*=", value: "A b", insensitive: true }]);
    expect(parseSelectorQuery("li:not(#a, .b)")[0].specificity).toEqual([1, 0, 1]);
    expect(parseSelectorQuery("li:nth-child(2 of .a.b)")[0].specificity).toEqual([0, 3, 1]);
    expect(parseSelectorQuery("[x]:first-child")[0].specificity).toEqual([0, 2, 0]);
    expect(parseSelectorQuery(":root")[0]).toMatchObject({ root: true, specificity: [0, 1, 0] });
    expect(parseSelectorQuery(":root .a")[0].root).toBe(false);
    expect(parseSelectorQuery("a + b ~ p")[0].parts.map((p) => p.combinator)).toEqual([null, "+", "~"]);
  });
});
