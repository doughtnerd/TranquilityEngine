// ADR 0076: the Babylon GUI drawing layer, run headless on Babylon's NullEngine. A fake UICoreLike
// feeds it real UI components; the GUI needs a 2D canvas, so `createCanvas` returns a stub context.
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Rectangle } from "@babylonjs/gui/2D/controls/rectangle.js";
import type { TextBlock } from "@babylonjs/gui/2D/controls/textBlock.js";
import type { Image } from "@babylonjs/gui/2D/controls/image.js";
import type { Container } from "@babylonjs/gui/2D/controls/container.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../core/World";
import { Color, Engine, GameObject, Text, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, Vector2 } from "../index";
import type { UIComponentType } from "../ui/components";
import type { UICoreLike, UILaidOutCanvas, UILaidOutElement } from "../ui/uiCoreTypes";
import { BabylonUI, WORLD_RESOLUTION, _resetTextMeasurer, cssWeight, measureText } from "../render/babylon/ui";

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
  babylon = new NullEngine();
  (babylon as unknown as { createCanvas: typeof fakeCanvas }).createCanvas = fakeCanvas;
  scene = new Scene(babylon);
  scene.useRightHandedSystem = true;
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
});

function node<T extends UIComponentType>(name: string, parent: GameObject | null, type: new () => T, init: Partial<T> = {}): T {
  return GameObject.create(name, { parent }).addBehavior(type as never, init as never) as T;
}

function canvasInfo(comp: UICanvas, over: Partial<UILaidOutCanvas> = {}): UILaidOutCanvas {
  return { comp, mode: comp.mode, sortOrder: comp.sortOrder, width: 1280, height: 720, scale: 1, pixelSize: comp.pixelSize, worldMatrix: null, visible: true, ...over };
}

type ElementInit = Partial<Pick<UILaidOutElement, "x" | "y" | "width" | "height" | "visible" | "opacity">>;

/** A fake core reporting these canvases and elements (orders count up per canvas). */
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
      const kind = comp instanceof UIButton ? "button" : comp instanceof UIInputField ? "input" : comp instanceof UIText ? "text" : comp instanceof UIImage ? "image" : "panel";
      return { comp, kind, canvas, x: 0, y: 0, width: 100, height: 40, order, visible: true, opacity: 1, ...init } as UILaidOutElement;
    });
    this.layoutVersion++;
  }
  sync(): void {}
  canvases() { return this.cs; }
  elements() { return this.es; }
  rectOf() { return null; }
  hitTest() { return null; }
  pickAll() { return []; }
  cornersOf() { return null; }
  release(): void {}
  dispose(): void {}
}

