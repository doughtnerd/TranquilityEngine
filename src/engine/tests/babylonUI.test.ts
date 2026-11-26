// ADR 0076: the Babylon GUI drawing layer, run headless on Babylon's NullEngine. A fake UICoreLike
// feeds it real UI components; the GUI needs a 2D canvas, so `createCanvas` returns a stub context.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import type { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import type { Image } from "@babylonjs/gui/2D/controls/image.js";
import type { Container } from "@babylonjs/gui/2D/controls/container.js";
import { Control } from "@babylonjs/gui/2D/controls/control.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../core/World";
import { Assets, Color, Engine, GameObject, Input, Locale, type ProjectSettingsInput } from "../index";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../ui/components";
import type { UIComponentType } from "../ui/components";
import { textRunOf, uiKindOf } from "../ui/elementKinds";
import type { UICoreLike, UILaidOutCanvas, UILaidOutElement } from "../ui/uiCoreTypes";
import { BabylonUI, measureText } from "../render/babylon/ui";
import { flipRows, redrawnPixels } from "../render/pixelRegions";
import { loadBundledFont } from "../ui/fonts";
import { UIPointer } from "./uiPointer";
import { loadUIDocumentSupport } from "../ui/UIDocument";
import { uiElement } from "./uiMarkup";

/** A 2D context that draws nothing and measures half an em per character. */
function fakeContext() {
  const ctx: Record<string, unknown> = { font: "16px sans-serif", canvas: null };
  const noop = () => undefined;
  for (const m of ["save", "restore", "clearRect", "fillRect", "scale", "translate", "rotate", "beginPath", "closePath", "clip", "fill", "stroke", "fillText", "strokeText", "drawImage", "setTransform", "moveTo", "lineTo", "arc", "rect", "quadraticCurveTo", "arcTo"]) ctx[m] = noop;
  ctx.measureText = (s: string) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(ctx.font))?.[1] ?? 16);
    return { width: s.length * size * 0.5, actualBoundingBoxAscent: size, actualBoundingBoxDescent: 0 };
  };
  return ctx;
}

function fakeCanvas(width: number, height: number) {
  const ctx = fakeContext();
  const canvas = { width, height, getContext: () => ctx, style: {}, toDataURL: () => "" };
  ctx.canvas = canvas;
  return canvas;
}

let engine: Engine;
let babylon: NullEngine;
let scene: Scene;
let ui: BabylonUI;
const loaded: string[] = [];

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
  babylon = new NullEngine();
  (babylon as unknown as { createCanvas: typeof fakeCanvas }).createCanvas = fakeCanvas;
  scene = new Scene(babylon);
  loaded.length = 0;
  ui = new BabylonUI(scene, {
    texture: async (ref) => {
      loaded.push(ref);
      return new Texture("data:,", scene, { noMipmap: true });
    },
  });
});

afterEach(() => {
  ui.dispose();
  scene.dispose();
  babylon.dispose();
  engine.dispose();
  Assets.clearSources();
});

/** One element (ADR 0417: built by a UI document), its fields then written as a script writes them. */
const node = uiElement;

function canvasInfo(comp: UICanvas, over: Partial<UILaidOutCanvas> = {}): UILaidOutCanvas {
  return { comp, mode: comp.mode, sortOrder: comp.sortOrder, width: 1280, height: 720, scale: 1, pixelSize: comp.pixelSize, worldMatrix: null, visible: true, ...over };
}

type ElementInit = Partial<Pick<UILaidOutElement, "x" | "y" | "width" | "height" | "visible" | "opacity">>;

/** A fake core reporting these canvases and elements (orders count up per canvas; text runs resolved as the core resolves them, on each read). */
class FakeCore implements UICoreLike {
  layoutVersion = 0;
  hasScreenUI = true;
  private cs: UILaidOutCanvas[] = [];
  private es: UILaidOutElement[] = [];
  set(canvases: UILaidOutCanvas[], elements: Array<[UIComponentType, UICanvas, ElementInit?]>): void {
    this.cs = canvases;
    const orders = new Map<UICanvas, number>();
    this.es = elements.map(([comp, canvas, init = {}]) => {
      const order = orders.get(canvas) ?? 0;
      orders.set(canvas, order + 1);
      return { comp, kind: uiKindOf(comp), canvas, x: 0, y: 0, width: 100, height: 40, order, visible: true, opacity: 1, text: null, ...init } as UILaidOutElement;
    });
    this.layoutVersion++;
  }
  sync(): void {}
  canvases() { return this.cs; }
  elements() { return this.es.map((e) => ({ ...e, text: textRunOf(e.comp) })); }
  rectOf() { return null; }
  hitTest() { return null; }
  pickAll() { return []; }
  pickCanvases() { return []; }
  cornersOf() { return null; }
  release(): void {}
  dispose(): void {}
}

