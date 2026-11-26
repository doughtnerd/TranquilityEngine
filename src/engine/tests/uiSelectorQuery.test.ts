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
  ])("reads %s as the stylesheet parser does", (selector) => {
    expect(parseSelectorQuery(selector)).toEqual(viaParser(selector));
  });

  it.each([
    ["a + b", /combinator/],
    ["div ~ p", /combinator/],
    ["[href]", /attribute selectors/],
    ["p::before", /pseudo-elements/],
    ["p:nth-child(2)", /:nth-child isn't supported/],
    ["blink", /unknown element "blink"/],
    ["div >", /expected a selector/],
    ["", /expected a selector/],
    [":is(.a", /isn't closed/],
    ["#", /expected an id/],
  ])("refuses %s", (selector, message) => {
    expect(() => parseSelectorQuery(selector)).toThrow(message);
  });
});
