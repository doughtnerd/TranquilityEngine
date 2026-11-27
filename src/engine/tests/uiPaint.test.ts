// ADR 0422 wave 2: paint in UI stylesheets — shadows, background images (url and gradients) and per-corner radii:
// their values as CSS text, the cascade that expands the shorthands, and what a built document's elements hold.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Color, Engine } from "../index";
import { UIButton, UIPanel, UIText } from "../ui/components";
import { parseStylesheet, resolveStyle } from "../ui/document/stylesheet";
import { linearGradientLine, parseBackgroundImage, parseCornerRadii, parseShadow, radialGradientCircle } from "../ui/document/paintValues";
import type { MarkupElement, StyleTarget, UITag } from "../ui/document/types";
import { buildUI, byId, loadUITestSupport } from "./uiMarkup";

function target(tag: UITag, opts: { classes?: string[]; parent?: StyleTarget | null } = {}): StyleTarget {
  return { tag, id: null, classes: opts.classes ?? [], state: { hover: false, pressed: false, focus: false, disabled: false }, parent: opts.parent ?? null };
}

function element(tag: UITag, attributes: Record<string, string> = {}): MarkupElement {
  const span = { start: 0, end: 0 };
  return { tag, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value, span, valueSpan: span })), file: "ui/hud/t.svelte" };
}

const black = new Color(0, 0, 0, 1);

