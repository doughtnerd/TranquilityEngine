import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Camera, Engine, GameBehavior, GameObject, Input, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, Vector2, type UILength } from "../index";
import { World } from "../core/World";
import { UICore, canvasScale, uiLength } from "../ui/UICore";
import type { TextMeasureRequest } from "../ui/uiCoreTypes";
import { Assets } from "../scene/Assets";
import { UI_FONT_FAMILY, _resetFonts, fontEpoch, fontFamilyOf, loadBundledFont, onFontLoaded } from "../ui/fonts";

// ADR 0076: the renderer-neutral UI core: Yoga layout and UI-first routing, no renderer, no GPU.

const DT = 1 / 60;
let engine: Engine;
let cores: UICore[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  for (const c of cores.splice(0)) c.dispose();
  engine.dispose();
  Input.reset();
  vi.restoreAllMocks();
});

function world(): World {
  return World.require();
}

async function core(options: ConstructorParameters<typeof UICore>[0] = { interactive: true }): Promise<UICore> {
  const c = new UICore(options);
  cores.push(c);
  await c.ready;
  return c;
}

function sync(c: UICore, width = 1280, height = 720): void {
  c.sync(world(), width, height, DT);
}

function node<T extends UIPanel | UIText | UIImage | UICanvas>(name: string, parent: GameObject | null, type: new () => T, init: Partial<T> = {}): T {
  const n = GameObject.create(name, { parent });
  return n.addBehavior(type as never, init as never) as T;
}

/** A 1280×720 screen canvas with a column of fixed-size buttons. */
function menu() {
  const canvas = node("Canvas", null, UICanvas);
  const column = node("Menu", canvas.node, UIPanel, { flexDirection: "column", padding: 20, gap: 10, width: "100%", height: "100%" } as Partial<UIPanel>);
  const play = node("Play", column.node, UIButton, { width: 200 as UILength, height: 50 as UILength, padding: 0 } as Partial<UIButton>);
  const quit = node("Quit", column.node, UIButton, { width: 200 as UILength, height: 50 as UILength, padding: 0 } as Partial<UIButton>);
  return { canvas, column, play, quit };
}

/** Press (or release) the left mouse button at canvas pixels and step a frame. */
function mouse(type: "down" | "up", x: number, y: number): void {
  Input.simulatePointer(x, y);
  Input.simulate(type, "mouse0");
  engine.step(DT);
}