const sync = (core: FakeCore, extra: Parameters<BabylonUI["sync"]>[2] = {}, w = 1280, h = 720, pr = 1) => ui.sync(World.require(), core, extra, w, h, pr);
const screenRoots = () => ui.screen.rootContainer.children.filter((c) => (c.name ?? "").startsWith("myco.canvas")) as Container[];
const rootOf = (n = 0) => screenRoots()[n];
const byName = (root: Container, name: string) => root.children.find((c) => c.name === name)!;

describe("screen canvases on Babylon GUI (ADR 0076)", () => {
  it("makes a standalone fullscreen texture and a root container per canvas, scaled by scale x pixel ratio", () => {
    expect(ui.screen.useStandalone).toBe(true);
    expect(ui.screen.disablePicking).toBe(true);
    expect(ui.screen.disableTabNavigation).toBe(true);
    const canvas = node("C", null, UICanvas, { sortOrder: 3 });
    const core = new FakeCore();
    core.set([canvasInfo(canvas, { width: 640, height: 360, scale: 2 })], []);
    sync(core, {}, 1280, 720, 1.5);
    const root = rootOf();
    expect(root.zIndex).toBe(3);
    expect(root.widthInPixels).toBe(640);
    expect(root.heightInPixels).toBe(360);
    expect(root.scaleX).toBe(3);
    expect(root.scaleY).toBe(3);
    expect(root.transformCenterX).toBe(0);
    expect(root.transformCenterY).toBe(0);
  });

  it("maps a panel to a Rectangle at its box, with colours, border, radius and opacity", () => {
    const canvas = node("C", null, UICanvas);
    const panel = node("P", canvas.node, UIPanel, { backgroundColor: new Color(1, 0, 0, 0.5), borderRadius: 6, borderWidth: 2, borderColor: new Color(0, 0, 1, 1) });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[panel, canvas, { x: 10, y: 20, width: 200, height: 80, opacity: 0.5 }]]);
    sync(core);
    const r = byName(rootOf(), "P") as Rectangle;
    expect(r.getClassName()).toBe("Rectangle");
    expect([r.leftInPixels, r.topInPixels, r.widthInPixels, r.heightInPixels]).toEqual([10, 20, 200, 80]);
    expect(r.horizontalAlignment).toBe(0); // left
    expect(r.verticalAlignment).toBe(0); // top
    expect(r.background).toBe("rgba(255, 0, 0, 0.5)");
    expect(r.color).toBe("rgba(0, 0, 255, 1)");
    expect(r.thickness).toBe(2);
    expect(r.cornerRadius).toBe(6);
    expect(r.alpha).toBe(0.5);
  });

  it("follows a changed box and a changed component without recreating the control", () => {
    const canvas = node("C", null, UICanvas);
    const panel = node("P", canvas.node, UIPanel, { backgroundColor: new Color(1, 1, 1, 1) });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[panel, canvas]]);
    sync(core);
    const first = byName(rootOf(), "P") as Rectangle;
    panel.backgroundColor = new Color(0, 1, 0, 1);
    core.set([canvasInfo(canvas)], [[panel, canvas, { x: 5, width: 50 }]]);
    sync(core);
    const again = byName(rootOf(), "P") as Rectangle;
    expect(again).toBe(first);
    expect(again.background).toBe("rgba(0, 255, 0, 1)");
    expect([again.leftInPixels, again.widthInPixels]).toEqual([5, 50]);
  });

  it("orders controls by the core's order and canvases by sortOrder", () => {
    const low = node("Low", null, UICanvas, { sortOrder: 1 });
    const high = node("High", null, UICanvas, { sortOrder: 9 });
    const a = node("A", low.node, UIPanel);
    const b = node("B", low.node, UIPanel);
    const core = new FakeCore();
    core.set([canvasInfo(low), canvasInfo(high)], [[a, low], [b, low]]);
    sync(core);
    const lowRoot = ui.screen.rootContainer.children.find((c) => c.name === "myco.canvas.Low") as Container;
    expect(byName(lowRoot, "A").zIndex).toBe(0);
    expect(byName(lowRoot, "B").zIndex).toBe(1);
    expect(lowRoot.zIndex).toBe(1);
    expect(ui.screen.rootContainer.children.find((c) => c.name === "myco.canvas.High")!.zIndex).toBe(9);
  });

  it("hides hidden elements and canvases", () => {
    const canvas = node("C", null, UICanvas);
    const panel = node("P", canvas.node, UIPanel);
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[panel, canvas, { visible: false }]]);
    sync(core);
    expect(byName(rootOf(), "P").isVisible).toBe(false);
    core.set([canvasInfo(canvas, { visible: false })], [[panel, canvas]]);
    sync(core);
    expect(byName(rootOf(), "P").isVisible).toBe(true);
    expect(rootOf().isVisible).toBe(false);
  });

  it("colours a button by hovered and pressed like UIRuntime", async () => {
    const canvas = node("C", null, UICanvas);
    const button = node("B", canvas.node, UIButton, { backgroundColor: new Color(0.2, 0.2, 0.2, 1), hoverColor: new Color(0, 1, 0, 1), pressedColor: new Color(0, 0, 1, 1), width: "100", height: "40" });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[button, canvas]]);
    const bg = () => (byName(rootOf(), "B") as Rectangle).background;
    // The hover and press come from a real UI core routing the pointer; the fake core lays out the drawing.
    const pointer = await UIPointer.create(World.require());
    try {
      sync(core);
      expect(bg()).toBe("rgba(51, 51, 51, 1)");
      pointer.hover(button);
      engine.step(1 / 60);
      sync(core);
      expect(bg()).toBe("rgba(0, 255, 0, 1)");
      pointer.dom.pointerDown(0);
      engine.step(1 / 60);
      sync(core);
      expect(bg()).toBe("rgba(0, 0, 255, 1)");
      pointer.leave(); // pressed, but the pointer left: the plain colour
      engine.step(1 / 60);
      sync(core);
      expect(button.pressed).toBe(true);
      expect(bg()).toBe("rgba(51, 51, 51, 1)");
      pointer.hover(button);
      button.interactable = false;
      engine.step(1 / 60);
      sync(core);
      expect(bg()).toBe("rgba(51, 51, 51, 1)");
    } finally {
      pointer.dispose();
    }
  });

  it("draws focus colours only while the last UI input was navigation, not the pointer (ADR 0340)", async () => {
    const canvas = node("C", null, UICanvas);
    const grey = new Color(0.2, 0.2, 0.2, 1);
    const first = node("First", canvas.node, UIButton, { backgroundColor: grey, hoverColor: new Color(0, 1, 0, 1), focusColor: new Color(1, 0, 0, 1), width: "100", height: "40", positionType: "absolute", left: "0", top: "0" });
    const second = node("Second", canvas.node, UIButton, { backgroundColor: grey, hoverColor: new Color(0, 1, 0, 1), focusColor: new Color(1, 0, 0, 1), width: "100", height: "40", positionType: "absolute", left: "0", top: "100" });
    const field = node("Field", canvas.node, UIInputField, { borderColor: new Color(1, 1, 1, 1), focusColor: new Color(0, 0, 1, 1), width: "200", height: "40", positionType: "absolute", left: "0", top: "200" });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[first, canvas], [second, canvas], [field, canvas]]);
    const bg = (name: string) => (byName(rootOf(), name) as Rectangle).background;
    const border = (name: string) => (byName(rootOf(), name) as Rectangle).color;
    const frame = () => {
      engine.step(1 / 60);
      sync(core);
    };
    // The real core lays the UI out for navigation and routes the pointer; the fake core lays out the drawing.
    const pointer = await UIPointer.create(World.require());
    try {
      pointer.leave(); // off every button
      first.focused = true; // a script's focus: no navigation yet, no colour
      frame();
      expect(bg("First")).toBe("rgba(51, 51, 51, 1)");
      Input.inject.keyDown("arrowdown");
      frame();
      Input.inject.keyUp("arrowdown");
      frame();
      expect(second.focused).toBe(true);
      expect(bg("Second")).toBe("rgba(255, 0, 0, 1)");
      expect(bg("First")).toBe("rgba(51, 51, 51, 1)");
      Input.inject.keyDown("arrowdown");
      frame();
      Input.inject.keyUp("arrowdown");
      frame();
      expect(field.focused).toBe(true);
      expect(border("Field")).toBe("rgba(0, 0, 255, 1)");
      expect(bg("Second")).toBe("rgba(51, 51, 51, 1)");
      pointer.dom.moveTo(600, 600); // the pointer moves (over nothing): it's the last UI input now
      frame();
      expect(field.focused).toBe(true);
      expect(border("Field")).toBe("rgba(255, 255, 255, 1)");
      pointer.click(second); // focused by a click: hovered, never the focus colour
      frame();
      pointer.leave();
      frame();
      expect(second.focused).toBe(true);
      expect(bg("Second")).toBe("rgba(51, 51, 51, 1)");
    } finally {
      Input.inject.releaseAll();
      pointer.dispose();
    }
  });

  it("maps UIText to a TextBlock with font, colour, alignment and wrapping", () => {
    const canvas = node("C", null, UICanvas);
    const text = node("T", canvas.node, UIText, { text: "Hello world", fontSize: 24, fontWeight: "bold", textAlign: "center", color: new Color(1, 1, 0, 1) });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[text, canvas, { x: 4, y: 6, width: 120, height: 29 }]]);
    sync(core);
    const t = byName(rootOf(), "T") as TextBlock;
    expect(t.getClassName()).toBe("TextBlock");
    expect([t.leftInPixels, t.topInPixels, t.widthInPixels, t.heightInPixels]).toEqual([4, 6, 120, 29]);
    expect(t.text).toBe("Hello world");
    expect(t.fontSizeInPixels).toBe(24);
    expect(t.fontWeight).toBe("700");
    expect(t.fontFamily).toBe("Inter, system-ui, sans-serif");
    expect(t.color).toBe("rgba(255, 255, 0, 1)");
    expect(t.textHorizontalAlignment).toBe(2); // center
    expect(t.textWrapping).toBe(1); // word wrap
    expect(t.resizeToFit).toBe(false);
    text.wordBreak = "keep-all";
    text.text = "Bye";
    sync(core);
    expect(t.textWrapping).toBe(0); // clip
    expect(t.text).toBe("Bye");
  });

  it("uses the font a UIText or UIInputField names, after which Inter", () => {
    const canvas = node("C", null, UICanvas);
    const text = node("T", canvas.node, UIText, { text: "Ahoy", font: "asset:fonts/Pirata.ttf" });
    const field = node("F", canvas.node, UIInputField, { placeholder: "Name", font: "fonts/Pirata.ttf" });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[text, canvas], [field, canvas]]);
    sync(core);
    expect((byName(rootOf(), "T") as TextBlock).fontFamily).toBe("myco-font-fonts-Pirata-ttf, Inter, system-ui, sans-serif");
    expect(((byName(rootOf(), "F") as Rectangle).children[0] as TextBlock).fontFamily).toBe("myco-font-fonts-Pirata-ttf, Inter, system-ui, sans-serif");
  });

  it("redraws every text when a font arrives (font heights measured before it are forgotten)", async () => {
    class FakeFontFace {
      constructor(readonly family: string) {}
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    vi.stubGlobal("document", { fonts: { add: () => undefined, delete: () => true } });
    // The bundled font hasn't loaded in this file yet (each test file gets its own modules), so it loads now.
    try {
      const canvas = node("C", null, UICanvas);
      const text = node("T", canvas.node, UIText, { text: "Hello" });
      const core = new FakeCore();
      core.set([canvasInfo(canvas)], [[text, canvas]]);
      sync(core);
      const sizes = (Control as unknown as { _FontHeightSizes: Record<string, unknown> })._FontHeightSizes;
      sizes["400 16px Inter, system-ui, sans-serif"] = { ascent: 1, height: 1, descent: 0 };
      const dirty = vi.spyOn(ui.screen.rootContainer, "_markAllAsDirty");
      await loadBundledFont();
      expect(dirty).toHaveBeenCalled();
      expect(Object.keys(sizes)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps UIImage to an Image, loading the sprite's path, with fit as a stretch mode", async () => {
    const canvas = node("C", null, UICanvas);
    const image = node("I", canvas.node, UIImage, { image: "asset:images/logo.png#frame_2", fit: "contain" });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[image, canvas, { width: 64, height: 32 }]]);
    sync(core);
    await new Promise((r) => setTimeout(r, 0));
    const img = byName(rootOf(), "I") as Image;
    expect(img.getClassName()).toBe("Image");
    expect(loaded).toEqual(["images/logo.png"]);
    expect(img.source).toBe("data:,"); // the loaded texture's URL (this once never arrived)
    expect(img.stretch).toBe(2); // uniform
    image.fit = "fill";
    sync(core);
    expect(img.stretch).toBe(1);
    expect(loaded).toEqual(["images/logo.png"]); // not requested again
    image.fit = "cover";
    sync(core);
    expect(img.stretch).toBe(1); // cover fills and crops the source
  });

  it("draws an input field's value or placeholder, with a caret at the prefix width when focused", () => {
    const canvas = node("C", null, UICanvas);
    const field = node("F", canvas.node, UIInputField, { placeholder: "Name", value: "", fontSize: 20, padding: 8, borderWidth: 1 });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[field, canvas, { width: 240, height: 36 }]]);
    sync(core, { caretOf: () => 0 });
    const r = byName(rootOf(), "F") as Rectangle;
    const label = r.children.find((c) => c.name === "F.text") as TextBlock;
    const caret = r.children.find((c) => c.name === "F.caret") as Rectangle;
    expect(label.text).toBe("Name");
    expect(label.color).toBe(field.placeholderColor.toCss());
    expect(label.widthInPixels).toBe(240 - 2 * (1 + 8));
    expect(label.leftInPixels).toBe(8);
    expect(caret.isVisible).toBe(false); // not focused

    // The stub canvas measures half an em per character; Node has no OffscreenCanvas, so the
    // caret's prefix comes from the per-character estimate (0.55 em).
    field.value = "abcd";
    field.focused = true;
    sync(core, { caretOf: () => 2 });
    expect(label.text).toBe("abcd");
    expect(label.color).toBe(field.color.toCss());
    expect(caret.isVisible).toBe(true);
    expect(caret.leftInPixels).toBeCloseTo(8 + 2 * 20 * 0.55);
    expect(caret.widthInPixels).toBe(1);
    expect(caret.heightInPixels).toBeCloseTo(20 * 1.2);
    sync(core, { caretOf: () => null });
    expect(caret.isVisible).toBe(false);
  });

  it("removes controls of vanished elements, released components and gone canvases", () => {
    const canvas = node("C", null, UICanvas);
    const a = node("A", canvas.node, UIPanel);
    const b = node("B", canvas.node, UIPanel);
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[a, canvas], [b, canvas]]);
    sync(core);
    expect(rootOf().children.map((c) => c.name)).toEqual(["A", "B"]);
    core.set([canvasInfo(canvas)], [[b, canvas]]);
    sync(core);
    expect(rootOf().children.map((c) => c.name)).toEqual(["B"]);
    ui.release(b);
    expect(rootOf().children).toHaveLength(0);
    core.set([], []);
    sync(core);
    expect(rootOf()).toBeUndefined();
  });
});

