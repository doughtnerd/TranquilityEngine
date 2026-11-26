import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input, Time } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIPanel } from "../../../engine/ui/components";
import { UIPointer } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import renderer from "../svelte/renderer";
import * as TransitionsModule from "./testComponents/Transitions.svelte";
import * as ListsModule from "./testComponents/Lists.svelte";

// ADR 0419 wave Y2: `transition:`, `in:`, `out:` and `animate:` through the Svelte patch's `animate` and `measure`
// hooks, played by the engine's renderer on the UI animator (ADR 0418 wave 4) and driven by engine frames.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "ui/transitions.svelte": TransitionsModule, "ui/lists.svelte": ListsModule }));
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function view(component: string, props: Record<string, unknown>): Promise<UIView> {
  const v = GameObject.create("UI").addBehavior(UIView, { component: `asset:${component}`, props });
  await v.ready;
  return v;
}

/** Steps `n` frames, recording `read()` after each. */
function frames<T>(n: number, read: () => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    engine.step(DT);
    out.push(read());
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A field of the element `selector` finds (rounded when it's a number), or null once it's gone. */
function field(v: UIView, selector: string, name: string): unknown {
  const el = v.query(selector);
  if (!el) return null;
  const value = (el.component as unknown as Record<string, unknown>)[name];
  return typeof value === "number" ? round(value) : value;
}

/** The transitions component with `kind` hidden; `show(true/false)` toggles it. */
async function transitions(kind: string, extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const props = { kind, log: (s: string) => log.push(s), ...extra };
  const v = await view("ui/transitions.svelte", { ...props, show: false });
  engine.step(DT);
  return { v, log, show: (show: boolean) => (v.props = { ...props, show }) };
}

describe("UIView: Svelte transitions (the patch's animate hook)", () => {
  it("fades in from the frame it's shown and out before the element goes, with intro and outro events", async () => {
    const { v, log, show } = await transitions("fade");
    show(true);
    // fade reads the element's own opacity (0.8, from its stylesheet) as where it ends; 100 ms at 60 fps.
    expect(frames(8, () => field(v, "#box", "opacity"))).toEqual([0, 0.133, 0.267, 0.4, 0.533, 0.667, 0.8, 0.8]);
    expect(log).toEqual(["introstart", "introend"]);
    expect(v.query("#box")!.as(UIPanel).opacity).toBe(0.8); // ended: the stylesheet's value again

    show(false);
    // The outro runs before the element is removed.
    expect(frames(9, () => field(v, "#box", "opacity"))).toEqual([0.8, 0.667, 0.533, 0.4, 0.267, 0.133, 0, null, null]);
    expect(log).toEqual(["introstart", "introend", "outrostart", "outroend"]);
  });

  it("reverses a bidirectional transition from where it is when it's toggled midway", async () => {
    const { v, show } = await transitions("fade");
    show(true);
    expect(frames(4, () => field(v, "#box", "opacity"))).toEqual([0, 0.133, 0.267, 0.4]);
    show(false);
    // Back from where it was (a frame on, as Svelte starts the reversed keyframes after a frame), not from 0.8.
    const out = frames(6, () => field(v, "#box", "opacity")) as (number | null)[];
    expect(out[0]).toBe(0.533);
    expect(out.slice(1).every((o, i) => o === null || o < out[i]!)).toBe(true);
    expect(out.at(-1)).toBeNull();
  });

  it("plays in: and out: separately: fly in (translate and opacity, eased), fade out", async () => {
    const { v, show } = await transitions("fly");
    show(true);
    const read = () => [field(v, "#box", "translateX"), field(v, "#box", "translateY"), field(v, "#box", "opacity")];
    const intro = frames(7, read);
    expect(intro[0]).toEqual(["100", "-20", 0]);
    expect(intro[3]).toEqual(["12.5", "-2.5", 0.7]); // cubicOut at t = 0.5
    expect(intro[6]).toEqual(["0", "0", 0.8]);
    show(false);
    // The outro is fade (50 ms): translate stays put.
    expect(frames(4, read)).toEqual([["0", "0", 0.8], ["0", "0", 0.533], ["0", "0", 0.267], [null, null, null]]);
  });

  it("scales with scale", async () => {
    const { v, show } = await transitions("scale");
    show(true);
    const scales = frames(7, () => [field(v, "#box", "scaleX"), field(v, "#box", "scaleY")]);
    expect(scales[0]).toEqual([0.5, 0.5]);
    expect(scales[3]).toEqual([0.938, 0.938]);
    expect(scales[6]).toEqual([1, 1]);
  });

  it("slides from its laid-out height and padding, clipped while it slides", async () => {
    pointer = await UIPointer.create(World.require());
    const { v, show } = await transitions("slide");
    show(true);
    const read = () => [field(v, "#box", "height"), field(v, "#box", "paddingTop"), field(v, "#box", "overflow")];
    const intro = frames(8, read);
    expect(intro[0]).toEqual(["0", 0, "hidden"]);
    // Its height (auto: as laid out, a border box stretched to the canvas) and its padding grow back, eased.
    expect(intro[3]).toEqual(["630", 8.75, "hidden"]);
    expect(intro[6]).toEqual(["720", 10, "hidden"]);
    expect(intro[7]).toEqual(["auto", null, "visible"]); // ended: its own style again
    show(false);
    const outro = frames(8, read);
    expect(outro[0]).toEqual(["720", 10, "hidden"]);
    expect(outro.at(-1)).toEqual([null, null, null]);
  });

  it("holds the first keyframe through a delay, then plays", async () => {
    const { v, show } = await transitions("delay");
    show(true);
    expect(frames(8, () => field(v, "#box", "opacity"))).toEqual([0, 0, 0, 0, 0.267, 0.533, 0.8, 0.8]);
  });

  it("runs a tick transition's function on each frame", async () => {
    const { v, show } = await transitions("tick");
    show(true);
    expect(frames(7, () => field(v, "#box", "text"))).toEqual(["", "H", "He", "Hel", "Hel", "Hell", "Hello"]);
  });

  it("runs on unscaled time: a paused game's UI still transitions", async () => {
    const { v, show } = await transitions("fade");
    Time.timeScale = 0;
    show(true);
    expect(frames(7, () => field(v, "#box", "opacity"))).toEqual([0, 0.133, 0.267, 0.4, 0.533, 0.667, 0.8]);
  });

  it("blurs in through the filter fields (ADR 0426) as it fades", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blur = await transitions("blur");
    blur.show(true);
    const both = frames(7, () => [field(blur.v, "#box", "opacity"), field(blur.v, "#box", "filterBlur")]);
    expect(both[0]).toEqual([0, 5]); // blur's default amount, 5px, unblurring as it fades in
    expect((both[3][1] as number) > 0 && (both[3][1] as number) < 5).toBe(true);
    expect(both[6]).toEqual([0.8, 0]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("can't animate filter"))).toBe(false);
  });

  it.skip("draw: replaced below", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const draw = await transitions("draw");
    draw.show(true);
    expect(frames(7, () => field(draw.v, "#box", "opacity"))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("getTotalLength") && String(c[0]).includes("ADR 0426"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("can't animate stroke-dasharray"))).toBe(true);
  });
});