describe("UICore layout", () => {
  it("scales the reference resolution to the canvas like Unity's Canvas Scaler", () => {
    expect(canvasScale(1280, 720, 1280, 720, 1)).toBeCloseTo(1);
    expect(canvasScale(2560, 1440, 1280, 720, 0.5)).toBeCloseTo(2);
    expect(canvasScale(1920, 720, 1280, 720, 1)).toBeCloseTo(1);
    expect(canvasScale(1920, 720, 1280, 720, 0)).toBeCloseTo(1.5);
    expect(canvasScale(1920, 720, 1280, 720, 0.5)).toBeCloseTo(Math.sqrt(1.5));
    expect(canvasScale(0, 0, 1280, 720, 1)).toBe(1);
  });

  it("reads lengths as pixels, percentages or auto", () => {
    expect(uiLength(120)).toBe(120);
    expect(uiLength("120")).toBe(120);
    expect(uiLength("120px")).toBe(120);
    expect(uiLength("50%")).toBe("50%");
    expect(uiLength("auto")).toBe("auto");
    expect(uiLength("")).toBeUndefined();
    expect(uiLength("wide")).toBeUndefined();
  });

  it("lays nothing out before Yoga has loaded, and then everything", async () => {
    const { canvas } = menu();
    const c = new UICore();
    cores.push(c);
    sync(c);
    expect(c.rectOf(canvas)).toBeNull();
    await c.ready;
    sync(c);
    expect(c.rectOf(canvas)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("lays children out with flexbox inside their parent", async () => {
    const { canvas, column, play, quit } = menu();
    const c = await core();
    sync(c);
    expect(c.rectOf(canvas)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(c.rectOf(column)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(c.rectOf(play)).toEqual({ x: 20, y: 20, width: 200, height: 50 });
    expect(c.rectOf(quit)).toEqual({ x: 20, y: 80, width: 200, height: 50 });
  });

  it("scales the layout with the canvas, and centres with justify and align", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const box = node("Box", canvas.node, UIPanel, { width: "100%", height: "100%", justifyContent: "center", alignItems: "center" } as Partial<UIPanel>);
    const inner = node("Inner", box.node, UIPanel, { width: 100, height: 40 } as Partial<UIPanel>);
    const c = await core();
    sync(c, 640, 360); // half the reference size: scale 0.5
    const rect = c.rectOf(inner)!;
    expect(rect.width).toBeCloseTo(50);
    expect(rect.height).toBeCloseTo(20);
    expect(rect.x + rect.width / 2).toBeCloseTo(320);
    expect(rect.y + rect.height / 2).toBeCloseTo(180);
    const laid = c.canvases()[0];
    expect(laid.scale).toBeCloseTo(0.5);
    expect(laid.width).toBeCloseTo(1280);
    expect(laid.height).toBeCloseTo(720);
    const el = c.elements().find((e) => e.comp === inner)!;
    expect(el.width).toBeCloseTo(100); // elements are in UI pixels
  });

  it("follows field changes, absolute positions and inactive nodes each sync", async () => {
    const { play, quit } = menu();
    const c = await core();
    sync(c);
    play.width = 300;
    play.height = "60";
    sync(c);
    expect(c.rectOf(play)).toEqual({ x: 20, y: 20, width: 300, height: 60 });
    expect(c.rectOf(quit)!.y).toBe(90);

    play.node.setActive(false); // takes no space
    sync(c);
    expect(c.rectOf(quit)!.y).toBe(20);
    expect(c.elements().find((e) => e.comp === play)!.visible).toBe(false);

    quit.positionType = "absolute";
    quit.right = 10;
    quit.bottom = "10";
    sync(c);
    expect(c.rectOf(quit)).toEqual({ x: 1280 - 10 - 200, y: 720 - 10 - 50, width: 200, height: 50 });
  });

  it("supports percentages, margins, padding, gap and flexGrow", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const row = node("Row", canvas.node, UIPanel, { width: "50%", height: 100, padding: 10, gap: 20, alignItems: "flex-start" } as Partial<UIPanel>);
    const a = node("A", row.node, UIPanel, { width: 100, height: 20, margin: 5 } as Partial<UIPanel>);
    const b = node("B", row.node, UIPanel, { height: 20, flexGrow: 1 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    expect(c.rectOf(row)).toEqual({ x: 0, y: 0, width: 640, height: 100 });
    expect(c.rectOf(a)).toEqual({ x: 15, y: 15, width: 100, height: 20 });
    // The row's content is 620 wide; A takes 110 with its margins, the gap 20, B the rest.
    expect(c.rectOf(b)).toEqual({ x: 10 + 110 + 20, y: 10, width: 620 - 110 - 20, height: 20 });
  });

  it("places absolute elements with top, left and percentages", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const panel = node("P", canvas.node, UIPanel, { positionType: "absolute", left: "10%", top: 30, width: 50, height: 60 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    expect(c.rectOf(panel)).toEqual({ x: 128, y: 30, width: 50, height: 60 });
  });

  it("takes no space and is invisible with display none (inactive), and keeps space when merely not visible", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const a = node("A", canvas.node, UIPanel, { width: 100, height: 10 } as Partial<UIPanel>);
    const b = node("B", canvas.node, UIPanel, { width: 100, height: 10 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    expect(c.rectOf(b)!.x).toBe(100);
    a.visible = false;
    sync(c);
    expect(c.rectOf(b)!.x).toBe(100); // keeps its space
    const els = c.elements();
    expect(els.find((e) => e.comp === a)!.visible).toBe(false);
    expect(els.find((e) => e.comp === b)!.visible).toBe(true);
    a.node.setActive(false);
    sync(c);
    expect(c.rectOf(b)!.x).toBe(0);
  });

  it("takes display none elements and their children out of layout, drawing and routing, with their nodes still active", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const a = node("A", canvas.node, UIPanel, { width: 100, height: 10 } as Partial<UIPanel>);
    const inA = node("InA", a.node, UIButton, { width: 50, height: 10, padding: 0 } as Partial<UIButton>);
    const b = node("B", canvas.node, UIPanel, { width: 100, height: 10 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    expect(c.rectOf(b)!.x).toBe(100);
    expect(c.hitTest(10, 5)).toBe(inA);
    a.display = "none";
    sync(c);
    expect(c.rectOf(b)!.x).toBe(0); // takes no space
    const els = c.elements();
    expect(els.find((e) => e.comp === a)!.visible).toBe(false);
    expect(els.find((e) => e.comp === inA)!.visible).toBe(false); // nor its children
    expect(c.hitTest(10, 5)).toBeNull();
    expect(c.pickAll(10, 5)).not.toContain(inA);
    expect(a.node.activeInHierarchy && inA.isActiveAndEnabled).toBe(true);
    a.display = "flex";
    sync(c);
    expect(c.rectOf(b)!.x).toBe(100);
    expect(c.hitTest(10, 5)).toBe(inA);
  });

  it("reports visibility and opacity down the tree, and draw order parents first", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const outer = node("Outer", canvas.node, UIPanel, { width: 100, height: 100, opacity: 0.5 } as Partial<UIPanel>);
    const inner = node("Inner", outer.node, UIPanel, { width: 10, height: 10, opacity: 0.5 } as Partial<UIPanel>);
    const next = node("Next", canvas.node, UIPanel, { width: 10, height: 10 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    const els = c.elements();
    expect(els.map((e) => e.comp)).toEqual([outer, inner, next]);
    expect(els.map((e) => e.order)).toEqual([0, 1, 2]);
    expect(els[1].opacity).toBeCloseTo(0.25);
    outer.visible = false;
    sync(c);
    expect(c.elements().map((e) => e.visible)).toEqual([false, false, true]);
  });

  it("lays out reordered and reparented nodes in their new place, and drops removed ones", async () => {
    const { canvas, column, play, quit } = menu();
    const c = await core();
    sync(c);
    quit.node.setParent(canvas.node); // out of the column: beside it in the canvas's row
    sync(c);
    expect(c.rectOf(play)).toEqual({ x: 20, y: 20, width: 200, height: 50 });
    const col = c.rectOf(column)!;
    expect(c.rectOf(quit)).toEqual({ x: col.x + col.width, y: 0, width: expect.any(Number), height: 50 });
    GameObject.destroy(play.node);
    engine.step(DT);
    sync(c);
    expect(c.rectOf(play)).toBeNull();
    expect(c.elements().some((e) => e.comp === play)).toBe(false);
  });

  it("skips nodes without UI components but lays out their UI children", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const group = GameObject.create("Group", { parent: canvas.node });
    const panel = node("Panel", group, UIPanel, { width: 30, height: 30, margin: 5 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    expect(c.rectOf(panel)).toEqual({ x: 5, y: 5, width: 30, height: 30 });
  });

  it("warns once about elements outside a canvas and does not lay them out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    node("Canvas", null, UICanvas);
    const loose = node("Loose", null, UIPanel, { width: 10, height: 10 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    sync(c);
    expect(c.rectOf(loose)).toBeNull();
    expect(c.elements().some((e) => e.comp === loose)).toBe(false);
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("Loose")).length).toBe(1);
  });

  it("warns once about children of a leaf and lays them out beside it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = node("Canvas", null, UICanvas);
    const text = node("Label", canvas.node, UIText, { text: "Hi", width: 40, height: 20 } as Partial<UIText>);
    const child = node("Child", text.node, UIPanel, { width: 30, height: 30 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    sync(c);
    expect(c.rectOf(child)).toEqual({ x: 40, y: 0, width: 30, height: 30 });
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("Child")).length).toBe(1);
  });

  it("warns once about a node with two UI components", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = node("Canvas", null, UICanvas);
    const panel = node("Both", canvas.node, UIPanel, { width: 10, height: 10 } as Partial<UIPanel>);
    panel.node.addBehavior(UIText as never, {} as never);
    const c = await core();
    sync(c);
    sync(c);
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("two UI components")).length).toBe(1);
    expect(c.elements().length).toBe(1);
  });

  it("treats a nested canvas as a root of its own", async () => {
    const outer = node("Outer", null, UICanvas);
    const innerCanvas = node("Inner", outer.node, UICanvas, { sortOrder: 3 } as Partial<UICanvas>);
    const a = node("A", innerCanvas.node, UIPanel, { width: 20, height: 20 } as Partial<UIPanel>);
    const c = await core();
    sync(c);
    expect(c.canvases().map((x) => x.comp)).toEqual([outer, innerCanvas]);
    expect(c.elements().find((e) => e.comp === a)!.canvas).toBe(innerCanvas);
    expect(c.rectOf(a)).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it("orders canvases by sortOrder and reports hasScreenUI", async () => {
    const c = await core();
    sync(c);
    expect(c.hasScreenUI).toBe(false);
    const front = node("Front", null, UICanvas, { sortOrder: 5 } as Partial<UICanvas>);
    const back = node("Back", null, UICanvas, { sortOrder: -1 } as Partial<UICanvas>);
    sync(c);
    expect(c.canvases().map((x) => x.comp)).toEqual([back, front]);
    expect(c.hasScreenUI).toBe(true);
    front.node.setActive(false);
    back.node.setActive(false);
    sync(c);
    expect(c.hasScreenUI).toBe(false);
  });

  it("bumps layoutVersion only when something changed", async () => {
    const { play } = menu();
    const c = await core();
    sync(c);
    const v = c.layoutVersion;
    expect(v).toBeGreaterThan(0);
    sync(c);
    sync(c);
    expect(c.layoutVersion).toBe(v);
    play.width = 210;
    sync(c);
    expect(c.layoutVersion).toBeGreaterThan(v);
    const v2 = c.layoutVersion;
    play.visible = false;
    sync(c);
    expect(c.layoutVersion).toBeGreaterThan(v2);
    const v3 = c.layoutVersion;
    sync(c, 1000, 600);
    expect(c.layoutVersion).toBeGreaterThan(v3);
  });

  it("releases removed components' Yoga nodes and forgets them", async () => {
    const { play, quit } = menu();
    const c = await core();
    sync(c);
    c.release(play);
    expect(c.rectOf(play)).toBeNull();
    sync(c); // play is still live in the World, so it comes back
    expect(c.rectOf(play)).not.toBeNull();
    expect(c.rectOf(quit)!.y).toBe(80);
    c.dispose();
    expect(c.elements()).toEqual([]);
    expect(c.canvases()).toEqual([]);
  });
});

describe("UICore text", () => {
  /** A fake font: 10 UI pixels per character, 20 per line, wrapping at spaces. */
  function fakeHost() {
    const requests: TextMeasureRequest[] = [];
    return {
      requests,
      measureText(r: TextMeasureRequest) {
        requests.push(r);
        const words = r.text.split(" ");
        let lines = 1, line = 0, widest = 0;
        for (const w of words) {
          const add = (line === 0 ? 0 : 10) + w.length * 10;
          if (line > 0 && line + add > r.maxWidth) {
            lines++;
            line = w.length * 10;
          } else line += add;
          widest = Math.max(widest, line);
        }
        return { width: widest, height: lines * 20 };
      },
    };
  }

  it("sizes auto text by the host's measure, with the CSS font mapped", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const top = node("Top", canvas.node, UIPanel, { alignItems: "flex-start" } as Partial<UIPanel>);
    const text = node("T", top.node, UIText, { text: "Hello", fontSize: 20, fontWeight: "semi-bold" } as Partial<UIText>);
    const host = fakeHost();
    const c = await core({ interactive: true, host });
    sync(c);
    expect(c.rectOf(text)).toEqual({ x: 0, y: 0, width: 50, height: 20 });
    const req = host.requests.at(-1)!;
    expect(req).toMatchObject({ text: "Hello", fontSize: 20, fontWeight: "600", fontFamily: "Inter, system-ui, sans-serif", lineHeight: 1.2 });
  });

  it("wraps text to the width it has, and re-measures when the text changes", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const top = node("Top", canvas.node, UIPanel, { alignItems: "flex-start" } as Partial<UIPanel>);
    const text = node("T", top.node, UIText, { text: "aaaa bbbb cccc" } as Partial<UIText>);
    text.width = 90;
    const c = await core({ interactive: true, host: fakeHost() });
    sync(c);
    expect(c.rectOf(text)).toEqual({ x: 0, y: 0, width: 90, height: 40 }); // "aaaa bbbb" fits 90, "cccc" wraps
    text.text = "aaaa";
    sync(c);
    expect(c.rectOf(text)!.height).toBe(20);
  });

  it("falls back to an estimate without a host, and follows text edits", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const top = node("Top", canvas.node, UIPanel, { alignItems: "flex-start" } as Partial<UIPanel>);
    const text = node("T", top.node, UIText, { text: "abcd", fontSize: 10 } as Partial<UIText>);
    const c = await core();
    sync(c);
    expect(c.rectOf(text)!.width).toBeCloseTo(0.55 * 10 * 4);
    expect(c.rectOf(text)!.height).toBeCloseTo(12);
    text.text = "abcdefgh";
    sync(c);
    expect(c.rectOf(text)!.width).toBeCloseTo(0.55 * 10 * 8);
    text.text = "ab\ncd";
    sync(c);
    expect(c.rectOf(text)!.height).toBeCloseTo(24);
  });

  it("measures with the font a text names, and again once a font arrives", async () => {
    // A FontFace API stand-in: every font loads at once.
    const added: { family: string; source: string }[] = [];
    class FakeFontFace {
      constructor(readonly family: string, readonly source: string) {}
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    vi.stubGlobal("document", { fonts: { add: (f: FakeFontFace) => added.push(f), delete: () => true } });
    const source = { has: (p: string) => p === "fonts/Pirata One.ttf", get: () => "blob:pirata" };
    Assets.addSource(source);
    _resetFonts();
    try {
      const canvas = node("Canvas", null, UICanvas);
      const top = node("Top", canvas.node, UIPanel, { alignItems: "flex-start" } as Partial<UIPanel>);
      const text = node("T", top.node, UIText, { text: "Ahoy", font: "asset:fonts/Pirata One.ttf" } as Partial<UIText>);
      const field = node("F", top.node, UIInputField, { placeholder: "Name" } as Partial<UIInputField>);
      const host = fakeHost();
      const c = await core({ interactive: true, host });
      sync(c);
      const family = "myco-font-fonts-Pirata-One-ttf";
      expect(host.requests.find((r) => r.text === "Ahoy")!.fontFamily).toBe(`${family}, ${UI_FONT_FAMILY}`);
      expect(host.requests.find((r) => r.text === "Name")!.fontFamily).toBe(UI_FONT_FAMILY);
      expect(added).toEqual([expect.objectContaining({ family, source: 'url("blob:pirata")' })]);

      // Each font that arrives makes every text measure again (it was measured in a fallback font).
      await Promise.resolve();
      const before = fontEpoch();
      let heard = 0;
      const off = onFontLoaded(() => heard++);
      await loadBundledFont();
      off();
      expect(fontEpoch()).toBe(before + 1);
      expect(heard).toBe(1);
      expect(added.at(-1)).toMatchObject({ family: "Inter" });
      expect(added.at(-1)!.source).toMatch(/Inter-latin-wght\.woff2"\) format\("woff2"\)$/);
      host.requests.length = 0;
      sync(c);
      expect(host.requests.map((r) => r.text).sort()).toEqual(["Ahoy", "Name"]);
      host.requests.length = 0;
      sync(c);
      expect(host.requests).toEqual([]); // nothing changed since
      void text;
      void field;
    } finally {
      Assets.removeSource(source);
      vi.unstubAllGlobals();
      _resetFonts();
    }
  });

  it("uses Inter for an empty font, and warns once about a font field that isn't a font file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(fontFamilyOf("")).toBe(UI_FONT_FAMILY);
    expect(fontFamilyOf("asset:images/logo.png")).toBe(UI_FONT_FAMILY);
    expect(fontFamilyOf("images/logo.png")).toBe(UI_FONT_FAMILY);
    expect(warn).toHaveBeenCalledTimes(1);
    // Node has no FontFace: a font file still gets its family name (and nothing loads).
    expect(fontFamilyOf("fonts/a.woff2")).toBe(`myco-font-fonts-a-woff2, ${UI_FONT_FAMILY}`);
    _resetFonts();
  });

  it("a passive core lays out but never routes", async () => {
    const { play } = menu();
    const passive = await core({ interactive: false, passive: true });
    const c = await core();
    sync(passive, 640, 360);
    sync(c);
    expect(passive.rectOf(play)).toEqual({ x: 10, y: 10, width: 100, height: 25 }); // half size
    mouse("down", 100, 40);
    expect(play.pressed).toBe(true); // the routing core's, untouched by the passive one
    mouse("up", 100, 40);
  });

  it("sizes an input field at one line plus its padding and border", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const top = node("Top", canvas.node, UIPanel, { alignItems: "flex-start" } as Partial<UIPanel>);
    const field = node("F", top.node, UIInputField, { fontSize: 20, placeholder: "Name" } as Partial<UIInputField>);
    const c = await core();
    sync(c);
    // 20 × 1.2 line, padding 8 and border 1 on each side; width is the field's "240".
    expect(c.rectOf(field)).toEqual({ x: 0, y: 0, width: 240, height: 24 + 16 + 2 });
  });
});

describe("UICore world canvases", () => {
  function setup() {
    const camNode = GameObject.create("Cam"); // at the origin, looking down -z
    const cam = camNode.addBehavior(Camera, {});
    const canvas = node("Sign", null, UICanvas, { mode: "world", referenceResolution: new Vector2(200, 100), pixelSize: 0.01 } as Partial<UICanvas>);
    canvas.node.transform!.position.set(0, 0, -5);
    const button = node("Button", canvas.node, UIButton, { width: "100%", height: "100%" } as Partial<UIButton>);
    engine.step(DT); // propagate the transform
    return { cam, canvas, button };
  }

  it("lays out at the reference resolution and reports its plane's matrix", async () => {
    const { canvas, button } = setup();
    const c = await core();
    sync(c);
    const laid = c.canvases()[0];
    expect(laid).toMatchObject({ mode: "world", width: 200, height: 100, scale: 1, pixelSize: 0.01 });
    expect(Array.from(laid.worldMatrix!.slice(12, 15))).toEqual([0, 0, -5]);
    expect(c.rectOf(button)).toBeNull(); // rectangles are for screen canvases
    expect(c.elements().find((e) => e.comp === button)).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });
    expect(c.hasScreenUI).toBe(false);
    expect(canvas.mode).toBe("world");
  });

  it("takes the pointer through the view camera's ray", async () => {
    const { cam, canvas, button } = setup();
    const c = await core({ interactive: true, host: { viewCamera: () => cam } });
    sync(c);
    expect(c.hitTest(640, 360)).toBe(button);
    expect(c.hitTest(20, 20)).toBeNull(); // the panel covers only the middle of the view

    mouse("down", 640, 360);
    mouse("up", 640, 360);
    expect(button.clicked).toBe(true);

    canvas.node.transform!.position.set(10, 0, -5); // moved out of view
    engine.step(DT);
    sync(c);
    expect(c.hitTest(640, 360)).toBeNull();
  });

  it("picks the nearest of two world canvases, and nothing without a camera", async () => {
    const { cam, button } = setup();
    const near = node("Near", null, UICanvas, { mode: "world", referenceResolution: new Vector2(200, 100), pixelSize: 0.01 } as Partial<UICanvas>);
    near.node.transform!.position.set(0, 0, -3);
    const nearButton = node("NearButton", near.node, UIButton, { width: "100%", height: "100%" } as Partial<UIButton>);
    engine.step(DT);
    const c = await core({ interactive: true, host: { viewCamera: () => cam } });
    sync(c);
    expect(c.hitTest(640, 360)).toBe(nearButton);
    expect(button).not.toBe(nearButton);
    const noCamera = await core();
    sync(noCamera);
    expect(noCamera.hitTest(640, 360)).toBeNull();
  });
});

describe("UICore pointer routing", () => {
  it("hovers, presses and clicks a button, and the game doesn't see the press", async () => {
    const { play, quit } = menu();
    const c = await core();
    sync(c);
    const game: { down: boolean; held: boolean; up: boolean; over: boolean; clicked: boolean }[] = [];
    class Game extends GameBehavior {
      update() {
        game.push({ down: Input.getMouseButtonDown(0), held: Input.getMouseButton(0), up: Input.getMouseButtonUp(0), over: Input.pointerOverUI, clicked: play.clicked });
      }
    }
    GameObject.create("Game").addBehavior(Game);

    Input.simulatePointer(100, 40);
    engine.step(DT);
    expect(play.hovered).toBe(true);
    expect(quit.hovered).toBe(false);
    expect(game.at(-1)).toEqual({ down: false, held: false, up: false, over: true, clicked: false });

    mouse("down", 100, 40);
    expect(play.pressed).toBe(true);
    expect(game.at(-1)).toEqual({ down: false, held: false, up: false, over: true, clicked: false });

    engine.step(DT);
    expect(game.at(-1)!.held).toBe(false);

    mouse("up", 100, 40);
    expect(play.pressed).toBe(false);
    expect(play.clicked).toBe(true);
    expect(game.at(-1)).toEqual({ down: false, held: false, up: false, over: true, clicked: true });

    engine.step(DT);
    expect(play.clicked).toBe(false);
    expect(quit.clicked).toBe(false);
  });

  it("routes by the layout's boxes at a scaled canvas size", async () => {
    const { play } = menu();
    const c = await core();
    sync(c, 640, 360); // scale 0.5: Play is at CSS (10, 10)-(110, 35)
    expect(c.hitTest(50, 20)).toBe(play);
    expect(c.hitTest(150, 20)).toBeNull();
    mouse("down", 50, 20);
    mouse("up", 50, 20);
    expect(play.clicked).toBe(true);
  });

  it("gives the game presses away from UI", async () => {
    const { play } = menu();
    const c = await core();
    sync(c);
    mouse("down", 900, 500);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.getMouseButton(0)).toBe(true);
    expect(Input.anyKeyDown).toBe(true);
    mouse("up", 100, 40); // the press was the game's, so is the release
    expect(Input.pointerOverUI).toBe(true);
    expect(Input.getMouseButtonUp(0)).toBe(true);
    expect(play.clicked).toBe(false);
  });

  it("doesn't click when the press moves off the button before release", async () => {
    const { play, quit } = menu();
    const c = await core();
    sync(c);
    mouse("down", 100, 40);
    mouse("up", 100, 100); // over Quit now
    expect(play.clicked).toBe(false);
    expect(quit.clicked).toBe(false);
    expect(Input.getMouseButtonUp(0)).toBe(false);
  });

  it("a press and release in one frame clicks", async () => {
    const { play } = menu();
    const c = await core();
    sync(c);
    Input.simulatePointer(100, 40);
    Input.simulate("down", "mouse0");
    Input.simulate("up", "mouse0");
    engine.step(DT);
    expect(play.clicked).toBe(true);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    expect(Input.getMouseButtonUp(0)).toBe(false);
    expect(Input.getKey("mouse0")).toBe(false);
  });

  it("a non-interactable button blocks the pointer but isn't hovered or clicked", async () => {
    const { play } = menu();
    play.interactable = false;
    const c = await core();
    sync(c);
    mouse("down", 100, 40);
    expect(Input.pointerOverUI).toBe(true);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    expect(play.hovered).toBe(false);
    mouse("up", 100, 40);
    expect(play.clicked).toBe(false);
  });

  it("ignores hidden and inactive buttons", async () => {
    const { play, quit } = menu();
    const c = await core();
    sync(c);
    play.visible = false;
    quit.node.setActive(false);
    sync(c);
    Input.simulatePointer(100, 40);
    engine.step(DT);
    expect(c.hitTest(100, 40)).toBeNull();
    expect(Input.pointerOverUI).toBe(false);
  });

  it("tests canvases from the highest sortOrder down", async () => {
    const back = node("Back", null, UICanvas, { sortOrder: 0 } as Partial<UICanvas>);
    const backButton = node("BackButton", back.node, UIButton, { width: 400, height: 400 } as Partial<UIButton>);
    const front = node("Front", null, UICanvas, { sortOrder: 5 } as Partial<UICanvas>);
    const frontButton = node("FrontButton", front.node, UIButton, { width: 100, height: 100 } as Partial<UIButton>);
    const c = await core();
    sync(c);
    expect(c.hitTest(50, 50)).toBe(frontButton);
    expect(c.hitTest(300, 300)).toBe(backButton);
    front.sortOrder = -1;
    sync(c);
    expect(c.hitTest(50, 50)).toBe(backButton);
  });

  it("picks the topmost of overlapping siblings (later in node order)", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const under = node("Under", canvas.node, UIButton, { width: 100, height: 100, positionType: "absolute", left: 0, top: 0 } as Partial<UIButton>);
    const over = node("Over", canvas.node, UIButton, { width: 100, height: 100, positionType: "absolute", left: 50, top: 0 } as Partial<UIButton>);
    const c = await core();
    sync(c);
    expect(c.hitTest(25, 50)).toBe(under);
    expect(c.hitTest(75, 50)).toBe(over);
  });

  it("routes only in a World that takes input, and not when non-interactive (the editor's World)", async () => {
    const { play } = menu();
    const editor = await core({ interactive: false });
    sync(editor);
    mouse("down", 100, 40);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(play.pressed).toBe(false);
    mouse("up", 100, 40);

    const c = await core();
    sync(c);
    world()._takesInput = false;
    mouse("down", 100, 40);
    expect(play.pressed).toBe(false);
    world()._takesInput = true;
  });

  it("stops routing once disposed", async () => {
    menu();
    const c = await core();
    sync(c);
    c.dispose();
    mouse("down", 100, 40);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
  });
});

