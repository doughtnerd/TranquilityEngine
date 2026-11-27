// ADR 0432 (G3, text): `white-space` on plain texts and inline runs, run `:hover`/`:active`, inline boxes (padding, borders,
// margins on runs) and atomic inline boxes (inline blocks, controls, SVG and media inside text), through a Svelte view
// (`uiMarkup.ts`) laid out by the UI core and drawn by the Babylon layer.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Container } from "@babylonjs/gui/2D/controls/container.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, UIButton, UIText } from "../../myco";
import { UIPointer } from "./uiPointer";
import { World } from "../core/World";
import { UICore } from "../ui/UICore";
import { BabylonUI } from "../render/babylon/ui";
import { textRunOf } from "../ui/elementKinds";
import type { UILaidOutElement } from "../ui/uiCoreTypes";
import type { UIComponentType } from "../ui/components";
import { buildUI, byId, loadUITestSupport, type TestUI } from "./uiMarkup";

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
});

afterEach(() => {
  engine?.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

/** A UI core laid out over the active World (estimates: 0.55 em a character). */
async function laidOut(): Promise<{ core: UICore; el: (c: UIComponentType) => UILaidOutElement }> {
  const core = new UICore({ interactive: false });
  await core.ready;
  core.sync(World.require(), 800, 600);
  return { core, el: (c) => core.elements().find((e) => e.comp === c)! };
}

const lines = (e: UILaidOutElement) => e.inline!.lines.map((l) => l.fragments.map((f) => f.text).join(""));
const shown = (ui: TestUI, id: string) => textRunOf(byId(ui, id, UIText))!.text;

describe("white-space (ADR 0432)", () => {
  it("collapses, keeps or keeps only line breaks in a plain text, as each keyword says", async () => {
    const ui = buildUI(`<Canvas><div flex-direction="column" align-items="flex-start"><p id="n">  a   b\n c  </p><p id="pre" class="pre">  a   b\n c</p><p id="line" class="line">  a   b \n  c</p><p id="ps" class="ps">a\tb</p></div></Canvas>`, {
      css: `.pre { white-space: pre; } .line { white-space: pre-line; } .ps { white-space: preserve nowrap; }`,
    });
    engine.step(DT);
    expect(shown(ui, "n")).toBe("a b c");
    expect(shown(ui, "pre")).toBe("  a   b\n c");
    expect(shown(ui, "line")).toBe("a b\nc");
    expect(shown(ui, "ps")).toBe("a       b"); // a tab to the next stop of 8
    expect(byId(ui, "pre", UIText)).toMatchObject({ whiteSpaceCollapse: "preserve", textWrapMode: "nowrap" });
    const { core, el } = await laidOut();
    expect(el(byId(ui, "pre", UIText)).height).toBeCloseTo(2 * 16 * 1.2, 3);
    expect(el(byId(ui, "n", UIText)).height).toBeCloseTo(16 * 1.2, 3);
    core.dispose();
  });

  it("inherits white-space, and nowrap keeps a text on one line at any width", async () => {
    const ui = buildUI(`<Canvas><div class="keep" width="40" align-items="flex-start"><p id="t">one two three</p></div></Canvas>`, { css: `.keep { white-space: nowrap; }` });
    engine.step(DT);
    expect(byId(ui, "t", UIText).textWrapMode).toBe("nowrap");
    const { core, el } = await laidOut();
    expect(el(byId(ui, "t", UIText)).height).toBeCloseTo(16 * 1.2, 3);
    core.dispose();
  });

  it("applies each run's rules: a nowrap run stays whole, a preserved run keeps its spaces, a <br> still breaks", async () => {
    const ui = buildUI(`<Canvas><p id="t" width="80">aaaa <span class="nw">bb cc</span> dd <span class="pre">x  y</span><br/>z</p></Canvas>`, {
      css: `.nw { white-space: nowrap; } .pre { white-space: pre; }`,
    });
    engine.step(DT);
    expect(textRunOf(byId(ui, "t", UIText))!.runs!.map((r) => r.text)).toEqual(["aaaa ", "bb cc", " dd ", "x  y", "\n", "z"]);
    const { core, el } = await laidOut();
    // 8.8 px a character: "aaaa bb" would fit 80 but "bb cc" doesn't break, so it moves down whole.
    expect(lines(el(byId(ui, "t", UIText)))).toEqual(["aaaa", "bb cc dd", "x  y", "z"]);
    core.dispose();
  });

  it("break-spaces: spaces at a line's end take room there", async () => {
    const ui = buildUI(`<Canvas><div><p id="hang" width="50">abcd    efg</p><p id="keep" class="bs" width="50">abcd    efg</p></div></Canvas>`, { css: `.bs { white-space: break-spaces; }` });
    engine.step(DT);
    const { core, el } = await laidOut();
    const keep = el(byId(ui, "keep", UIText));
    // Collapsed, "abcd efg" breaks after the space (which hangs); kept, the spaces stay on the first line, taking room.
    expect(textRunOf(byId(ui, "hang", UIText))!.text).toBe("abcd efg");
    expect(lines(keep)[0]).toMatch(/^abcd +$/);
    expect(keep.inline!.lines[0].width).toBeGreaterThan(4 * 8.8);
    core.dispose();
  });
});

describe("run :hover and :active (ADR 0432)", () => {
  let pointer: UIPointer | null = null;
  beforeEach(() => Input.reset());
  afterEach(() => {
    pointer?.dispose();
    pointer = null;
    Input.reset();
  });

  it("restyles the run under the pointer (and the text it's in), and the run pressed while the button is held", async () => {
    const ui = buildUI(`<Canvas><p id="t">Go <a id="l">here</a> now</p></Canvas>`, { css: `a:hover { color: #ff0000; } a:active { color: #00ff00; } p:hover { font-weight: bold; }` });
    pointer = await UIPointer.create(World.require());
    const p = byId(ui, "t", UIText), link = byId(ui, "l", UIText);
    const linkRun = () => textRunOf(p)!.runs!.find((r) => r.owner === link)!;
    engine.step(DT);
    expect(linkRun().color).toBe("rgba(255, 255, 255, 1)");
    pointer.hover(link);
    engine.step(DT);
    engine.step(DT);
    expect(linkRun().color).toBe("rgba(255, 0, 0, 1)");
    expect(p.fontWeight).toBe("bold"); // the text the run is in is under the pointer too
    pointer.dom.pointerDown();
    engine.step(DT);
    engine.step(DT);
    expect(linkRun().color).toBe("rgba(0, 255, 0, 1)");
    pointer.dom.pointerUp();
    pointer.leave();
    engine.step(DT);
    engine.step(DT);
    expect(linkRun().color).toBe("rgba(255, 255, 255, 1)");
    expect(p.fontWeight).toBe("normal");
  });
});

describe("inline boxes: padding, borders and margins on runs (ADR 0432)", () => {
  it("lays a run's start and end sides out on the line, and gives it (not its glyphs' runs) its background", async () => {
    const ui = buildUI(`<Canvas><p id="t">Go <span id="s" class="tag">now</span>!</p></Canvas>`, {
      css: `.tag { padding: 2px 4px; border: 1px solid #ff0000; background-color: #0000ff; margin: 0 3px; border-radius: 3px; }`,
    });
    engine.step(DT);
    const p = byId(ui, "t", UIText), span = byId(ui, "s", UIText);
    const run = textRunOf(p)!;
    expect(run.boxes).toEqual([expect.objectContaining({ owner: span, margin: [3, 3], border: [1, 1, 1, 1], padding: [2, 4, 2, 4], background: "rgba(0, 0, 255, 1)", borderColor: "rgba(255, 0, 0, 1)", radius: 3 })]);
    expect(run.runs!.find((r) => r.owner === span)!.background).toBeNull(); // the box paints it
    const { core, el } = await laidOut();
    const laid = el(p).inline!;
    const [go, now, bang] = laid.lines[0].fragments;
    expect(now.x).toBeCloseTo(go.x + go.width + 3 + 1 + 4, 3);
    expect(bang.x).toBeCloseTo(now.x + now.width + 4 + 1 + 3, 3);
    // The run's element box is its border box on the line (what hit-testing and getBoundingClientRect read).
    const part = laid.lines[0].boxes![0];
    const s = core.canvases()[0].scale, r = core.rectOf(span)!, t = core.rectOf(p)!;
    expect((r.x - t.x) / s).toBeCloseTo(part.x, 3);
    expect(r.width / s).toBeCloseTo(part.width, 3);
    expect(part.width).toBeCloseTo(1 + 4 + now.width + 4 + 1, 3);
    core.dispose();
  });
});

describe("atomic inline boxes (ADR 0432)", () => {
  let pointer: UIPointer | null = null;
  beforeEach(() => Input.reset());
  afterEach(() => {
    pointer?.dispose();
    pointer = null;
    Input.reset();
  });

  it("lays a button, a field and an inline-block out on the text's lines, each its own laid-out element", async () => {
    const ui = buildUI(`<Canvas><p id="t">Press <button id="b" padding="4">Go</button> or <input id="i" width="40" value="x"/> then <span id="ib" class="ib">box <b>it</b></span>.</p></Canvas>`, {
      css: `.ib { display: inline-block; padding: 3px; background-color: #333333; }`,
    });
    engine.step(DT);
    const p = byId(ui, "t", UIText), button = byId(ui, "b", UIButton), ib = byId(ui, "ib", UIText);
    const run = textRunOf(p)!;
    const atoms = run.runs!.filter((r) => r.atom);
    expect(atoms.map((r) => r.owner)).toEqual([button, ui.query("#i")!.component, ib]);
    expect(run.text).toBe("Press ￼ or ￼ then ￼.");
    const { core, el } = await laidOut();
    const pe = el(p), be = el(button), ibe = el(ib);
    // Each is laid out (its own Yoga tree) at its content's size, and drawn where its fragment is on the line.
    const frag = (owner: UIComponentType) => pe.inline!.lines.flatMap((l) => l.fragments).find((f) => run.runs![f.run].owner === owner)!;
    const inset = pe.inline!.inset ?? { x: 0, y: 0 };
    expect(be.x).toBeCloseTo(pe.x + inset.x + frag(button).x, 3);
    expect(be.width).toBeCloseTo(frag(button).width, 3);
    expect(be.width).toBeCloseTo(2 * 4 + 2 * 0.55 * 16, 1); // "Go" and its padding
    expect(ibe.width).toBeCloseTo(2 * 3 + 0.55 * 16 * 6, 1); // "box it" (its own runs) and its padding
    // On the baseline: the button's label sits on the paragraph's baseline.
    const line = pe.inline!.lines[0];
    expect(frag(button).baseline).toBeCloseTo(line.baseline, 3);
    // Drawn after the text (on top of it), in the canvas's draw order.
    expect(be.order).toBeGreaterThan(pe.order);
    // The inline-block's own runs are laid out inside it.
    expect(ibe.inline!.lines[0].fragments.map((f) => f.text).join("")).toBe("box it");
    core.dispose();
  });

  it("takes the pointer as itself: a button in a paragraph clicks, and its events go up through the text", async () => {
    const ui = buildUI(`<Canvas><p id="t">Tap <button id="b">here</button> please</p></Canvas>`);
    pointer = await UIPointer.create(World.require());
    const button = byId(ui, "b", UIButton);
    const seen: string[] = [];
    ui.query("#t")!.on("click", (e) => seen.push(`p ${e.target === ui.query("#b") ? "from button" : "?"}`));
    expect(pointer.core.hitTest(pointer.centreOf(button).x, pointer.centreOf(button).y)).toBe(button);
    pointer.click(button);
    engine.step(DT);
    engine.step(DT);
    expect(seen).toEqual(["p from button"]);
  });

  it("wraps an atomic box to the next line like a word", async () => {
    const ui = buildUI(`<Canvas><p id="t" width="100">aaaaaaaa <button id="b">Go</button></p></Canvas>`);
    engine.step(DT);
    const { core, el } = await laidOut();
    const pe = el(byId(ui, "t", UIText)), be = el(byId(ui, "b", UIButton));
    expect(pe.inline!.lines).toHaveLength(2);
    expect(be.y).toBeGreaterThanOrEqual(pe.y + pe.inline!.lines[1].top - 1e-3);
    expect(pe.height).toBeGreaterThan(2 * 16 * 1.2 - 1e-3);
    core.dispose();
  });
});

describe("Babylon UI: drawing inline boxes and atomic boxes (ADR 0432)", () => {
  /** A 2D context that records what's drawn and measures half an em per character. */
  function recordingContext(drawn: string[]) {
    const ctx: Record<string, unknown> = { font: "16px sans-serif", canvas: null, fillStyle: "", strokeStyle: "", lineWidth: 1 };
    for (const m of ["save", "restore", "clearRect", "scale", "translate", "rotate", "closePath", "clip", "drawImage", "setTransform", "transform", "moveTo", "lineTo", "arc", "rect", "quadraticCurveTo", "arcTo"]) ctx[m] = () => undefined;
    ctx.beginPath = () => drawn.push("path");
    ctx.fill = () => drawn.push(`fill ${ctx.fillStyle}`);
    ctx.stroke = () => drawn.push(`stroke ${ctx.strokeStyle} ${ctx.lineWidth}`);
    ctx.fillText = (s: string, x: number, y: number) => drawn.push(`text ${s} ${Math.round(x)} ${Math.round(y)}`);
    ctx.strokeText = () => undefined;
    ctx.fillRect = (x: number, y: number, w: number, h: number) => drawn.push(`rect ${ctx.fillStyle} ${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}`);
    ctx.createLinearGradient = ctx.createRadialGradient = () => ({ addColorStop: () => undefined });
    ctx.measureText = (s: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(ctx.font))?.[1] ?? 16);
      return { width: s.length * size * 0.5, actualBoundingBoxAscent: size, actualBoundingBoxDescent: 0 };
    };
    return ctx;
  }

  it("draws a run's box (background, sliced border) and leaves atomic boxes to their own controls", async () => {
    const babylon = new NullEngine();
    (babylon as unknown as { createCanvas(w: number, h: number): unknown }).createCanvas = (width: number, height: number) => {
      const ctx = recordingContext([]);
      const canvas = { width, height, getContext: () => ctx, style: {}, toDataURL: () => "" };
      ctx.canvas = canvas;
      return canvas;
    };
    const scene = new Scene(babylon);
    const ui = new BabylonUI(scene, { texture: async () => new Texture("data:,", scene, { noMipmap: true }) });
    const doc = buildUI(`<Canvas><p id="t">Go <span class="tag">now</span> <button id="b">OK</button></p></Canvas>`, {
      css: `.tag { padding: 0 4px; border: 2px solid #ff0000; background-color: #0000ff; }`,
    });
    engine.step(DT);
    const core = new UICore({ interactive: false });
    await core.ready;
    core.sync(World.require(), 800, 600);
    ui.sync(World.require(), core, {}, 800, 600, 1);
    const root = ui.screen.rootContainer.children.find((c) => (c.name ?? "").startsWith("myco.canvas")) as Container;
    const block = root.children.find((c) => c.name === "t")!;
    const drawn: string[] = [];
    (block as unknown as { _draw(c: unknown): void })._draw(recordingContext(drawn));
    const el = core.elements().find((e) => e.comp === byId(doc, "t", UIText))!;
    const part = el.inline!.lines[0].boxes![0];
    const ox = el.x + (el.inline!.inset?.x ?? 0), oy = el.y + (el.inline!.inset?.y ?? 0);
    const px = Math.round(ox + part.x), py = Math.round(oy + part.top);
    expect(drawn).toContain(`rect rgba(0, 0, 255, 1) ${px} ${py} ${Math.round(part.width)} ${Math.round(part.height)}`);
    expect(drawn).toContain(`rect rgba(255, 0, 0, 1) ${px} ${py} ${Math.round(part.width)} 2`); // its top border
    // The button is a control of its own (a run's U+FFFC is never drawn as text).
    expect(drawn.some((d) => d.includes("￼"))).toBe(false);
    expect(root.children.some((c) => c.name === "b")).toBe(true);
    core.dispose();
    ui.dispose();
    scene.dispose();
    babylon.dispose();
  });
});

