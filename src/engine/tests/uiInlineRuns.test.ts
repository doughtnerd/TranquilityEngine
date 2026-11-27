// ADR 0429: a text element's inline runs (phrasing elements inside a text element, styled like any element, as a Svelte
// component renders them, ADR 0423), measured and laid out by the UI core as one paragraph and drawn by the Babylon
// layer from that layout; messages carrying the inline subset (`tHtml` escapes arguments).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Container } from "@babylonjs/gui/2D/controls/container.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Locale, MemoryStorage, tHtml, UIText, type ProjectSettingsInput } from "../../myco";
import { World } from "../core/World";
import { UICore } from "../ui/UICore";
import { textRunOf } from "../ui/elementKinds";
import { BabylonUI } from "../render/babylon/ui";
import { buildUI, byId, loadUITestSupport, uiAs } from "./uiMarkup";

const DT = 1 / 60;
let engine: Engine;

afterEach(() => {
  engine?.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

describe("inline runs in a text element (ADR 0429)", () => {
  beforeEach(async () => {
    engine = await Engine.create({ headless: true });
    await loadUITestSupport();
  });

  it("makes phrasing child elements runs, styled by the cascade and HTML's defaults", () => {
    const doc = buildUI(`<Canvas><p id="t" font-size="20">You have <b id="n">12</b> coins<br/>and <i class="hot">style</i>!</p></Canvas>`, { css: `.hot { color: #ff0000; } b { text-decoration: underline; }` });
    engine.step(DT);
    const text = byId(doc, "t", UIText);
    expect(text.text).toBe("");
    const run = textRunOf(text)!;
    expect(run.runs!.map((r) => r.text)).toEqual(["You have ", "12", " coins", "\n", "and ", "style", "!"]);
    const [, n, , , , i] = run.runs!;
    expect(n).toMatchObject({ fontWeight: "700", decoration: "underline", fontSize: 20 });
    expect(i).toMatchObject({ fontStyle: "italic", color: "rgba(255, 0, 0, 1)", fontSize: 20 });
    // A run is an element of the view (queried, styled); a text piece isn't one.
    expect(uiAs(doc.query("#n")!, UIText).fontWeight).toBe("bold");
    expect(doc.query("#t")!.children.filter((c) => uiAs(c, UIText)._textPiece === false).length).toBe(3);
  });

  it("collapses whitespace across runs as HTML does", () => {
    const doc = buildUI(`<Canvas><p id="t">  one <b> two </b>  three  </p></Canvas>`);
    expect(textRunOf(byId(doc, "t", UIText))!.runs!.map((r) => r.text)).toEqual(["one ", "two ", "three"]);
  });

  it("lays the runs out as one paragraph: wrapping across them at the text's width, the box their height", async () => {
    const doc = buildUI(`<Canvas><p id="t" width="70">aaaa <b>bb</b>b cc dd</p></Canvas>`);
    const core = new UICore({ interactive: false });
    await core.ready;
    core.sync(World.require(), 800, 600);
    const el = core.elements().find((e) => e.comp === byId(doc, "t", UIText))!;
    // 0.55 em a character at 16px: 8.8 each; "aaaa bbb" (70.4) doesn't fit 70, so "bbb" moves down whole.
    expect(el.inline!.lines.map((l) => l.fragments.map((f) => f.text).join(""))).toEqual(["aaaa", "bbb cc", "dd"]);
    expect(el.inline!.height).toBeCloseTo(3 * 16 * 1.2, 3);
    core.dispose();
  });
});

describe("messages with the inline subset (ADR 0429)", () => {
  const FILES = {
    "strings/ui.strings.json": { format: "myco.strings@1", language: "en", strings: [{ key: "hud.hello", text: "Hi <b>{name}</b>, you have <i>{count, plural, one {# coin} other {# coins}}</i>" }] },
  };

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, project: { languages: { list: [{ code: "en", name: "English" }], reference: "en", default: "en", useSystemLanguage: false } } as ProjectSettingsInput, assets: Assets.fromObject(FILES), storage: new MemoryStorage() });
    await loadUITestSupport();
  });

  it("keeps the message's tags for {@html} and escapes string arguments", () => {
    expect(tHtml("hud.hello", { name: "<i>Bob</i> & co", count: 2 })).toBe("Hi <b>&lt;i&gt;Bob&lt;/i&gt; &amp; co</b>, you have <i>2 coins</i>");
    expect(Locale.t("hud.hello", { name: "Al", count: 1 })).toBe("Hi <b>Al</b>, you have <i>1 coin</i>");
  });
});