describe("UIView: animate:flip, crossfade and local transitions (the patch's measure hook)", () => {
  const box = (v: UIView, id: string) => {
    const el = v.query(`#${id}`);
    if (!el) return null;
    const c = el.component as unknown as Record<string, unknown>;
    return `${round(c.opacity as number)} ${c.translateX},${c.translateY}`;
  };

  async function lists(): Promise<{ v: UIView; set: (p: Record<string, unknown>) => void }> {
    pointer = await UIPointer.create(World.require());
    let props: Record<string, unknown> = { items: ["a", "b", "c"], done: [], open: true, inner: true };
    const v = await view("ui/lists.svelte", props);
    for (let i = 0; i < 8; i++) engine.step(DT); // past the |global transition's intro, which plays on mount
    return { v, set: (p) => (v.props = props = { ...props, ...p }) };
  }

  it("moves reordered items from where they were to where they are (flip, laid out when measured)", async () => {
    const { v, set } = await lists();
    set({ items: ["c", "b", "a"] }); // 30 px apart: a moves down 60, c up 60
    const moves = frames(7, () => ["a", "b", "c"].map((k) => box(v, `item-${k}`)));
    expect(moves[0]).toEqual(["1 0,-60", "1 0,0", "1 0,60"]);
    expect(moves[6]).toEqual(["1 0,0", "1 0,0", "1 0,0"]);
    const a = moves.map((m) => Number(m[0]!.split(",")[1]));
    expect(a.every((y, i) => i === 0 || (y >= a[i - 1] && y <= 0))).toBe(true); // eased towards 0, never past it
  });

  it("crossfades an item from one list to the other while the rest flip into place", async () => {
    const { v, set } = await lists();
    set({ items: ["a", "c"], done: ["b"] });
    const steps = frames(8, () => [box(v, "item-b"), box(v, "done-b"), box(v, "item-c")]);
    // The leaving item is taken out of flow (absolute, kept where it was by a translate) and flies to the new one,
    // fading out, as the new one flies in from where it was; c, below it, moves up into its place.
    expect(steps[0]).toEqual(["1 0,30", "0 -200,30", "1 0,30"]);
    expect(steps[6]).toEqual(["0 200,0", "1 0,0", "1 0,0"]);
    expect(steps[7]).toEqual([null, "1 0,0", "1 0,0"]);
  });

  it("plays a local transition only when its own block changes, a |global one with any", async () => {
    const { v, set } = await lists();
    const read = () => [field(v, "#local", "opacity"), field(v, "#global", "opacity")];
    set({ open: false }); // the outer block: only the global one plays its outro
    expect(frames(8, read)).toEqual([[1, 1], [1, 0.833], [1, 0.667], [1, 0.5], [1, 0.333], [1, 0.167], [1, 0], [null, null]]);
    set({ open: true });
    expect(frames(2, read)).toEqual([[1, 0], [1, 0.167]]);
    for (let i = 0; i < 6; i++) engine.step(DT);
    set({ inner: false }); // their own block: both play
    expect(frames(2, read)).toEqual([[1, 1], [0.833, 0.833]]);
  });
});