describe("a text's base direction from `direction` (ADR 0432)", () => {
  it("lays runs out right to left under dir=\"rtl\" (its own or an ancestor's), else in the language's direction", async () => {
    const ui = buildUI(`<Canvas><div flex-direction="column" align-items="flex-start"><div dir="rtl"><p id="r" width="100">ab <b>cd</b></p></div><p id="l" width="100">ab <b>cd</b></p><p id="own" dir="rtl" width="100">plain</p></div></Canvas>`);
    engine.step(DT);
    const r = byId(ui, "r", UIText), l = byId(ui, "l", UIText), own = byId(ui, "own", UIText);
    expect(textRunOf(r)).toMatchObject({ direction: "rtl", align: "right" });
    expect(textRunOf(l)).toMatchObject({ direction: "ltr", align: "left" });
    expect(textRunOf(own)).toMatchObject({ direction: "rtl", align: "right" });
    const { core, el } = await laidOut();
    const [ab, cd] = el(r).inline!.lines[0].fragments;
    // Logical order from the right edge: "ab " at the right, "cd" to its left.
    expect(ab.x + ab.width).toBeCloseTo(100, 3);
    expect(cd.x).toBeLessThan(ab.x);
    const [lab, lcd] = el(l).inline!.lines[0].fragments;
    expect(lab.x).toBe(0);
    expect(lcd.x).toBeGreaterThan(lab.x);
    core.dispose();
  });
});
