// Localised and unlocalised text in Svelte components (ADR 0356 §7, §9, ADR 0423 wave F): the localisable parts of an
// element (text content, text attributes) as written, the unkeyed-text list with its dismissal ids, and the key an
// element's whole text shows, through `svelteStrings.ts` over `parseSvelte`.
import { beforeAll, describe, expect, it } from "vitest";
import { localisableParts, textKeyOf, unkeyedId, unkeyedTextIn } from "./svelteStrings";
import { loadSvelteParser, parseSvelte } from "./svelteText";

const SRC = `<script lang="ts">
  import { t, tHtml } from "myco";
  let { score }: { score: number } = $props();
</script>

<section id="menu">
  <h1 id="title">{t("menu.title")}</h1>
  <p id="hint">
    Press any key
  </p>
  <p>Score: {score}</p>
  <p>{score}</p>
  <p>Hello <b>you</b></p>
  <input id="name" placeholder="Your name" title={t("menu.name_tip")} />
  <input type="submit" value="Send" />
  <input value="not shown as a label" />
  <img src="logo.png" alt="Logo" />
  <button aria-label={label}>{@html tHtml("menu.rich", { score })}</button>
  <div translate="no"><span>MYCO</span></div>
  <p>12 / 34</p>
</section>
`;

beforeAll(() => loadSvelteParser());

const source = () => parseSvelte(SRC);
const byId = (id: string) => source().elements.find((e) => e.attributes.some((a) => a.name === "id" && a.value.kind === "literal" && a.value.text === id))!;

describe("an element's localisable text", () => {
  it("tells keyed, literal and dynamic text and attributes apart", () => {
    const s = source();
    expect(localisableParts(s, byId("title"))).toEqual([{ field: "text", state: { kind: "keyed", call: { name: "t", key: "menu.title", args: false } } }]);
    expect(localisableParts(s, byId("hint"))).toEqual([{ field: "text", state: { kind: "literal", text: "Press any key" } }]);
    expect(localisableParts(s, byId("name"))).toEqual([
      { field: "title", state: { kind: "keyed", call: { name: "t", key: "menu.name_tip", args: false } } },
      { field: "placeholder", state: { kind: "literal", text: "Your name" } },
    ]);
    const score = s.elements.find((e) => e.name === "p" && e.content.length === 2)!;
    expect(localisableParts(s, score)[0].state).toMatchObject({ kind: "dynamic", reason: expect.stringMatching(/expressions \(Score: \{score\}\)/) });
    const button = s.elements.find((e) => e.name === "button")!;
    expect(localisableParts(s, button)).toEqual([
      { field: "text", state: { kind: "keyed", call: { name: "tHtml", key: "menu.rich", args: true } } },
      { field: "aria-label", state: { kind: "dynamic", reason: expect.stringMatching(/aria-label is an expression \(\{label\}\)/), text: "{label}" } },
    ]);
    expect(textKeyOf(s, byId("title"))).toEqual({ name: "t", key: "menu.title", args: false });
    expect(textKeyOf(s, byId("hint"))).toBeNull();
  });
});

describe("unkeyed text", () => {
  it("lists literal text with letters and literal text attributes, minus translate=\"no\", keyed text and expressions", () => {
    const list = unkeyedTextIn("ui/Menu.svelte", source());
    expect(list.map((u) => [u.where, u.field, u.text, u.literal])).toEqual([
      ["#hint", "text", "Press any key", true],
      ["<p>", "text", "Score:", false],
      ["<p>", "text", "Hello", false],
      ["<b>", "text", "you", true],
      ["#name", "placeholder", "Your name", true],
      ["<input>", "value", "Send", true],
      ["<img>", "alt", "Logo", true],
    ]);
    expect(list[0]).toMatchObject({ path: "ui/Menu.svelte", id: "hint", line: 8, column: 2 });
    expect(unkeyedId(list[0])).toBe("ui/Menu.svelte|#hint|text|Press any key");
  });
});