describe("UIView: the measure hook", () => {
  it("gives a node's box through its transforms, its inner size and its computed style", async () => {
    pointer = await UIPointer.create(World.require());
    let node: unknown = null;
    const { show } = await transitions("probe", { onnode: (n: unknown) => (node = n ?? node) });
    show(true);
    engine.step(DT);
    const m = (renderer as unknown as { measure(node: unknown): { left: number; top: number; width: number; height: number; clientWidth: number; clientHeight: number; style: Record<string, string> & { getPropertyValue(n: string): string } } }).measure(node);
    // 100 × 40 (border box), turned a quarter about its top left and doubled: 80 wide and 200 tall, left of its origin.
    expect([m.left, m.top, m.width, m.height].map(round)).toEqual([-70, 5, 80, 200]);
    expect([m.clientWidth, m.clientHeight]).toEqual([96, 36]);
    expect(m.style.transform).toBe("translate(10px, 5px) rotate(90deg) scale(2, 2)");
    expect(m.style.getPropertyValue("transform-origin")).toBe("0px 0px");
    expect([m.style.width, m.style.height, m.style.paddingLeft, m.style.paddingTop, m.style.borderTopWidth]).toEqual(["100px", "40px", "6px", "4px", "2px"]);
    expect(m.style.opacity).toBe("0.8");
    expect(m.style.filter).toBe("none");
    expect(m.style.somethingElse).toBe("");
  });
});

describe("UIView: svelte/motion", () => {
  it("drives fields from Tween and Spring through style:, frame by frame on Svelte's clock", async () => {
    // svelte/motion reads `prefers-reduced-motion` when it's imported (MediaQuery; canvas @media is wave Y1's).
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    const MotionModule = await import("./testComponents/Motion.svelte");
    vi.unstubAllGlobals();
    Assets.addSource(Assets.fromObject({ "ui/motion.svelte": MotionModule }));
    // svelte/motion runs on Svelte's own frame clock (requestAnimationFrame in a browser, none in Node): the test drives it.
    const { raf } = (await import("svelte/internal/client")) as unknown as { raf: { tick: (f: (n: number) => void) => void; now: () => number } };
    const saved = { tick: raf.tick, now: raf.now };
    const ticks: ((n: number) => void)[] = [];
    let now = 0;
    raf.tick = (f) => void ticks.push(f);
    raf.now = () => now;
    try {
      const v = await view("ui/motion.svelte", { target: 0 });
      v.props = { target: 100 };
      const widths: number[] = [];
      const heights: number[] = [];
      for (let i = 0; i < 8; i++) {
        engine.step(DT);
        now += 1000 / 60;
        for (const f of ticks.splice(0)) f(now);
        widths.push(Number(field(v, "#tween", "width")));
        heights.push(Number(field(v, "#spring", "height")));
      }
      expect(widths[1]).toBeGreaterThan(0);
      expect(widths.every((w, i) => i === 0 || w >= widths[i - 1])).toBe(true);
      expect(widths.at(-1)).toBe(100); // 100 ms, linear
      expect(heights.at(-1)).toBeGreaterThan(0);
    } finally {
      raf.tick = saved.tick;
      raf.now = saved.now;
    }
  });
});