describe("world canvases on Babylon GUI (ADR 0076)", () => {
  const matrix = (): Float32Array => {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = 3;
    m[13] = 2;
    m[14] = -5;
    return m;
  };

  it("makes a plane sized width x height x pixelSize at the node's matrix, with a texture at twice the resolution", () => {
    const canvas = node("W", null, UICanvas, { mode: "world", pixelSize: 0.01 });
    const panel = node("P", canvas.node, UIPanel);
    const core = new FakeCore();
    core.set([canvasInfo(canvas, { width: 200, height: 100, scale: 1, worldMatrix: matrix() })], [[panel, canvas, { x: 10, y: 20, width: 50, height: 30 }]]);
    sync(core);
    const mesh = scene.getMeshByName("myco.canvas.W")!;
    expect(mesh).toBeTruthy();
    const box = mesh.getBoundingInfo().boundingBox;
    expect(box.maximum.x - box.minimum.x).toBeCloseTo(2);
    expect(box.maximum.y - box.minimum.y).toBeCloseTo(1);
    mesh.computeWorldMatrix(true);
    expect([mesh.getWorldMatrix().m[12], mesh.getWorldMatrix().m[13], mesh.getWorldMatrix().m[14]]).toEqual([3, 2, -5]);
    expect(mesh.isWorldMatrixFrozen).toBe(true);
    expect(mesh.isPickable).toBe(false);
    const texture = (mesh.material as unknown as { emissiveTexture: { getSize(): { width: number; height: number }; rootContainer: Container } }).emissiveTexture;
    // NullEngine rounds texture sizes up to a power of two (and caps them at 512); a real GPU keeps them.
    expect(texture.getSize().width).toBeGreaterThanOrEqual(200 * 2);
    expect(texture.getSize().height).toBeGreaterThanOrEqual(100 * 2);
    const root = texture.rootContainer.children[0] as Container;
    expect(root.scaleX).toBe(2); // world canvases draw at twice their reference resolution
    const r = root.children.find((c) => c.name === "P")!;
    expect([r.leftInPixels, r.topInPixels, r.widthInPixels, r.heightInPixels]).toEqual([10, 20, 50, 30]);
    expect(rootOf()).toBeUndefined(); // not on the screen texture
  });

  it("follows a moved node and a resized canvas, hides with its canvas, and goes with it", () => {
    const canvas = node("W", null, UICanvas, { mode: "world" });
    const core = new FakeCore();
    core.set([canvasInfo(canvas, { width: 100, height: 100, worldMatrix: matrix() })], []);
    sync(core);
    const mesh = scene.getMeshByName("myco.canvas.W")!;
    const moved = matrix();
    moved[12] = 9;
    core.set([canvasInfo(canvas, { width: 200, height: 100, worldMatrix: moved, visible: false })], []);
    sync(core);
    expect(scene.getMeshByName("myco.canvas.W")).toBe(mesh);
    expect(mesh.getWorldMatrix().m[12]).toBe(9);
    expect(mesh.getBoundingInfo().boundingBox.maximum.x).toBeCloseTo(1);
    expect(mesh.isEnabled()).toBe(false);
    core.set([], []);
    sync(core);
    expect(scene.getMeshByName("myco.canvas.W")).toBeNull();
  });
});