describe("Babylon UI: drawing inline runs (ADR 0429)", () => {
  /** A 2D context that records what's drawn and measures half an em per character. */
  function recordingContext(drawn: string[]) {
    const ctx: Record<string, unknown> = { font: "16px sans-serif", canvas: null, fillStyle: "" };
    for (const m of ["save", "restore", "clearRect", "scale", "translate", "rotate", "beginPath", "closePath", "clip", "fill", "stroke", "drawImage", "setTransform", "transform", "moveTo", "lineTo", "arc", "rect", "quadraticCurveTo", "arcTo"]) ctx[m] = () => undefined;
    ctx.fillText = (s: string, x: number, y: number) => drawn.push(`text ${s} ${ctx.font} ${ctx.fillStyle} ${Math.round(x)} ${Math.round(y)}`);
    ctx.strokeText = () => undefined;
    ctx.fillRect = (x: number, y: number, w: number, h: number) => drawn.push(`rect ${ctx.fillStyle} ${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}`);
    ctx.createLinearGradient = ctx.createRadialGradient = () => ({ addColorStop: () => undefined });
    ctx.measureText = (s: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(ctx.font))?.[1] ?? 16);
      return { width: s.length * size * 0.5, actualBoundingBoxAscent: size, actualBoundingBoxDescent: 0 };
    };
    return ctx;
  }

  it("draws each fragment where the core laid it out, in its run's font and colour, with backgrounds and decorations", async () => {
    engine = await Engine.create({ headless: true });
    await loadUITestSupport();
    const drawn: string[] = [];
    const babylon = new NullEngine();
    (babylon as unknown as { createCanvas(w: number, h: number): unknown }).createCanvas = (width: number, height: number) => {
      const ctx = recordingContext([]);
      const canvas = { width, height, getContext: () => ctx, style: {}, toDataURL: () => "" };
      ctx.canvas = canvas;
      return canvas;
    };
    const scene = new Scene(babylon);
    const ui = new BabylonUI(scene, { texture: async () => new Texture("data:,", scene, { noMipmap: true }) });
    const doc = buildUI(`<Canvas><p id="t" color="#ffffff">Go <b>now</b> <mark>!</mark></p></Canvas>`);
    const core = new UICore({ interactive: false });
    await core.ready;
    core.sync(World.require(), 800, 600);
    ui.sync(World.require(), core, {}, 800, 600, 1);
    const root = ui.screen.rootContainer.children.find((c) => (c.name ?? "").startsWith("myco.canvas")) as Container;
    const block = root.children.find((c) => c.name === "t")!;
    expect((block as unknown as { text: string }).text).toBe(""); // the runs are drawn, not the block's own text
    (block as unknown as { _draw(c: unknown): void })._draw(recordingContext(drawn));
    const el = core.elements().find((e) => e.comp === byId(doc, "t", UIText))!;
    const [go, now, , mark] = el.inline!.lines[0].fragments;
    expect(drawn).toContain(`text Go  400 16px Inter, system-ui, sans-serif rgba(255, 255, 255, 1) ${Math.round(go.x)} ${Math.round(go.baseline)}`);
    expect(drawn).toContain(`text now 700 16px Inter, system-ui, sans-serif rgba(255, 255, 255, 1) ${Math.round(now.x)} ${Math.round(now.baseline)}`);
    // <mark>: a yellow background behind its glyphs, black text.
    expect(drawn).toContain(`rect rgba(255, 255, 0, 1) ${Math.round(mark.x)} ${Math.round(mark.top)} ${Math.round(mark.width)} ${Math.round(mark.height)}`);
    expect(drawn.some((d) => d.startsWith("text ! 400 16px") && d.includes("rgba(0, 0, 0, 1)"))).toBe(true);
    core.dispose();
    ui.dispose();
    scene.dispose();
    babylon.dispose();
  });
});
