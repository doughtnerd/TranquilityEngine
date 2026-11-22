import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GAMEPAD_AXES, GAMEPAD_BUTTONS, Input, InputGlyphs, InputPlayers, button, chordOf, defineActions, dpad, vec2 } from "../index";

// ADR 0337: the default glyph set draws every icon key a prompt can give, for each family, and
// serves each glyph as markup, a URL and an asset path that texture fields take.

defineActions("test.inputGlyphs.Actions", {
  walk: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStick"),
  leap: button("<Keyboard>/space", "<Gamepad>/buttonSouth"),
  fire: button("<Pointer>/button0", "<Gamepad>/rightTrigger"),
  roll: button(chordOf("<Keyboard>/shift", "<Keyboard>/r")),
});

const PAD_FAMILIES = ["xbox", "playstation", "switch", "generic"] as const;
const PAD_CONTROLS = [...GAMEPAD_BUTTONS, ...GAMEPAD_AXES, "leftStick", "rightStick", "dpad", "gyro", "accel"];
const POINTER_CONTROLS = ["button0", "button1", "button2", "button3", "button4", "delta", "scroll", "position"];

/** A well-formed standalone SVG of the stated size, with nothing left unfilled. */
function expectSvg(svg: string, width: number, height: number): void {
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  expect(svg).toContain(`width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`);
  expect(svg.endsWith("</svg>")).toBe(true);
  expect(svg).not.toMatch(/undefined|NaN|null/);
  // Every tag that opens closes (self-closing ones aside).
  const opened = (svg.match(/<(svg|g|text)\b/g) ?? []).length;
  const closed = (svg.match(/<\/(svg|g|text)>/g) ?? []).length;
  expect(closed).toBe(opened);
}

describe("the default glyph set (ADR 0337)", () => {
  it("draws every gamepad control in each family's style, and every pointer control", () => {
    for (const family of PAD_FAMILIES) {
      for (const name of PAD_CONTROLS) {
        const g = InputGlyphs.get(`${family}/${name}`);
        expect(g, `${family}/${name}`).not.toBeNull();
        expect(g!.key).toBe(`${family}/${name}`);
        expectSvg(g!.svg, g!.width, g!.height);
      }
    }
    for (const name of POINTER_CONTROLS) expectSvg(InputGlyphs.get(`pointer/${name}`)!.svg, 64, 64);
    // Face buttons: PlayStation's are shapes, Xbox's coloured letters, Switch's letters in its own layout.
    expect(InputGlyphs.get("playstation/buttonSouth")!.svg).not.toContain("<text");
    expect(InputGlyphs.get("xbox/buttonSouth")!.svg).toMatch(/>A<\/text>/);
    expect(InputGlyphs.get("switch/buttonSouth")!.svg).toMatch(/>B<\/text>/);
    expect(InputGlyphs.get("switch/buttonEast")!.svg).toMatch(/>A<\/text>/);
    expect(InputGlyphs.get("xbox/leftTrigger")!.svg).toMatch(/>LT<\/text>/);
    expect(InputGlyphs.get("playstation/leftTrigger")!.svg).toMatch(/>L2<\/text>/);
    expect(InputGlyphs.get("switch/leftTrigger")!.svg).toMatch(/>ZL<\/text>/);
    const faces = PAD_FAMILIES.map((f) => InputGlyphs.get(`${f}/buttonSouth`)!.svg);
    expect(new Set(faces).size).toBe(4);
    // Each d-pad direction is drawn differently.
    expect(new Set(["dpadUp", "dpadDown", "dpadLeft", "dpadRight", "dpad"].map((d) => InputGlyphs.get(`xbox/${d}`)!.svg)).size).toBe(5);
  });

  it("draws any key as a keycap with its label, wider for longer labels", () => {
    const space = InputGlyphs.get("keyboard/space")!;
    expect(space.svg).toMatch(/>Space<\/text>/);
    expect(InputGlyphs.get("keyboard/a")!.svg).toMatch(/>A<\/text>/);
    expect(InputGlyphs.get("keyboard/arrowleft")!.svg).toMatch(/>←<\/text>/);
    expect(InputGlyphs.get("keyboard/&")!.svg).toContain(">&#38;</text>"); // escaped
    expect(InputGlyphs.get("keyboard/a")!.width).toBe(64);
    expect(InputGlyphs.get("keyboard/backspace")!.width).toBeGreaterThan(space.width);
    expectSvg(InputGlyphs.get("keyboard/backspace")!.svg, InputGlyphs.get("keyboard/backspace")!.width, 64);
  });

  it("has nothing for keys outside the set", () => {
    expect(InputGlyphs.get("")).toBeNull();
    expect(InputGlyphs.get("keyboard/")).toBeNull();
    expect(InputGlyphs.get("steering/wheel")).toBeNull();
  });

  it("serves each glyph as a URL and as an asset path, whatever sources the game registers", async () => {
    const g = InputGlyphs.get("xbox/buttonSouth")!;
    expect(g.url).toMatch(/^(blob:|data:image\/svg\+xml)/);
    expect(g.url).toBe(g.url); // made once
    expect(g.asset).toBe("asset:@myco/glyphs/xbox/buttonSouth.svg");
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "images/logo.png": "logo-url" }));
    expect(Assets.has(g.asset)).toBe(true);
    expect(Assets.url(g.asset)).toBe(g.url);
    expect(Assets.url("images/logo.png")).toBe("logo-url");
    expect(Assets.has("asset:@myco/glyphs/steering/wheel.svg")).toBe(false);
    Assets.clearSources();
    if (g.url.startsWith("blob:")) expect(await (await fetch(g.url)).text()).toBe(g.svg);
  });
});

describe("glyphs for prompts (ADR 0337)", () => {
  let engine: Engine;
  beforeEach(async () => {
    Input.reset();
    engine = await Engine.create({ headless: true });
    engine.step(1 / 60);
  });
  afterEach(() => {
    engine.dispose();
    Input.reset();
  });

  it("has a glyph for every icon a prompt gives, and names the rebind part of each control", () => {
    const p = InputPlayers.get(0)!;
    for (const action of ["walk", "leap", "fire", "roll"]) {
      for (const family of ["keyboard", ...PAD_FAMILIES] as const) {
        const prompt = p.prompt(action, family);
        if (!prompt) continue;
        expect(InputGlyphs.of(prompt).map((g) => g.key)).toEqual(prompt.icons);
        expect(prompt.parts).toHaveLength(prompt.controls.length);
      }
    }
    expect(p.prompt("walk", "keyboard")!.parts).toEqual(["up", "down", "left", "right"]);
    expect(p.prompt("roll", "keyboard")!.parts).toEqual(["modifier0", "control"]);
    expect(p.prompt("leap", "switch")!.parts).toEqual(["control"]);
    expect(p.prompt("leap", "switch")!.context).toBe("default");
    expect(InputGlyphs.of(p.prompt("fire", "keyboard")!)[0].key).toBe("pointer/button0");
  });
});