describe("a UIText's outline (ADR 0417)", () => {
  const outlined = (init: Partial<UIText>, scale = 1, pixelRatio = 1) => {
    const canvas = node("C", null, UICanvas);
    const text = node("T", canvas.node, UIText, { text: "Score", fontSize: 30, ...init });
    const core = new FakeCore();
    core.set([canvasInfo(canvas, { scale })], [[text, canvas, { x: 100, y: 50, width: 200, height: 36 }]]);
    sync(core, {}, 1280, 720, pixelRatio);
    return { text, core, block: byName(rootOf(), "T") as TextBlock };
  };

  it("draws none by default, or with a colour but no width", () => {
    const plain = outlined({});
    expect(plain.block.outlineWidth).toBe(0);
    plain.text.textOutlineColor = new Color(0, 0, 0, 1);
    sync(plain.core);
    expect(plain.block.outlineWidth).toBe(0);
  });

  it("strokes twice the width centred on the glyph edge, in UI pixels, so the canvas's scale scales it with the font", () => {
    const { block, text, core } = outlined({ textOutlineColor: new Color(0, 0, 0, 1), textOutlineWidth: 3 }, 2, 1.5);
    expect(block.outlineWidth).toBe(6);
    expect(block.outlineColor).toBe("rgba(0, 0, 0, 1)");
    expect(block.fontSizeInPixels).toBe(30); // both in UI pixels: the canvas root is scaled by scale × pixel ratio
    expect(rootOf().scaleX).toBe(3);
    text.textOutlineColor = new Color(1, 0, 0, 1);
    text.textOutlineWidth = 1;
    sync(core, {}, 1280, 720, 1.5);
    expect(block.outlineWidth).toBe(2);
    expect(block.outlineColor).toBe("rgba(255, 0, 0, 1)");
    text.textOutlineWidth = 0;
    sync(core, {}, 1280, 720, 1.5);
    expect(block.outlineWidth).toBe(0);
  });

  it("redraws past the box when an outlined text is cleared, so the outline doesn't stay behind", () => {
    // Babylon grows a control's old box by its left and top padding only; the block widens the redraw by its outline.
    ui.screen.scaleTo(1280, 720);
    const { block, text, core } = outlined({ text: "Press Space or click to flap", textOutlineColor: new Color(0, 0, 0, 1), textOutlineWidth: 5 });
    ui.screen._checkUpdate(null);
    const box = { left: block.leftInPixels, top: block.topInPixels, right: block.leftInPixels + block.widthInPixels, bottom: block.topInPixels + block.heightInPixels };
    const rects: number[][] = [];
    const invalidate = ui.screen.invalidateRect.bind(ui.screen);
    ui.screen.invalidateRect = (...r: [number, number, number, number]) => {
      rects.push(r);
      invalidate(...r);
    };
    text.text = "";
    sync(core);
    ui.screen._checkUpdate(null);
    expect(rects.length).toBeGreaterThan(0);
    expect(Math.min(...rects.map((r) => r[0]))).toBeLessThanOrEqual(box.left - 5);
    expect(Math.min(...rects.map((r) => r[1]))).toBeLessThanOrEqual(box.top - 5);
    expect(Math.max(...rects.map((r) => r[2]))).toBeGreaterThanOrEqual(box.right + 5);
    expect(Math.max(...rects.map((r) => r[3]))).toBeGreaterThanOrEqual(box.bottom + 5);
  });
});

