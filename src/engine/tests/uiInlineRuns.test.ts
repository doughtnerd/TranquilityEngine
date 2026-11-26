// ADR 0425: a text element's inline runs in UI documents (phrasing child markup inside a `Text`, bound and styled like
// any element), measured and laid out by the UI core as one paragraph and drawn by the Babylon layer from that layout;
// messages carrying the inline subset (`tHtml` escapes arguments; a document shows the text).
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Container } from "@babylonjs/gui/2D/controls/container.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Locale, MemoryStorage, tHtml, UIDocument, UIText, type ProjectSettingsInput } from "../../myco";
import { World } from "../core/World";
import { UICore } from "../ui/UICore";
import { textRunOf } from "../ui/elementKinds";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { BabylonUI } from "../render/babylon/ui";
import { buildUI, byId } from "./uiMarkup";

const DT = 1 / 60;
let engine: Engine;

afterEach(() => {
  engine?.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

describe("UI documents: inline runs in a Text (ADR 0425)", () => {
  beforeEach(async () => {
    engine = await Engine.create({ headless: true });
    await loadUIDocumentSupport();
  });

  it("makes phrasing child markup runs, styled by the cascade and HTML's defaults, with bindings in them", () => {
    const doc = buildUI(`<Canvas><Text id="t" font-size="20">You have <b id="n">{coins}</b> coins<br/>and <i class="hot">style</i>!</Text></Canvas>`, { css: `.hot { color: #ff0000; } b { text-decoration: underline; }` });
    doc.data.coins = 12;
    engine.step(DT);
    const text = byId(doc, "t", UIText);
    expect(text.text).toBe("");
    const run = textRunOf(text)!;
    expect(run.runs!.map((r) => r.text)).toEqual(["You have ", "12", " coins", "\n", "and ", "style", "!"]);
    const [, n, , , , i] = run.runs!;
    expect(n).toMatchObject({ fontWeight: "700", decoration: "underline", fontSize: 20 });
    expect(i).toMatchObject({ fontStyle: "italic", color: "rgba(255, 0, 0, 1)", fontSize: 20 });
    // A run is an element of the document (queried, styled); a text piece isn't one.
    expect(doc.query("#n")!.as(UIText).fontWeight).toBe("bold");
    expect(doc.query("#t")!.children.filter((c) => c.as(UIText)._textPiece === false).length).toBe(3);
  });

  it("collapses whitespace across runs as HTML does", () => {
    const doc = buildUI(`<Canvas><Text id="t">  one <b> two </b>  three  </Text></Canvas>`);
    expect(textRunOf(byId(doc, "t", UIText))!.runs!.map((r) => r.text)).toEqual(["one ", "two ", "three"]);
  });

  it("lays the runs out as one paragraph: wrapping across them at the text's width, the box their height", async () => {
    const doc = buildUI(`<Canvas><Text id="t" width="70">aaaa <b>bb</b>b cc dd</Text></Canvas>`);
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

describe("messages with the inline subset (ADR 0425)", () => {
  const FILES = {
    "strings/ui.strings.json": { format: "myco.strings@1", language: "en", strings: [{ key: "hud.hello", text: "Hi <b>{name}</b>, you have <i>{count, plural, one {# coin} other {# coins}}</i>" }] },
    "ui/hud.ui.xml": `<Canvas><Text id="hello" t:text="hud.hello"/></Canvas>`,
  };

  beforeEach(async () => {
    engine = await Engine.create({ headless: true, project: { languages: { list: [{ code: "en", name: "English" }], reference: "en", default: "en", useSystemLanguage: false } } as ProjectSettingsInput, assets: Assets.fromObject(FILES), storage: new MemoryStorage() });
    await loadUIDocumentSupport();
  });

  it("keeps the message's tags for {@html} and escapes string arguments", () => {
    expect(tHtml("hud.hello", { name: "<i>Bob</i> & co", count: 2 })).toBe("Hi <b>&lt;i&gt;Bob&lt;/i&gt; &amp; co</b>, you have <i>2 coins</i>");
    expect(Locale.t("hud.hello", { name: "Al", count: 1 })).toBe("Hi <b>Al</b>, you have <i>1 coin</i>");
  });

  it("shows a message's text without its tags in a UI document", async () => {
    const doc = GameObject.create("UI").addBehavior(UIDocument, { document: "asset:ui/hud.ui.xml" });
    await doc.ready;
    doc.data.name = "Al";
    doc.data.count = 3;
    engine.step(DT);
    expect(doc.query("#hello")!.as(UIText).text).toBe("Hi Al, you have 3 coins");
  });
});

describe("Babylon UI: drawing inline runs (ADR 0425)", () => {
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
    await loadUIDocumentSupport();
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
    const doc = buildUI(`<Canvas><Text id="t" color="#ffffff">Go <b>now</b> <mark>!</mark></Text></Canvas>`);
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
