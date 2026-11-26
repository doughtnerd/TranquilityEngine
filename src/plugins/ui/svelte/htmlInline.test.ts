// ADR 0425: the inline HTML parser `{@html}`, `innerHTML` and `bind:innerHTML` use: elements, attributes and text with
// entities decoded; comments kept; scripts, styles, event attributes and script URLs dropped; HTML's implied closes.
import { describe, expect, it } from "vitest";
import { decodeEntities, parseInlineHtml, type InlineHtmlNode } from "./htmlInline";

/** The nodes as compact HTML-ish text, for comparing. */
const show = (nodes: readonly InlineHtmlNode[]): string =>
  nodes.map((n) => (n.kind === "text" ? n.text : n.kind === "comment" ? `<!--${n.text}-->` : `<${n.tag}${n.attributes.map(([k, v]) => ` ${k}="${v}"`).join("")}>${show(n.children)}</${n.tag}>`)).join("");

describe("inline HTML parser", () => {
  it("reads elements, attributes and text, decoding entities", () => {
    expect(show(parseInlineHtml(`You have <b class="n">3</b> coins &amp; a <a href='#shop' data-x=1>shop</a>&nbsp;&#x263A;`))).toBe(`You have <b class="n">3</b> coins & a <a href="#shop" data-x="1">shop</a> ☺`);
    expect(decodeEntities("&lt;b&gt; &unknown; &#65;")).toBe("<b> &unknown; A");
  });

  it("drops scripts, styles and embedded documents with their content, and keeps comments", () => {
    expect(show(parseInlineHtml(`a<script>alert("<b>")</script>b<style>p{}</style>c<!-- note -->d<iframe src="x">e</iframe>f<!DOCTYPE html>`))).toBe("abc<!-- note -->df");
    expect(show(parseInlineHtml(`<!-- --><div>1</div><!-- open`))).toBe("<!-- --><div>1</div><!-- open-->");
  });

  it("drops event attributes, srcdoc and script URLs, keeping an image's data: picture", () => {
    expect(show(parseInlineHtml(`<span onclick="x()" OnMouseOver="y()" title="t">s</span><a href=" javascript:alert(1)">l</a><img src="data:image/png;base64,AA"><a href="data:text/html,x">d</a>`))).toBe(
      `<span title="t">s</span><a>l</a><img src="data:image/png;base64,AA"></img><a>d</a>`,
    );
  });

  it("closes void elements, unclosed elements, a p a block opens, and a list item the next one", () => {
    expect(show(parseInlineHtml(`one<br>two<i>open`))).toBe("one<br></br>two<i>open</i>");
    expect(show(parseInlineHtml(`<p>para<div>block</div>`))).toBe("<p>para</p><div>block</div>");
    expect(show(parseInlineHtml(`<ul><li>a<li>b</ul>`))).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(show(parseInlineHtml(`<b>x</i>y</b>z</em>`))).toBe("<b>xy</b>z");
  });

  it("keeps SVG's tag case and self-closing shapes, and lowercases HTML tags", () => {
    expect(show(parseInlineHtml(`<B>x</B><svg viewBox="0 0 1 1"><linearGradient id="g"/><path d="M0 0"/></svg>`))).toBe(`<b>x</b><svg viewBox="0 0 1 1"><linearGradient id="g"></linearGradient><path d="M0 0"></path></svg>`);
  });

  it("keeps a textarea's raw content as its text", () => {
    expect(show(parseInlineHtml(`<textarea>a <b> c</textarea>!`))).toBe("<textarea>a <b> c</textarea>!");
  });
});