describe("measureText", () => {
  const req = (over: Partial<Parameters<typeof measureText>[0]> = {}) => ({ text: "hello world", fontSize: 10, fontWeight: "400", fontFamily: "Inter", lineHeight: 1.2, wrap: "word" as const, maxWidth: Infinity, ...over });
  const g = globalThis as unknown as { OffscreenCanvas?: unknown };
  /** The module freshly loaded, as a page loads it: it looks for a canvas on first use and keeps what it found. */
  const freshMeasure = async (): Promise<typeof measureText> => {
    vi.resetModules();
    return (await import("../render/babylon/ui")).measureText;
  };
  const withCanvas = async (run: (measure: typeof measureText) => void) => {
    g.OffscreenCanvas = class {
      getContext() {
        return fakeContext();
      }
    };
    try {
      run(await freshMeasure());
    } finally {
      delete g.OffscreenCanvas;
    }
  };

  it("estimates without a canvas, and measures with one", async () => {
    const estimated = (await freshMeasure())(req());
    expect(estimated.height).toBeCloseTo(12);
    expect(estimated.width).toBeGreaterThan(0);
    await withCanvas((measure) => {
      expect(measure(req())).toEqual({ width: 55 * 1.05 + 1, height: 12 }); // 11 characters x 5 px, with the room layout gets
      expect(measure(req({ text: "" }))).toEqual({ width: 0, height: 12 });
    });
  });

  it("wraps at spaces to maxWidth and counts lines", async () => {
    await withCanvas((measure) => {
      expect(measure(req({ maxWidth: 30 }))).toEqual({ width: 25 * 1.05 + 1, height: 24 }); // "hello" / "world"
      expect(measure(req({ text: "a\nb\nc" })).height).toBeCloseTo(36);
      expect(measure(req({ text: "unbreakable", maxWidth: 20 }))).toEqual({ width: 55 * 1.05 + 1, height: 12 }); // overflows
    });
  });

  it("wraps a run at any character for wrap anywhere, and never for wrap none", async () => {
    await withCanvas((measure) => {
      // "unbreakable" at 5 px a character, 20 px wide: three letters fit 20 / 1.05 (19 px), so four lines.
      expect(measure(req({ text: "unbreakable", maxWidth: 20, wrap: "anywhere" })).height).toBeCloseTo(48);
      expect(measure(req({ maxWidth: 30, wrap: "none" }))).toEqual({ width: 55 * 1.05 + 1, height: 12 }); // one line, not "hello" / "world"
    });
  });

  it("wraps CJK text between characters, keeping closing punctuation off a line's start (ADR 0356 §5)", async () => {
    await withCanvas((measure) => {
      // 5 px a character, 25 px wide: four characters fit 25 / 1.05; "。" can't start the third line, so "ト" goes with it.
      expect(measure(req({ text: "日本語のテキスト。", maxWidth: 25 })).height).toBeCloseTo(36);
      expect(measure(req({ text: "日本語のテキスト", maxWidth: 25 })).height).toBeCloseTo(24);
    });
  });

  it("draws text aligned start from the language's start edge, in its direction (ADR 0356 §5)", async () => {
    engine.dispose();
    engine = await Engine.create({ headless: true, project: { languages: { list: [{ code: "en", name: "English" }, { code: "ar", name: "العربية" }], useSystemLanguage: false } } as ProjectSettingsInput });
    const canvas = node("C", null, UICanvas);
    const text = node("T", canvas.node, UIText, { text: "مرحبا" });
    const field = node("F", canvas.node, UIInputField, { value: "نص" });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[text, canvas], [field, canvas]]);
    sync(core);
    const t = byName(rootOf(), "T") as TextBlock;
    const label = (byName(rootOf(), "F") as Rectangle).children[0] as TextBlock;
    expect([t.textHorizontalAlignment, label.textHorizontalAlignment]).toEqual([Control.HORIZONTAL_ALIGNMENT_LEFT, Control.HORIZONTAL_ALIGNMENT_LEFT]);
    await Locale.setLanguage("ar");
    sync(core);
    expect([t.textHorizontalAlignment, label.textHorizontalAlignment]).toEqual([Control.HORIZONTAL_ALIGNMENT_RIGHT, Control.HORIZONTAL_ALIGNMENT_RIGHT]);
    text.textAlign = "end";
    sync(core);
    expect(t.textHorizontalAlignment).toBe(Control.HORIZONTAL_ALIGNMENT_LEFT);
  });

  it("draws the run's CSS weight, the one the core measured", () => {
    const weights = ["light", "normal", "medium", "semi-bold", "bold", "650", "odd"];
    const canvas = node("C", null, UICanvas);
    const texts = weights.map((fontWeight, i) => node(`T${i}`, canvas.node, UIText, { text: "Hi", fontWeight }));
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], texts.map((t) => [t, canvas] as [UIText, UICanvas]));
    sync(core);
    expect(texts.map((_, i) => (byName(rootOf(), `T${i}`) as TextBlock).fontWeight)).toEqual(["300", "400", "500", "600", "700", "650", "400"]);
  });
});

