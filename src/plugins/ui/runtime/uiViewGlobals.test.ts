import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject, Input, Locale, MemoryStorage, t } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIButton, UIText } from "../../../engine/ui/components";
import { UIPointer } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import * as GlobalsModule from "./testComponents/Globals.svelte";
import * as LegacyModule from "./testComponents/Legacy.svelte";

// ADR 0423 wave X2: the Svelte patch's hooks through a UIView and the engine's renderer — <svelte:window>,
// <svelte:document> and <svelte:body> (events from the device snapshot, size bindings from the canvas), <svelte:head>'s
// title, `css: 'injected'`, legacy `on:` — plus `t()` from "myco" and the Element subset on renderer nodes.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

const TABLES = {
  "strings/menu.strings.json": { format: "myco.strings@1", language: "en", strings: [{ key: "menu.hello", text: "Hello {name}" }] },
  "strings/menu.fr.strings.json": { format: "myco.translation@1", language: "fr", strings: { "menu.hello": "Bonjour {name}" } },
};

beforeEach(async () => {
  Input.reset();
  vi.stubGlobal("document", { title: "Untitled" });
  engine = await Engine.create({
    headless: true,
    project: { languages: { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], reference: "en", default: "en", useSystemLanguage: false } as never }, // project.json as written (the Engine resolves it)
    assets: Assets.fromObject({ ...TABLES, "ui/globals.svelte": GlobalsModule, "ui/legacy.svelte": LegacyModule }),
    storage: new MemoryStorage(),
  });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function view(component: string, props: Record<string, unknown>): Promise<UIView> {
  const v = GameObject.create("UI").addBehavior(UIView, { component: `asset:${component}`, props });
  await v.ready;
  return v;
}

const text = (v: UIView, selector: string) => v.query(selector)!.as(UIText).text;

describe("UIView: the Svelte patch's hooks", () => {
  it("binds the window's size and pixel ratio to the canvas in UI pixels, and sends resize when it changes", async () => {
    // The coordinator's units ruling (ADR 0422 wave 5): the window is the view's canvas after the canvas scaler (1280×720
    // reference pixels, matching height), and the pixel ratio is device pixels per UI pixel, as getBoundingClientRect
    // and canvas @media measure.
    const log: string[] = [];
    const nodes: Record<string, unknown> = {};
    const v = await view("ui/globals.svelte", { log: (s: string) => log.push(s), onnode: (k: string, n: unknown) => (nodes[k] = n) });
    pointer = await UIPointer.create(World.require(), 1280, 720);
    engine.step(DT);
    expect(text(v, "#size")).toBe("1280x720 @1");
    expect(log).not.toContain("resize");

    pointer.dispose();
    vi.stubGlobal("devicePixelRatio", 2);
    pointer = await UIPointer.create(World.require(), 1920, 1080); // scaled 1.5: the same canvas in UI pixels, at 3 device pixels each
    engine.step(DT);
    expect(text(v, "#size")).toBe("1280x720 @3");
    expect(log).not.toContain("resize");

    pointer.dispose();
    vi.stubGlobal("devicePixelRatio", 1);
    pointer = await UIPointer.create(World.require(), 800, 600); // 960×720 UI pixels at 5/6 of a CSS pixel each
    engine.step(DT);
    expect(text(v, "#size")).toBe(`960x720 @${600 / 720}`);
    expect(log.filter((l) => l === "resize")).toHaveLength(1);
  });

  it("sends the keys the game sees to the body, the document and the window, in that order, until one stops it", async () => {
    const log: string[] = [];
    const v = await view("ui/globals.svelte", { log: (s: string) => log.push(s), onnode: () => {} });
    engine.step(DT);
    Input.inject.keyDown("a");
    engine.step(DT);
    expect(log.filter((l) => !l.startsWith("tip"))).toEqual(["body a", "document a", "window a KeyA"]);

    log.length = 0;
    Input.inject.keyUp("a");
    Input.inject.keyDown("Escape");
    engine.step(DT);
    engine.step(DT);
    expect(log).toEqual(["body Escape"]); // the body's handler stopped it

    // <svelte:head>'s <title> is the page's title (the window's, in a desktop build); the handler changed it.
    expect(document.title).toBe("Main menu");
    log.length = 0;
    Input.inject.keyDown("Enter");
    engine.step(DT);
    expect(log).toContain("window Enter Enter");
    expect(document.title).toBe("Pressed");
    expect(v.root!.children.map((c) => c.tag)).toEqual(["div"]); // other head content isn't UI
  });

  it("follows the UI's focus with document.activeElement", async () => {
    const v = await view("ui/globals.svelte", { log: () => {}, onnode: () => {} });
    engine.step(DT);
    expect(text(v, "#active")).toBe("BODY");
    v.query("#tip")!.as(UIButton).focused = true;
    engine.step(DT);
    expect(text(v, "#active")).toBe("tip");
  });

  it("styles components compiled with css: 'injected', and makes t() follow the language", async () => {
    const v = await view("ui/globals.svelte", { log: () => {}, onnode: () => {}, name: "Ada" });
    expect(v.query("#size")!.as(UIText).color).toEqual(Color.from("#00ff00"));
    expect(text(v, "#greeting")).toBe("Hello Ada");
    expect(t("menu.hello", { name: "Bo" })).toBe("Hello Bo"); // outside a component it's Locale.t

    await Locale.setLanguage("fr");
    engine.step(DT);
    expect(text(v, "#greeting")).toBe("Bonjour Ada");
    v.props.name = "Cy";
    engine.step(DT);
    expect(text(v, "#greeting")).toBe("Bonjour Cy");
  });

  it("gives actions an Element subset: dataset, style properties, closest, matches, contains, siblings, transformed bounds", async () => {
    const log: string[] = [];
    const nodes: Record<string, { getBoundingClientRect(): { width: number; height: number }; dataset: Record<string, string | undefined>; style: Record<string, string>; nextElementSibling: { id: string } | null; previousElementSibling: { id: string } | null; getAttributeNames(): string[] }> = {};
    const v = await view("ui/globals.svelte", { log: (s: string) => log.push(s), onnode: (k: string, n: never) => (nodes[k] = n) });
    pointer = await UIPointer.create(World.require());
    engine.step(DT);
    expect(log).toContain("tip root true true hi size");
    const tip = nodes.tip;
    expect(tip.dataset.tipText).toBe("hi");
    expect(Object.keys(tip.dataset)).toEqual(["tipText"]);
    expect(tip.getAttributeNames()).toEqual(expect.arrayContaining(["id", "class", "data-tip-text", "style"]));
    expect(tip.style.backgroundColor).toBe("#ff0000");
    expect(v.query("#tip")!.as(UIButton).backgroundColor).toEqual(Color.from("#ff0000")); // the inline style reached the cascade
    expect(tip.previousElementSibling!.id).toBe("greeting");
    expect(tip.nextElementSibling!.id).toBe("active");
    delete tip.dataset.tipText;
    expect(tip.dataset.tipText).toBeUndefined();

    // A 100×50 box turned a quarter: its bounds are 50 wide and 100 tall.
    pointer.sync();
    const r = nodes.box.getBoundingClientRect();
    expect(r.width).toBeCloseTo(50);
    expect(r.height).toBeCloseTo(100);
  });

  it("runs legacy on: directives with their modifiers, on elements and on <svelte:window>", async () => {
    const log: string[] = [];
    const v = await view("ui/legacy.svelte", { log: (s: string) => log.push(s) });
    pointer = await UIPointer.create(World.require());
    for (let i = 0; i < 2; i++) {
      pointer.click(v.query("#once")!.as(UIButton));
      engine.step(DT);
      engine.step(DT);
    }
    expect(v.query("#once")!.children[0].as(UIText).text).toBe("1"); // |once
    pointer.click(v.query("#stop")!.as(UIButton));
    engine.step(DT);
    expect(log).toEqual(["stop true"]); // |preventDefault ran before the handler
    Input.inject.keyDown("x");
    engine.step(DT);
    Input.inject.keyUp("x");
    engine.step(DT);
    expect(log).toEqual(["stop true", "keyup x"]);

    // Unmounting removes the component's <svelte:window> listeners.
    v.enabled = false;
    Input.inject.keyDown("y");
    engine.step(DT);
    Input.inject.keyUp("y");
    engine.step(DT);
    expect(log).toEqual(["stop true", "keyup x"]);
  });
});