describe("paint values (ADR 0422 wave 2)", () => {
  it("reads one shadow: offsets, an optional blur and a colour before or after them", () => {
    expect(parseShadow("2px 4px 6px rgba(0, 0, 0, 0.5)")).toEqual({ ok: true, value: { offsetX: 2, offsetY: 4, blur: 6, color: new Color(0, 0, 0, 0.5) } });
    expect(parseShadow("#ff0000 -1 3")).toEqual({ ok: true, value: { offsetX: -1, offsetY: 3, blur: 0, color: new Color(1, 0, 0, 1) } });
    expect(parseShadow("1px 1px")).toEqual({ ok: true, value: { offsetX: 1, offsetY: 1, blur: 0, color: black } });
    expect(parseShadow("none")).toEqual({ ok: true, value: { offsetX: 0, offsetY: 0, blur: 0, color: null } });
  });

  it("says why a shadow can't be read: inset, a spread, several shadows, a missing offset, a negative blur", () => {
    const problem = (v: string) => {
      const r = parseShadow(v);
      return r.ok ? null : r.problem;
    };
    expect(problem("inset 1px 1px #000")).toMatch(/inset/);
    expect(problem("1px 1px 2px 3px #000")).toMatch(/spread/);
    expect(problem("1px 1px #000, 2px 2px #fff")).toMatch(/one shadow/);
    expect(problem("1px #000")).toMatch(/offset/);
    expect(problem("1px 1px -2px")).toMatch(/negative/);
    expect(problem("1px #000 1px")).toMatch(/before or after/);
    expect(problem("1px 1px wobbly")).toMatch(/"wobbly"/);
  });

  it("reads one to four corner radii in CSS order, and refuses elliptical or negative ones", () => {
    expect(parseCornerRadii("4px")).toEqual({ ok: true, value: [4, 4, 4, 4] });
    expect(parseCornerRadii("4 8")).toEqual({ ok: true, value: [4, 8, 4, 8] });
    expect(parseCornerRadii("1 2 3")).toEqual({ ok: true, value: [1, 2, 3, 2] });
    expect(parseCornerRadii("1px 2px 3px 4px")).toEqual({ ok: true, value: [1, 2, 3, 4] });
    expect(parseCornerRadii("4px / 2px").ok).toBe(false);
    expect(parseCornerRadii("-1px").ok).toBe(false);
    expect(parseCornerRadii("1 2 3 4 5").ok).toBe(false);
  });

  it("reads linear gradients with an angle, a side or neither, filling in stop positions as CSS does", () => {
    const red = new Color(1, 0, 0, 1);
    const blue = new Color(0, 0, 1, 1);
    expect(parseBackgroundImage("linear-gradient(90deg, red, blue)")).toEqual({ ok: true, value: { kind: "linear-gradient", angle: 90, stops: [{ color: red, offset: 0 }, { color: blue, offset: 1 }] } });
    const toLeft = parseBackgroundImage("linear-gradient(to left, red 20%, rgba(0, 0, 255, 1), red 80%, blue)");
    expect(toLeft.ok && toLeft.value.kind === "linear-gradient" && toLeft.value.angle).toBe(270);
    expect(toLeft.ok && toLeft.value.kind === "linear-gradient" && toLeft.value.stops.map((s) => s.offset)).toEqual([0.2, 0.5, 0.8, 1]);
    const plain = parseBackgroundImage("linear-gradient(red, blue 30%, red 10%)");
    expect(plain.ok && plain.value.kind === "linear-gradient" && plain.value.angle).toBe(180); // to bottom
    expect(plain.ok && plain.value.kind === "linear-gradient" && plain.value.stops.map((s) => s.offset)).toEqual([0, 0.3, 0.3]); // never back past an earlier stop
    const turn = parseBackgroundImage("linear-gradient(0.25turn, red, blue)");
    expect(turn.ok && turn.value.kind === "linear-gradient" && turn.value.angle).toBe(90);
  });

  it("reads radial gradients as a circle at the centre, url() and none, and says why other images can't be read", () => {
    const radial = parseBackgroundImage("radial-gradient(circle at center, #fff, #000 50%)");
    expect(radial.ok && radial.value.kind === "radial-gradient" && radial.value.stops.map((s) => s.offset)).toEqual([0, 0.5]);
    expect(parseBackgroundImage("radial-gradient(#fff, #000)").ok).toBe(true);
    expect(parseBackgroundImage(`url("images/wood.png")`)).toEqual({ ok: true, value: { kind: "url", path: "images/wood.png" } });
    expect(parseBackgroundImage("none")).toEqual({ ok: true, value: { kind: "none" } });
    const problem = (v: string) => {
      const r = parseBackgroundImage(v);
      return r.ok ? null : r.problem;
    };
    expect(problem("radial-gradient(ellipse at top, red, blue)")).toMatch(/circle at the centre/);
    expect(problem("linear-gradient(to top right, red, blue)")).toMatch(/corner directions/);
    expect(problem("linear-gradient(red)")).toMatch(/two colour stops/);
    expect(problem("linear-gradient(red 10px, blue)")).toMatch(/in %/);
    expect(problem("conic-gradient(red, blue)")).toMatch(/conic-gradient\(\) isn't supported/);
    expect(problem("url(a.png), url(b.png)")).toMatch(/one image/);
  });

  it("places a gradient across the box as CSS does: the line through the centre reaching the corners, the circle the farthest corner", () => {
    const line = (l: { x0: number; y0: number; x1: number; y1: number }) => [l.x0, l.y0, l.x1, l.y1].map((v) => Math.round(v * 1000) / 1000 + 0);
    expect(line(linearGradientLine(90, { left: 10, top: 20, width: 200, height: 80 }))).toEqual([10, 60, 210, 60]);
    expect(line(linearGradientLine(180, { left: 0, top: 0, width: 100, height: 50 }))).toEqual([50, 0, 50, 50]);
    const diag = linearGradientLine(45, { left: 0, top: 0, width: 100, height: 100 });
    expect(diag.x1 - diag.x0).toBeCloseTo(100); // a square's 45° line runs corner to corner
    expect(diag.y0 - diag.y1).toBeCloseTo(100);
    expect(radialGradientCircle({ left: 0, top: 0, width: 60, height: 80 })).toEqual({ cx: 30, cy: 40, r: 50 });
  });
});

describe("the cascade's paint (ADR 0422 wave 2)", () => {
  it("expands box-shadow, text-shadow and border-radius to their fields, from rules and attributes", () => {
    const sheet = parseStylesheet(
      `.card { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); border-radius: 4px 8px 12px 16px; background-image: linear-gradient(90deg, #fff, #000 60%); }
       .round { border-radius: 10px; }
       .hud { text-shadow: 1px 2px 3px #ff0000; }`,
      "ui/hud/s.css",
    );
    expect(sheet.problems).toEqual([]);
    const warnings: string[] = [];
    const card = resolveStyle(target("Panel", { classes: ["card"] }), element("Panel"), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(card.get("boxShadowColor")?.value).toEqual(new Color(0, 0, 0, 0.5));
    expect([card.get("boxShadowOffsetX")?.value, card.get("boxShadowOffsetY")?.value, card.get("boxShadowBlur")?.value]).toEqual([0, 2, 8]);
    const shadowSource = card.get("boxShadowBlur")!.source;
    expect(shadowSource.kind === "rule" && shadowSource.declaration.property).toBe("box-shadow"); // the Inspector names the shorthand
    expect(["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"].map((f) => card.get(f)?.value)).toEqual([4, 8, 12, 16]);
    expect(card.get("backgroundImage")?.value).toBe("linear-gradient(90deg, #fff, #000 60%)");

    // One value: borderRadius, and every corner back on it. An attribute beats the rule.
    const round = resolveStyle(target("Panel", { classes: ["card", "round"] }), element("Panel"), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(round.get("borderRadius")?.value).toBe(10);
    expect(round.get("borderTopLeftRadius")?.value).toBe(-1);
    const attr = resolveStyle(target("Panel", { classes: ["card"] }), element("Panel", { "border-radius": "0 6", "box-shadow": "none" }), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(["borderTopLeftRadius", "borderTopRightRadius"].map((f) => attr.get(f)?.value)).toEqual([0, 6]);
    expect(attr.get("boxShadowColor")?.value).toBeNull();
    expect(attr.get("boxShadowColor")?.source.kind).toBe("attribute");

    // text-shadow inherits, through a Panel that has no such field.
    const hudTarget = target("Panel", { classes: ["hud"] });
    const hud = resolveStyle(hudTarget, element("Panel"), UIPanel, [sheet], null, (m) => warnings.push(m));
    const label = resolveStyle(target("Text", { parent: hudTarget }), element("Text"), UIText, [sheet], hud, (m) => warnings.push(m));
    expect(label.get("textShadowColor")?.value).toEqual(new Color(1, 0, 0, 1));
    expect(label.get("textShadowColor")?.source.kind).toBe("inherited");
    expect([label.get("textShadowOffsetX")?.value, label.get("textShadowOffsetY")?.value, label.get("textShadowBlur")?.value]).toEqual([1, 2, 3]);
    expect(warnings).toEqual([]);
  });

  it("resolves a url() background against the stylesheet, as asset fields are", () => {
    const sheet = parseStylesheet(`Panel { background-image: url(../images/wood.png); } .abs { background-image: url("asset:ui/bg.png"); } .none { background-image: none; }`, "ui/hud/s.css");
    const out = (classes: string[]) => resolveStyle(target("Panel", { classes }), element("Panel"), UIPanel, [sheet], null, () => {}).get("backgroundImage")?.value;
    expect(out([])).toBe(`url("asset:ui/images/wood.png")`);
    expect(out(["abs"])).toBe(`url("asset:ui/bg.png")`);
    expect(out(["none"])).toBe("");
  });

  it("leaves out paint values it can't read, and warns once for each", () => {
    const sheet = parseStylesheet(
      `.bad { box-shadow: inset 1px 1px 3px #123456; text-shadow: 1px; border-radius: 4px / 2px; background-image: conic-gradient(red, blue); }`,
      "ui/hud/bad.css",
    );
    const warnings: string[] = [];
    for (let i = 0; i < 2; i++) {
      const out = resolveStyle(target("Panel", { classes: ["bad"] }), element("Panel"), UIPanel, [sheet], null, (m) => warnings.push(m));
      expect(out.has("boxShadowColor")).toBe(false);
      expect(out.has("borderTopLeftRadius")).toBe(false);
      expect(out.has("borderRadius")).toBe(false);
      expect(out.has("backgroundImage")).toBe(false);
    }
    expect(warnings).toHaveLength(4); // once each, though resolved twice
    expect(warnings.join("\n")).toMatch(/box-shadow: "inset 1px 1px 3px #123456" inset shadows aren't supported/);
    expect(warnings.join("\n")).toMatch(/text-shadow: "1px" needs an x and a y offset/);
    expect(warnings.join("\n")).toMatch(/border-radius: "4px \/ 2px" elliptical corners/);
    expect(warnings.join("\n")).toMatch(/"conic-gradient\(red, blue\)" isn't a valid backgroundImage/);
  });
});

describe("paint on a built document (ADR 0422 wave 2)", () => {
  let engine: Engine;
  beforeEach(async () => {
    engine = await Engine.create({ headless: true });
    await loadUITestSupport();
  });
  afterEach(() => {
    engine.dispose();
    Assets.clearSources();
  });

  it("gives elements the shorthands' fields from rules and attributes, and keeps borderRadius working for scripts", () => {
    const doc = buildUI(
      `<Canvas>
         <div id="card" class="card"><p id="label" class="title">Hi</p></div>
         <button id="play" border-radius="2 4"/>
       </Canvas>`,
      { css: `.card { box-shadow: 3px 3px 6px #00000080; background-image: radial-gradient(#fff, #000); } .title { text-shadow: 0 1px 2px black; }` },
    );
    const card = byId(doc, "card", UIPanel);
    expect(card.boxShadowColor).toEqual(new Color(0, 0, 0, 128 / 255));
    expect([card.boxShadowOffsetX, card.boxShadowOffsetY, card.boxShadowBlur]).toEqual([3, 3, 6]);
    expect(card.backgroundImage).toBe("radial-gradient(#fff, #000)");
    const label = byId(doc, "label", UIText);
    expect([label.textShadowOffsetX, label.textShadowOffsetY, label.textShadowBlur]).toEqual([0, 1, 2]);
    expect(label.textShadowColor).toEqual(black);
    const play = byId(doc, "play", UIButton);
    expect([play.borderTopLeftRadius, play.borderTopRightRadius, play.borderBottomRightRadius, play.borderBottomLeftRadius]).toEqual([2, 4, 2, 4]);
    expect(play.borderRadius).toBe(6); // the button's own, untouched by per-corner values
    expect(card.borderTopLeftRadius).toBe(-1); // unset corners take borderRadius
  });
});