describe("the editor's camera preview UI (ADR 0076)", () => {
  it("draws screen canvases at the inset's origin, and leaves world canvases to the main layer", () => {
    const preview = new BabylonUI(scene, { texture: async () => new Texture("data:,", scene, { noMipmap: true }), screenOnly: true });
    try {
      const screenCanvas = node("S", null, UICanvas);
      const worldCanvas = node("W", null, UICanvas, { mode: "world" });
      const panel = node("P", screenCanvas.node, UIPanel);
      const core = new FakeCore();
      core.set([canvasInfo(screenCanvas, { width: 320, height: 180, scale: 0.5 }), canvasInfo(worldCanvas, { worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) })], [[panel, screenCanvas]]);
      preview.sync(World.require(), core, {}, 160, 90, 2, { x: 1000, y: 500 });
      expect(scene.getMeshByName("myco.canvas.W")).toBeNull();
      const roots = preview.screen.rootContainer.children.filter((c) => (c.name ?? "").startsWith("myco.canvas")) as Container[];
      expect(roots.map((r) => r.name)).toEqual(["myco.canvas.S"]);
      expect([roots[0].leftInPixels, roots[0].topInPixels, roots[0].scaleX]).toEqual([2000, 1000, 1]); // texture pixels: CSS × pixel ratio
    } finally {
      preview.dispose();
    }
  });
});