describe("UICore input fields", () => {
  async function form() {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40, placeholder: "Name" } as Partial<UIInputField>);
    const c = await core();
    sync(c);
    return { canvas, field, c };
  }

  it("focuses on a click, takes the keyboard, and unfocuses on a click elsewhere", async () => {
    const { field } = await form();
    const keys: boolean[] = [];
    class Game extends GameBehavior {
      update() {
        keys.push(Input.getKeyDown("w") || Input.getKey("w"));
      }
    }
    GameObject.create("Game").addBehavior(Game);

    mouse("down", 50, 20);
    expect(field.focused).toBe(true);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    mouse("up", 50, 20);

    Input.simulate("down", "w");
    engine.step(DT);
    expect(Input.keyboardOverUI).toBe(true);
    expect(keys.at(-1)).toBe(false);
    expect(Input.anyKeyDown).toBe(false);
    Input.simulate("up", "w");
    engine.step(DT);

    mouse("down", 900, 500);
    expect(field.focused).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    mouse("up", 900, 500);

    Input.simulate("down", "w");
    engine.step(DT);
    expect(Input.keyboardOverUI).toBe(false);
    expect(keys.at(-1)).toBe(true);
  });

  it("a script can focus the field, and focus is the keyboard's while set", async () => {
    const { field } = await form();
    field.focused = true;
    Input.simulate("down", "space");
    engine.step(DT);
    expect(Input.getKeyDown("space")).toBe(false);
    field.focused = false;
    engine.step(DT);
    expect(Input.getKey("space")).toBe(true);
  });

  it("reports a submit for the frame after Enter in the focused field", async () => {
    const { field } = await form();
    mouse("down", 50, 20);
    mouse("up", 50, 20);
    expect(field.focused).toBe(true);
    field._simulateSubmit();
    engine.step(DT);
    expect(field.submitted).toBe(true);
    engine.step(DT);
    expect(field.submitted).toBe(false);
  });

  it("lays out at its size with a value or a placeholder, and has no caret without a DOM", async () => {
    const { field, c } = await form();
    expect(c.rectOf(field)).toEqual({ x: 0, y: 0, width: 300, height: 40 });
    field.value = "Ada";
    sync(c);
    expect(c.rectOf(field)!.width).toBe(300);
    field.focused = true;
    sync(c);
    expect(c.caretOf(field)).toBeNull();
  });
});

