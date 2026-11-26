// ADR 0428 (G3, text): `white-space` on plain texts and inline runs, run `:hover`/`:active`, inline boxes (padding, borders,
// margins on runs) and atomic inline boxes (inline blocks, controls, SVG and media inside text), through a Svelte view
// (`uiMarkup.ts`) laid out by the UI core and drawn by the Babylon layer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, UIButton, UIText } from "../../myco";
import { UIPointer } from "./uiPointer";
import { World } from "../core/World";
import { UICore } from "../ui/UICore";
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

describe("white-space (ADR 0428)", () => {
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

describe("run :hover and :active (ADR 0428)", () => {
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