const sync = (core: FakeCore, extra: Parameters<BabylonUI["sync"]>[2] = {}, w = 1280, h = 720, pr = 1) => ui.sync(World.require(), core, extra, w, h, pr);
const screenRoots = () => ui.screen.rootContainer.children.filter((c) => (c.name ?? "").startsWith("myco.canvas")) as Container[];
const rootOf = (n = 0) => screenRoots()[n];
const byName = (root: Container, name: string) => root.children.find((c) => c.name === name)!;
const textRoot = () => ui.screen.rootContainer.children.find((c) => c.name === "myco.texts") as Container;

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

  it("orders controls by the core's order and canvases by sortOrder, over the interim Text", () => {
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
    expect(textRoot().zIndex).toBeLessThan(1);
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

  it("colours a button by hovered and pressed like UIRuntime", () => {
    const canvas = node("C", null, UICanvas);
    const button = node("B", canvas.node, UIButton, { backgroundColor: new Color(0.2, 0.2, 0.2, 1), hoverColor: new Color(0, 1, 0, 1), pressedColor: new Color(0, 0, 1, 1) });
    const core = new FakeCore();
    core.set([canvasInfo(canvas)], [[button, canvas]]);
    const bg = () => (byName(rootOf(), "B") as Rectangle).background;
    sync(core);
    expect(bg()).toBe("rgba(51, 51, 51, 1)");
    button._hovered = true;
    sync(core);
    expect(bg()).toBe("rgba(0, 255, 0, 1)");
    button._pressed = true;
    sync(core);
    expect(bg()).toBe("rgba(0, 0, 255, 1)");
    button._hovered = false; // pressed, but the pointer left: the plain colour
    sync(core);
    expect(bg()).toBe("rgba(51, 51, 51, 1)");
    button._hovered = true;
    button.interactable = false;
    sync(core);
    expect(bg()).toBe("rgba(51, 51, 51, 1)");
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
    expect(texture.getSize().width).toBeGreaterThanOrEqual(200 * WORLD_RESOLUTION);
    expect(texture.getSize().height).toBeGreaterThanOrEqual(100 * WORLD_RESOLUTION);
    const root = texture.rootContainer.children[0] as Container;
    expect(root.scaleX).toBe(WORLD_RESOLUTION);
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

describe("the interim Text on the screen texture", () => {
  const textBox = (t: Text, W: number, H: number) => {
    ui.syncTexts(World.require(), W, H);
    return textRoot().children.find((c) => c.name === `myco.text.${t.owner.name}`) as TextBlock;
  };

  it("places the box by anchor and offset in CSS pixels, below every canvas", () => {
    const t = GameObject.create("Score").addBehavior(Text, { text: "Hi", fontSize: 20, lineHeight: 1.2, anchor: "top-right", offset: new Vector2(-10, 12), align: "right" });
    // Node has no canvas, so "Hi" is estimated at 0.55 em a character: 22 wide at 20 px; pad = ceil(0 + 2) = 2.
    const block = textBox(t, 800, 600);
    const w = Math.ceil(2 * 20 * 0.55 + 4);
    expect(textRoot().zIndex).toBeLessThan(-1000);
    expect(block.widthInPixels).toBe(w);
    expect(block.heightInPixels).toBe(Math.ceil(20 * 1.2 + 4));
    expect(block.leftInPixels).toBeCloseTo(800 - w - 10);
    expect(block.topInPixels).toBeCloseTo(12);
    expect(block.text).toBe("Hi");
    expect(block.textHorizontalAlignment).toBe(1); // right
    expect(block.paddingLeftInPixels).toBe(2);

    t.anchor = "center";
    t.offset = new Vector2(0, 0);
    ui.syncTexts(World.require(), 800, 600);
    expect(block.leftInPixels).toBeCloseTo((800 - w) / 2);
    expect(block.topInPixels).toBeCloseTo((600 - block.heightInPixels) / 2);

    t.anchor = "bottom-left";
    ui.syncTexts(World.require(), 800, 600);
    expect(block.leftInPixels).toBe(0);
    expect(block.topInPixels).toBeCloseTo(600 - block.heightInPixels);
  });

  it("draws the outline, hides empty text, and forgets released text", () => {
    const t = GameObject.create("Label").addBehavior(Text, { text: "x", outlineColor: new Color(0, 0, 0, 1), outlineWidth: 3 });
    const block = textBox(t, 100, 100);
    expect(block.outlineWidth).toBe(6);
    expect(block.outlineColor).toBe("rgba(0, 0, 0, 1)");
    expect(block.paddingLeftInPixels).toBe(5);
    t.text = "";
    ui.syncTexts(World.require(), 100, 100);
    expect(block.isVisible).toBe(false);
    ui.release(t);
    expect(textRoot().children).toHaveLength(0);
  });

  it("scales the text container by the pixel ratio (CSS-pixel coordinates)", () => {
    const core = new FakeCore();
    core.set([], []);
    sync(core, {}, 800, 600, 2);
    expect(textRoot().scaleX).toBe(2);
    expect(textRoot().widthInPixels).toBe(800);
    expect(textRoot().heightInPixels).toBe(600);
  });
});

describe("measureText", () => {
  const req = (over: Partial<Parameters<typeof measureText>[0]> = {}) => ({ text: "hello world", fontSize: 10, fontWeight: "400", fontFamily: "Inter", lineHeight: 1.2, maxWidth: Infinity, ...over });
  const g = globalThis as unknown as { OffscreenCanvas?: unknown };
  const withCanvas = (run: () => void) => {
    g.OffscreenCanvas = class {
      getContext() {
        return fakeContext();
      }
    };
    _resetTextMeasurer();
    try {
      run();
    } finally {
      delete g.OffscreenCanvas;
      _resetTextMeasurer();
    }
  };

  it("estimates without a canvas, and measures with one", () => {
    _resetTextMeasurer();
    const estimated = measureText(req());
    expect(estimated.height).toBeCloseTo(12);
    expect(estimated.width).toBeGreaterThan(0);
    withCanvas(() => {
      expect(measureText(req())).toEqual({ width: 55 * 1.05 + 1, height: 12 }); // 11 characters x 5 px, with the room layout gets
      expect(measureText(req({ text: "" }))).toEqual({ width: 0, height: 12 });
    });
  });

  it("wraps at spaces to maxWidth and counts lines", () => {
    withCanvas(() => {
      expect(measureText(req({ maxWidth: 30 }))).toEqual({ width: 25 * 1.05 + 1, height: 24 }); // "hello" / "world"
      expect(measureText(req({ text: "a\nb\nc" })).height).toBeCloseTo(36);
      expect(measureText(req({ text: "unbreakable", maxWidth: 20 }))).toEqual({ width: 55 * 1.05 + 1, height: 12 }); // overflows
    });
  });

  it("names weights as CSS", () => {
    expect(["light", "normal", "medium", "semi-bold", "bold", "650", "odd"].map(cssWeight)).toEqual(["300", "400", "500", "600", "700", "650", "400"]);
  });
});