describe("UICore typing (DOM)", () => {
  // Node has no document: a minimal stand-in for the one hidden <input> the core makes.
  class FakeInput {
    value = "";
    maxLength = -1;
    type = "";
    autocomplete = "";
    tabIndex = 0;
    selectionStart: number | null = 0;
    style = { cssText: "" };
    listeners = new Map<string, ((e: unknown) => void)[]>();
    removed = false;
    setAttribute() {}
    removeAttribute(n: string) {
      if (n === "maxlength") this.maxLength = -1;
    }
    addEventListener(t: string, f: (e: unknown) => void) {
      this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
    }
    removeEventListener(t: string, f: (e: unknown) => void) {
      this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== f));
    }
    emit(t: string, e: unknown = {}) {
      for (const f of this.listeners.get(t) ?? []) f(e);
    }
    focus() {
      (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = this;
    }
    blur() {
      const d = (globalThis as unknown as { document: { activeElement: unknown } }).document;
      if (d.activeElement === this) d.activeElement = null;
      this.emit("blur");
    }
    setSelectionRange(a: number) {
      this.selectionStart = a;
    }
    remove() {
      this.removed = true;
    }
  }

  let fake: FakeInput;
  beforeEach(() => {
    fake = new FakeInput();
    vi.stubGlobal("document", { activeElement: null, body: { appendChild() {} }, createElement: () => fake });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives DOM focus to the focused field, mirrors value and maxLength, and takes typing, Enter and Escape", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40, value: "Ad", maxLength: 5 } as Partial<UIInputField>);
    const c = await core();
    sync(c);
    expect(fake.listeners.size).toBe(0); // nothing until a field is focused

    field.focused = true;
    sync(c);
    expect((globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement).toBe(fake);
    expect(fake.value).toBe("Ad");
    expect(fake.maxLength).toBe(5);
    expect(c.caretOf(field)).toBe(2);

    fake.value = "Ada Lovelace";
    fake.emit("input");
    expect(field.value).toBe("Ada L");
    expect(fake.value).toBe("Ada L");

    field.value = "Zed"; // a script writes it
    sync(c);
    expect(fake.value).toBe("Zed");

    fake.emit("keydown", { key: "Enter" });
    engine.step(DT); // routing turns the Enter into a submit for this frame's scripts
    expect(field.submitted).toBe(true);
    engine.step(DT);
    expect(field.submitted).toBe(false);

    fake.emit("keydown", { key: "Escape" });
    expect(field.focused).toBe(false);
    sync(c);
    expect((globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement).toBeNull();
    expect(c.caretOf(field)).toBeNull();
  });

  it("unfocuses the field when the DOM input loses focus on its own", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40 } as Partial<UIInputField>);
    const c = await core();
    sync(c);
    field.focused = true;
    sync(c);
    fake.emit("blur");
    expect(field.focused).toBe(false);
  });

  it("moves the one input between fields", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const a = node("A", canvas.node, UIInputField, { width: 100, height: 20, value: "aa" } as Partial<UIInputField>);
    const b = node("B", canvas.node, UIInputField, { width: 100, height: 20, value: "bb" } as Partial<UIInputField>);
    const c = await core();
    sync(c);
    a.focused = true;
    sync(c);
    expect(fake.value).toBe("aa");
    a.focused = false;
    b.focused = true;
    sync(c);
    expect(fake.value).toBe("bb");
    fake.value = "bbb";
    fake.emit("input");
    expect(b.value).toBe("bbb");
    expect(a.value).toBe("aa");
  });
});