describe("uploading only the redrawn part of the screen UI (ADR 0075 notes)", () => {
  it("covers the whole pixels of the invalidated rectangle, a pixel wider, inside the texture", () => {
    expect(redrawnPixels({ left: 10.4, top: 20.6, width: 30.2, height: 5 }, 100, 100)).toEqual({ x: 9, y: 19, width: 33, height: 8 });
    expect(redrawnPixels({ left: -5, top: -5, width: 20, height: 20 }, 100, 100)).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(redrawnPixels({ left: 90, top: 95, width: 50, height: 50 }, 100, 100)).toEqual({ x: 89, y: 94, width: 11, height: 6 });
    expect(redrawnPixels({ left: 150, top: 10, width: 10, height: 10 }, 100, 100)).toBeNull();
  });

  it("flips rows for a texture that's uploaded upside down, reusing its buffer", () => {
    const pixels = new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]); // three one-pixel rows
    const buffer = new Uint8Array(16);
    const out = flipRows(pixels, 4, 3, buffer);
    expect(out).toBe(buffer);
    expect(Array.from(out.subarray(0, 12))).toEqual([3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
    expect(flipRows(pixels, 4, 3, new Uint8Array(4)).length).toBe(12); // grown when too small
  });

  it("makes the GUI's canvas with willReadFrequently on WebGPU, where its redrawn part is read back (ADR 0120)", () => {
    const contexts: unknown[] = [];
    const createCanvas = (width: number, height: number) => {
      const canvas = fakeCanvas(width, height);
      const ctx = canvas.getContext();
      return { ...canvas, getContext: (_kind: string, options?: unknown) => (contexts.push(options ?? null), ctx) };
    };
    const gpu = new NullEngine();
    (gpu as unknown as { createCanvas: typeof createCanvas }).createCanvas = createCanvas;
    Object.defineProperty(gpu, "isWebGPU", { value: true }); // the engine kind is all it checks
    const gpuScene = new Scene(gpu);
    const gpuUI = new BabylonUI(gpuScene, { texture: () => Promise.reject(new Error("no textures")) });
    expect(contexts[0]).toEqual({ willReadFrequently: true }); // the first context decides
    expect(gpu.createCanvas).toBe(createCanvas); // put back
    gpuUI.dispose();
    gpuScene.dispose();
    gpu.dispose();
    // Other engines' canvases are left alone.
    contexts.length = 0;
    const gl = new NullEngine();
    (gl as unknown as { createCanvas: typeof createCanvas }).createCanvas = createCanvas;
    const glScene = new Scene(gl);
    const glUI = new BabylonUI(glScene, { texture: () => Promise.reject(new Error("no textures")) });
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((c) => c === null)).toBe(true);
    glUI.dispose();
    glScene.dispose();
    gl.dispose();
  });

  it("leaves Babylon's own update alone off WebGPU", () => {
    const ui = new BabylonUI(scene, { texture: () => Promise.reject(new Error("no textures")) });
    expect(Object.prototype.hasOwnProperty.call(ui.screen, "update")).toBe(false);
    ui.dispose();
  });
});