describe("UICore editor picking (ADR 0077)", () => {
  it("lists every drawn element under a point, topmost first, canvases excepted", async () => {
    const { column, play } = menu();
    const c = await core({ interactive: false });
    sync(c);
    // Play is at (20, 20)–(220, 70) inside the column.
    expect(c.pickAll(100, 40)).toEqual([play, column]);
    expect(c.pickAll(600, 600)).toEqual([column]);
    play.visible = false;
    sync(c);
    expect(c.pickAll(100, 40)).toEqual([column]);
  });

  it("gives screen boxes in canvas pixels and world boxes as world corners, picked by a given ray", async () => {
    const { column, play } = menu();
    const c = await core({ interactive: false });
    sync(c);
    expect(c.cornersOf(play)).toEqual({ space: "screen", points: [[20, 20], [220, 20], [220, 70], [20, 70]], size: [200, 50] });
    expect(c.cornersOf(column)!.points[2]).toEqual([1280, 720]);

    const sign = node("Sign", null, UICanvas, { mode: "world", referenceResolution: new Vector2(200, 100), pixelSize: 0.01 } as Partial<UICanvas>);
    sign.node.transform!.position.set(0, 0, -5);
    const label = node("Label", sign.node, UIText, { text: "Hi", width: 100 as UILength, height: 50 as UILength } as Partial<UIText>);
    engine.step(DT);
    sync(c);
    const corners = c.cornersOf(label)!;
    expect(corners.space).toBe("world");
    expect(corners.size).toEqual([100, 50]);
    expect(corners.points[0].map((v) => +v.toFixed(5))).toEqual([-1, 0.5, -5]);
    expect(corners.points[2].map((v) => +v.toFixed(5))).toEqual([0, 0, -5]);
    // The screen column is listed first (screen canvases draw over world ones), then the world label under the ray.
    expect(c.pickAll(5, 5, { origin: [-0.5, 0.25, 0], direction: [0, 0, -1] })).toEqual([column, label]);
    expect(c.pickAll(5, 5, { origin: [0.5, 0.25, 0], direction: [0, 0, -1] })).toEqual([column]); // the sign's right half has no element
  });

  it("places an absolute child's left/top from the parent's padding box (inside its border), as the handles assume", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const parent = node("Parent", canvas.node, UIPanel, { width: 400 as UILength, height: 300 as UILength, padding: 20, borderWidth: 5, left: 10 as UILength, top: 10 as UILength, positionType: "absolute" } as Partial<UIPanel>);
    const child = node("Child", parent.node, UIPanel, { width: 50 as UILength, height: 40 as UILength, positionType: "absolute", left: 30 as UILength, top: 7 as UILength } as Partial<UIPanel>);
    const c = await core({ interactive: false });
    sync(c);
    const p = c.cornersOf(parent)!.points[0], q = c.cornersOf(child)!.points[0];
    expect([q[0] - p[0] - 5, q[1] - p[1] - 5]).toEqual([30, 7]);
    child.left = "50%";
    sync(c);
    // 50% of the padding box's width (400 - 2 × 5).
    expect(c.cornersOf(child)!.points[0][0] - p[0] - 5).toBe(195);
  });
});
