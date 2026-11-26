// ADR 0418 wave 4: transitions, `@keyframes` and `animation` in UI stylesheets — their values as CSS text, the
// cascade that orders them, the timing functions as engine curves against CSS's own definitions, and what built
// documents and hosted elements show frame by frame as the engine steps, on both tween backends (ADR 0420: the
// animation core's table with the animation plugin on, the standalone tween module without it). Frame times are
// binary fractions (1/64 s), so the clock adds up exactly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject, Time } from "../index";
import { evalCurve } from "../core/curve";
import { World } from "../core/World";
import { applyTestPlugins } from "../../plugins/testPlugins";
import { UIPanel, UIText } from "../ui/components";
import { loadUIHostSupport, setUIHostStyles, UIHostTree, type UIHostEvent } from "../ui/host/UIHost";
import { uiAnimationReady } from "../ui/animation/UIAnimator";
import { timingCurve } from "../ui/animation/timingCurves";
import { parseAnimation, parseTime, parseTimingFunction, parseTransition, type UITimingFunction } from "../ui/document/animationValues";
import { ANIMATION_KEY, keyframeTracks, parseStylesheet, resolveStyle, TRANSITION_KEY, transitionFields, fieldsOf } from "../ui/document/stylesheet";
import type { MarkupElement, StyleTarget, UITag } from "../ui/document/types";
import { buildUI, byId, classList, loadUITestSupport, uiAs, type TestUI } from "./uiMarkup";

const DT = 1 / 64;

// --- CSS's definitions, computed independently (for the curves to be checked against) ----------------

/** CSS `cubic-bezier(x1, y1, x2, y2)` at `x`: the parameter by Newton's method with a bisection fallback, in f64. */
function cssBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sx(t) - x;
    if (Math.abs(err) < 1e-12) return sy(t);
    const d = dx(t);
    if (Math.abs(d) < 1e-9) break;
    t -= err / d;
  }
  let lo = 0, hi = 1;
  t = x;
  while (hi - lo > 1e-12) {
    if (sx(t) < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sy(t);
}

/** CSS `steps(n, position)` at `x` in [0, 1) (CSS Easing 1, "step easing functions"). */
function cssSteps(n: number, position: string, x: number): number {
  let current = Math.floor(x * n);
  if (position === "jump-start" || position === "jump-both") current += 1;
  const jumps = position === "jump-none" ? n - 1 : position === "jump-both" ? n + 1 : n;
  return current / jumps;
}

const EASE = [0.25, 0.1, 0.25, 1] as const;

// --- Values -----------------------------------------------------------------------------------------

describe("animation values (ADR 0418 wave 4)", () => {
  it("reads times in s and ms (a bare 0 too)", () => {
    expect(parseTime("0.25s")).toBe(0.25);
    expect(parseTime("250ms")).toBe(0.25);
    expect(parseTime("-1s")).toBe(-1);
    expect(parseTime("0")).toBe(0);
    expect(parseTime("2")).toBeUndefined();
    expect(parseTime("1px")).toBeUndefined();
  });

  it("reads the timing keywords, cubic-bezier() and steps(), and says why others can't be read", () => {
    expect(parseTimingFunction("ease")).toEqual({ ok: true, value: { kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } });
    expect(parseTimingFunction("ease-in-out")).toEqual({ ok: true, value: { kind: "bezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 } });
    expect(parseTimingFunction("linear")).toEqual({ ok: true, value: { kind: "linear" } });
    expect(parseTimingFunction("cubic-bezier(0.1, -0.5, 0.9, 1.5)")).toEqual({ ok: true, value: { kind: "bezier", x1: 0.1, y1: -0.5, x2: 0.9, y2: 1.5 } });
    expect(parseTimingFunction("steps(4)")).toEqual({ ok: true, value: { kind: "steps", steps: 4, position: "jump-end" } });
    expect(parseTimingFunction("steps(3, start)")).toEqual({ ok: true, value: { kind: "steps", steps: 3, position: "jump-start" } });
    expect(parseTimingFunction("step-end")).toEqual({ ok: true, value: { kind: "steps", steps: 1, position: "jump-end" } });
    const problem = (v: string) => {
      const r = parseTimingFunction(v);
      return r.ok ? null : r.problem;
    };
    expect(problem("cubic-bezier(1.5, 0, 0, 1)")).toMatch(/between 0 and 1/);
    expect(problem("cubic-bezier(0, 0, 1)")).toMatch(/four numbers/);
    expect(problem("steps(1, jump-none)")).toMatch(/at least 2/);
    expect(problem("steps(2, sideways)")).toMatch(/isn't a steps\(\) position/);
    expect(problem("wobble")).toMatch(/isn't a timing function/);
  });

  it("reads transition shorthands: properties, times in either order of kind, defaults, several", () => {
    const r = parseTransition("opacity 0.3s, background-color 200ms ease-in 50ms, 1s");
    expect(r).toEqual({
      ok: true,
      value: {
        property: ["opacity", "background-color", "all"],
        duration: [0.3, 0.2, 1],
        delay: [0, 0.05, 0],
        timing: [{ kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }, { kind: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 }, { kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }],
      },
    });
    expect(parseTransition("transform 1s linear -0.5s").ok && parseTransition("transform 1s linear -0.5s")).toMatchObject({ value: { delay: [-0.5] } });
    expect(parseTransition("opacity -1s").ok).toBe(false);
    expect(parseTransition("opacity 1s 2s 3s").ok).toBe(false);
  });

  it("reads animation shorthands: name, times, iterations, direction, fill and play state in any order", () => {
    expect(parseAnimation("pulse 2s ease-out 0.5s infinite alternate both paused")).toEqual({
      ok: true,
      value: {
        name: ["pulse"],
        duration: [2],
        delay: [0.5],
        timing: [{ kind: "bezier", x1: 0, y1: 0, x2: 0.58, y2: 1 }],
        iterations: [Infinity],
        direction: ["alternate"],
        fill: ["both"],
        playState: ["paused"],
      },
    });
    const two = parseAnimation("3 reverse spin 1s, fade 250ms forwards");
    expect(two.ok && [two.value.name, two.value.iterations, two.value.direction, two.value.fill]).toEqual([["spin", "fade"], [3, 1], ["reverse", "normal"], ["none", "forwards"]]);
    expect(parseAnimation("a 1s -2").ok).toBe(false);
  });
});

// --- Stylesheets and the cascade --------------------------------------------------------------------

function target(tag: UITag, classes: string[] = []): StyleTarget {
  return { tag, id: null, classes, state: { hover: false, pressed: false, focus: false, disabled: false }, parent: null };
}

function element(tag: UITag, attributes: Record<string, string> = {}): MarkupElement {
  const span = { start: 0, end: 0 };
  return { tag, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value, span, valueSpan: span })), file: "ui/t.svelte" };
}

describe("linear() and transition-behavior (ADR 0428)", () => {
  const points = (v: string) => {
    const r = parseTimingFunction(v);
    if (!r.ok) return r.problem;
    return r.value.kind === "points" ? r.value.points.map(([x, y]) => [Math.round(x * 1e9) / 1e9, y]) : r.value;
  };

  it("reads linear() stops and normalises their inputs as CSS Easing 2 does", () => {
    expect(points("linear(0, 0.25 75%, 1)")).toEqual([[0, 0], [0.75, 0.25], [1, 1]]);
    expect(points("linear(0, 0.5, 0.25, 1)")).toEqual([[0, 0], [0.333333333, 0.5], [0.666666667, 0.25], [1, 1]]); // spread evenly
    expect(points("linear(0 20%, 0.5 10%, 1)")).toEqual([[0.2, 0], [0.2, 0.5], [1, 1]]); // an input below an earlier one rises to it
    expect(points("linear(0, 0.5 25% 75%, 1)")).toEqual([[0, 0], [0.25, 0.5], [0.75, 0.5], [1, 1]]); // two inputs: a flat stretch
    expect(points("linear(1)")).toMatch(/at least two stops/);
    expect(points("linear(0, fast)")).toMatch(/isn't a linear\(\) stop/);
    expect(parseTransition("opacity 1s linear(0, 0.5 50%, 1)").ok).toBe(true);
  });

  it("reads transition-behavior in the shorthand and as a longhand, ordered like the other longhands", () => {
    expect(parseTransition("display 1s allow-discrete, opacity 1s")).toMatchObject({ ok: true, value: { property: ["display", "opacity"], behavior: ["allow-discrete", "normal"] } });
    expect(parseTransition("opacity 1s")).toEqual({ ok: true, value: { property: ["opacity"], duration: [1], delay: [0], timing: [{ kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }] } });
    const sheet = parseStylesheet(`.a { transition: display 1s, opacity 2s; transition-behavior: allow-discrete, normal } .b { transition-behavior: allow-discrete; transition: display 1s }`, "t.css");
    expect(sheet.problems).toEqual([]);
    const specs = (cls: string) => resolveStyle(target("Panel", [cls]), element("Panel"), UIPanel, [sheet], null, () => {}).get(TRANSITION_KEY)!.value;
    expect(specs("a")).toEqual([
      { property: "display", duration: 1, delay: 0, timing: expect.anything(), allowDiscrete: true },
      { property: "opacity", duration: 2, delay: 0, timing: expect.anything() },
    ]);
    expect(specs("b")).toEqual([{ property: "display", duration: 1, delay: 0, timing: expect.anything() }]); // the shorthand reset it
  });
});

describe("@keyframes and the cascade (ADR 0418 wave 4)", () => {
  it("parses @keyframes blocks: from, to, percentages and lists, and reports what it can't read", () => {
    const sheet = parseStylesheet(`@keyframes pulse { from { opacity: 0 } 50%, 75% { opacity: .5; animation-timing-function: ease-in } to { opacity: 1 } }
      @keyframes bad { 120% { opacity: 1 } }
      @supports (display: flex) { .a { opacity: 1 } }
      .a { color: red }`, "ui/a.css");
    expect(sheet.rules).toHaveLength(1);
    expect(sheet.keyframes?.map((k) => [k.name, k.frames.map((f) => f.offsets)])).toEqual([["pulse", [[0], [0.5, 0.75], [1]]], ["bad", []]]);
    expect(sheet.keyframes?.[0].frames[1].declarations.map((d) => [d.property, d.value])).toEqual([["opacity", ".5"], ["animation-timing-function", "ease-in"]]);
    expect(sheet.problems.map((p) => p.message)).toEqual([expect.stringMatching(/a keyframe selector is from, to or a percentage/), expect.stringMatching(/@supports isn't supported/)]);
  });

  it("orders transition and animation declarations like fields: specificity, longhands over shorthands, attributes last, variables", () => {
    const sheet = parseStylesheet(`:root { --t: 0.5s } Panel { transition: opacity 1s, transform var(--t) linear } .fast { transition-duration: 100ms } Panel { animation: spin 2s infinite }`, "ui/a.css");
    expect(sheet.problems).toEqual([]);
    const resolved = resolveStyle(target("Panel", ["fast"]), element("Panel", { "animation-play-state": "paused" }), UIPanel, [sheet], null, () => {});
    expect(resolved.get(TRANSITION_KEY)?.value).toEqual([
      { property: "opacity", duration: 0.1, delay: 0, timing: { kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
      { property: "transform", duration: 0.1, delay: 0, timing: { kind: "linear" } },
    ]);
    expect(resolved.get(ANIMATION_KEY)?.value).toMatchObject([{ name: "spin", duration: 2, iterations: Infinity, playState: "paused" }]);
    // Never fields: no warning about an unknown property, nothing the document writes.
    const warnings: string[] = [];
    resolveStyle(target("Panel"), element("Panel", { transition: "opacity wobbly" }), UIPanel, [sheet], null, (m) => warnings.push(m));
    expect(warnings).toEqual([expect.stringMatching(/"opacity wobbly" isn't valid/)]);
  });

  it("maps transition properties onto the fields they cover: all, shorthands' longhands, one field", () => {
    const fields = fieldsOf(UIPanel);
    expect(transitionFields("padding", fields)).toEqual(["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]);
    expect(transitionFields("transform", fields)).toEqual(["translateX", "translateY", "scaleX", "scaleY", "rotate", "transformMatrix"]);
    expect(transitionFields("box-shadow", fields)).toEqual(["boxShadowColor", "boxShadowOffsetX", "boxShadowOffsetY", "boxShadowBlur"]);
    expect(transitionFields("background-color", fields)).toEqual(["backgroundColor"]);
    expect(transitionFields("color", fields)).toEqual([]); // a Panel has no color
    expect(transitionFields("all", fields)).toContain("opacity");
  });

  it("converts keyframes per element: shorthands expand, variables substitute, the last block of a name wins", () => {
    const sheet = parseStylesheet(`@keyframes k { to { opacity: 0 } }
      @keyframes k { from { transform: translate(4px, 50%) rotate(90deg); padding: 2px 4px } 50% { opacity: var(--half); animation-timing-function: steps(2) } }`, "ui/a.css");
    const vars = new Map([["--half", { field: "--half", value: "0.5", source: { kind: "default" as const } }]]);
    const tracks = keyframeTracks([sheet], "k", UIPanel, vars, "ui/a.svelte", () => {})!;
    expect(tracks.get("opacity")).toEqual([{ offset: 0.5, value: 0.5, timing: { kind: "steps", steps: 2, position: "jump-end" } }]);
    expect(tracks.get("translateY")).toEqual([{ offset: 0, value: "50%", timing: null }]);
    expect(tracks.get("rotate")).toEqual([{ offset: 0, value: 90, timing: null }]);
    expect(tracks.get("paddingRight")).toEqual([{ offset: 0, value: 4, timing: null }]);
    expect(keyframeTracks([sheet], "missing", UIPanel, vars, "ui/a.svelte", () => {})).toBeNull();
  });
});

// --- Timing functions as engine curves ---------------------------------------------------------------

describe("timing functions as engine curves (ADR 0418 wave 4)", () => {
  const xs = Array.from({ length: 41 }, (_, i) => i / 40);

  it.each([
    ["ease", EASE],
    ["ease-in", [0.42, 0, 1, 1]],
    ["ease-out", [0, 0, 0.58, 1]],
    ["ease-in-out", [0.42, 0, 0.58, 1]],
    ["cubic-bezier(0.68, -0.55, 0.27, 1.55)", [0.68, -0.55, 0.27, 1.55]],
  ] as const)("%s is CSS's cubic Bézier, forwards and reversed", (css, [x1, y1, x2, y2]) => {
    const tf = parseTimingFunction(css);
    if (!tf.ok) throw new Error(tf.problem);
    const forward = timingCurve(tf.value)!;
    const reversed = timingCurve(tf.value, true)!;
    for (const x of xs) {
      expect(evalCurve(forward, x)).toBeCloseTo(cssBezier(x1, y1, x2, y2, x), 6);
      expect(evalCurve(reversed, x)).toBeCloseTo(1 - cssBezier(x1, y1, x2, y2, 1 - x), 6);
    }
  });

  it("linear() is CSS's linear easing function over its points, forwards and reversed (ADR 0428)", () => {
    /** CSS Easing 2's linear easing function at `x`: the segment of the last point at or before it, extended at the ends. */
    const cssLinear = (pts: readonly (readonly [number, number])[], x: number) => {
      let a = 0;
      for (let i = 0; i < pts.length; i++) if (pts[i][0] <= x) a = i;
      if (a === pts.length - 1) a--;
      const [p, q] = [pts[a], pts[a + 1]];
      if (p[0] === q[0]) return q[1];
      return p[1] + ((x - p[0]) / (q[0] - p[0])) * (q[1] - p[1]);
    };
    for (const css of ["linear(0, 0.25 75%, 1)", "linear(0, 1.2 60%, 0.9 80%, 1)", "linear(0.1 20%, 0.6 40%, 0.8 70%)", "linear(0, 0.5 50%, 0.5 50%, 1)"]) {
      const tf = parseTimingFunction(css);
      if (!tf.ok || tf.value.kind !== "points") throw new Error(css);
      const pts = tf.value.points;
      const forward = timingCurve(tf.value)!;
      const reversed = timingCurve(tf.value, true)!;
      for (const x of xs) {
        if (pts.some(([px]) => px === x || px === 1 - x)) continue; // a jump's own input: either side is CSS's
        expect(evalCurve(forward, x)).toBeCloseTo(cssLinear(pts, x), 9);
        expect(evalCurve(reversed, x)).toBeCloseTo(1 - cssLinear(pts, 1 - x), 9);
      }
    }
    expect(timingCurve({ kind: "points", points: [[0, 0], [1, 1]] })).toBeNull(); // linear(0, 1) is linear
  });

  it("matches CSS's published reference points for ease", () => {
    const tf = parseTimingFunction("ease");
    const curve = timingCurve((tf as { value: UITimingFunction }).value)!;
    expect(evalCurve(curve, 0.5)).toBeCloseTo(0.8024033877, 6);
  });

  it.each(["jump-start", "jump-end", "jump-none", "jump-both"])("steps(4, %s) is CSS's step function; linear needs no curve", (position) => {
    const curve = timingCurve({ kind: "steps", steps: 4, position: position as "jump-end" })!;
    for (const x of xs.slice(0, -1)) expect(evalCurve(curve, x)).toBeCloseTo(cssSteps(4, position, x), 9);
    expect(evalCurve(curve, 1)).toBe(1);
    // Reversed: 1 − f(1 − x) between the steps, and exactly 0 where the backward segment starts.
    const reversed = timingCurve({ kind: "steps", steps: 4, position: position as "jump-end" }, true)!;
    expect(evalCurve(reversed, 0)).toBe(0);
    for (const x of [0.1, 0.3, 0.6, 0.9]) expect(evalCurve(reversed, x)).toBeCloseTo(1 - cssSteps(4, position, 1 - x), 9);
    expect(timingCurve({ kind: "linear" })).toBeNull();
  });
});

// --- Running, on both backends -----------------------------------------------------------------------

const BACKENDS = [
  ["the animation core's tween table (animation plugin on)", [] as string[]],
  ["the standalone tween module (animation plugin off)", ["animation"]],
] as const;

describe.each(BACKENDS)("UI animation on %s", (_name, disabled) => {
  let engine: Engine;

  beforeEach(async () => {
    applyTestPlugins([...disabled]);
    engine = await Engine.create({ headless: true });
    await loadUITestSupport();
  });

  afterEach(() => {
    engine.dispose();
    Assets.clearSources();
    applyTestPlugins();
    vi.restoreAllMocks();
  });

  const step = (frames = 1) => {
    for (let i = 0; i < frames; i++) engine.step(DT);
  };

  async function animatedUI(markup: string, css: string): Promise<TestUI> {
    await uiAnimationReady(World.require()); // the backend opens before the tree builds, so even its first frame tweens
    return buildUI(markup, { css });
  }

  describe("transitions", () => {
    it("ease a class change from the value shown to the new one, starting the frame of the change", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { opacity: 0; transition: opacity 1s linear } .a.on { opacity: 1 }`);
      const p = byId(doc, "p", UIPanel);
      step();
      expect(p.opacity).toBe(0);
      classList(doc.query("#p")!).add("on");
      step();
      expect(p.opacity).toBe(0);
      step(16);
      expect(p.opacity).toBe(0.25);
      step(48);
      expect(p.opacity).toBe(1);
    });

    it("ease through the timing function's curve, computed by the tween backend", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 1s ease } .a.on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel);
      classList(doc.query("#p")!).add("on");
      step(33); // the change's frame, then half a second
      expect(p.opacity).toBeCloseTo(1 - cssBezier(...EASE, 0.5), 5);
      // A value the backend wrote is an f32 (the tween table's floats); one eased here in JavaScript wouldn't be.
      expect(Math.fround(p.opacity)).toBe(p.opacity);
    });

    it("start from a built tree's settled styles when the sheets use structural selectors, but not for its own build", async () => {
      // ADR 0418 wave 5 restyles a built tree once its siblings exist (each element is styled as it's rendered, as the
      // last child so far): that restyle, in the frame's late sync, isn't a change and doesn't transition; a class a
      // script adds after it is one, and does.
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/><div id="q" class="a"/><div id="r" class="a"/></Canvas>`, `.a { opacity: 1; transition: opacity 1s linear } .a:last-child { opacity: 0.5 } .a.on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel), q = byId(doc, "q", UIPanel), r = byId(doc, "r", UIPanel);
      step();
      expect([p.opacity, q.opacity, r.opacity]).toEqual([1, 1, 0.5]);
      classList(doc.query("#q")!).add("on");
      step(33);
      expect([p.opacity, r.opacity]).toEqual([1, 0.5]);
      expect(q.opacity).toBeCloseTo(0.5, 5);
    });

    it("wait out their delay at the old value; a negative delay starts part-way", async () => {
      const doc = await animatedUI(`<Canvas><div id="a" class="x"/><div id="b" class="y"/></Canvas>`, `.x { transition: opacity 1s linear 0.25s } .y { transition: opacity 1s linear -0.5s } .on { opacity: 0 }`);
      const a = byId(doc, "a", UIPanel), b = byId(doc, "b", UIPanel);
      for (const id of ["#a", "#b"]) classList(doc.query(id)!).add("on");
      step();
      expect([a.opacity, b.opacity]).toEqual([1, 0.5]);
      step(16);
      expect([a.opacity, b.opacity]).toEqual([1, 0.25]);
      step(16);
      expect([a.opacity, b.opacity]).toEqual([0.75, 0]);
    });

    it("turn back from the value shown when the change is undone mid-way, over the share of the duration covered (ADR 0428)", async () => {
      // CSS's reversing shortening: half way through, the way back takes half the duration.
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 1s linear } .on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel);
      const el = doc.query("#p")!;
      classList(el).add("on");
      step(33);
      expect(p.opacity).toBe(0.5);
      classList(el).remove("on");
      step();
      expect(p.opacity).toBe(0.5);
      step(16);
      expect(p.opacity).toBe(0.75);
      step(16);
      expect(p.opacity).toBe(1);
    });

    it("stop when their property is no longer covered: at their end, or at the value the change wrote", async () => {
      const doc = await animatedUI(`<Canvas><div id="a" class="t"/><div id="b" class="t"/></Canvas>`, `.t { transition: opacity 1s linear } .on { opacity: 0 } .cut { transition: none } .cut.other { opacity: 0.3 }`);
      const a = byId(doc, "a", UIPanel), b = byId(doc, "b", UIPanel);
      for (const id of ["#a", "#b"]) classList(doc.query(id)!).add("on");
      step(33);
      expect([a.opacity, b.opacity]).toEqual([0.5, 0.5]);
      classList(doc.query("#a")!).add("cut");
      classList(doc.query("#b")!).add("cut", "other");
      step();
      expect([a.opacity, b.opacity]).toEqual([0, 0.3]);
    });

    it("give way to a script writing the field, as an inline style would", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 1s linear } .on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel);
      const ended = vi.fn();
      doc.query("#p")!.on("transitionend", ended);
      classList(doc.query("#p")!).add("on");
      step(17);
      p.opacity = 0.9;
      step(70);
      expect(p.opacity).toBe(0.9);
      expect(ended).not.toHaveBeenCalled();
    });

    it("animate colours in linear RGB, lengths px with px (a mixed pair jumps at the midpoint), transforms, shadows, sides and corners", async () => {
      const doc = await animatedUI(
        `<Canvas><div id="p" class="a"/><div id="m" class="m"/></Canvas>`,
        `.a { background-color: #000000; width: 100px; padding: 4px; transition: all 1s linear }
         .a.on { background-color: #ffffff; width: 200px; padding-top: 12px; transform: translate(10px, 6px) rotate(90deg) scale(2); box-shadow: 0 4px 8px #000; border-radius: 8px 8px 0 0 }
         .m { width: 100px; transition: width 1s linear } .m.on { width: 50% }`,
      );
      const p = byId(doc, "p", UIPanel), m = byId(doc, "m", UIPanel);
      classList(doc.query("#p")!).add("on");
      classList(doc.query("#m")!).add("on");
      step(17);
      expect(m.width).toBe("100");
      step(16);
      // Half way.
      expect(p.backgroundColor!.r).toBeCloseTo(0.7353569, 5); // linear 0.5, back to sRGB
      expect(p.backgroundColor!.a).toBe(1);
      expect(p.width).toBe("150");
      expect(p.paddingTop).toBe(8); // from the 4px all sides
      expect([p.translateX, p.translateY, p.rotate, p.scaleX, p.scaleY]).toEqual(["5", "3", 45, 1.5, 1.5]);
      expect([p.boxShadowOffsetY, p.boxShadowBlur, p.boxShadowColor?.a]).toEqual([2, 4, 0.5]); // from none: transparent black
      expect([p.borderTopLeftRadius, p.borderBottomLeftRadius]).toEqual([4, 0]); // from borderRadius (0) where unset
      expect(m.width).toBe("50%");
      step(32);
      expect(p.backgroundColor).toEqual(new Color(1, 1, 1, 1));
      expect([p.width, p.paddingTop, p.translateX, p.rotate, p.boxShadowOffsetY, p.borderTopLeftRadius]).toEqual(["200", 12, "10", 90, 4, 8]);
    });

    it("shorten again when reversed again, carrying the share covered (ADR 0428)", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 1s linear } .on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel);
      const el = doc.query("#p")!;
      classList(el).add("on");
      step(33);
      expect(p.opacity).toBe(0.5);
      classList(el).remove("on"); // back over 0.5 s
      step(17);
      expect(p.opacity).toBe(0.75);
      // Half way back: the factor is 0.5 × 0.5 + (1 − 0.5) = 0.75 of the duration, from 0.75 to 0.
      classList(el).add("on");
      step(25);
      expect(p.opacity).toBe(0.375);
      step(24);
      expect(p.opacity).toBe(0);
    });

    it("ease through linear() as engine curve keys (ADR 0428)", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 1s linear(0, 0.25 75%, 1) } .on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel);
      classList(doc.query("#p")!).add("on");
      step(33);
      expect(p.opacity).toBeCloseTo(1 - 0.5 / 0.75 * 0.25, 5);
      step(16);
      expect(p.opacity).toBeCloseTo(0.75, 5);
      step(16);
      expect(p.opacity).toBe(0);
    });

    it("transition discrete values only with allow-discrete: half way, and display keeps the value that isn't none (ADR 0428)", async () => {
      const doc = await animatedUI(
        `<Canvas><div id="d" class="d"/><div id="f" class="f"/><div id="n" class="n"/></Canvas>`,
        `.d { transition: display 1s allow-discrete } .d.on { display: none }
         .f { transition: flex-direction 1s linear allow-discrete } .f.on { flex-direction: column }
         .n { transition: flex-direction 1s linear } .n.on { flex-direction: column }`,
      );
      const d = byId(doc, "d", UIPanel), f = byId(doc, "f", UIPanel), n = byId(doc, "n", UIPanel);
      for (const id of ["#d", "#f", "#n"]) classList(doc.query(id)!).add("on");
      step();
      expect([d.display, f.flexDirection, n.flexDirection]).toEqual(["flex", "row", "column"]); // normal: at once
      step(31);
      expect([d.display, f.flexDirection]).toEqual(["flex", "row"]);
      step(2);
      expect([d.display, f.flexDirection]).toEqual(["flex", "column"]);
      step(30);
      expect(d.display).toBe("flex"); // drawn until its end
      step(2);
      expect(d.display).toBe("none");
      // Back: `none` to `flex` shows `flex` from the start.
      classList(doc.query("#d")!).remove("on");
      step();
      expect(d.display).toBe("flex");
    });

    it("pass a parent's transitioning inherited values to its children frame by frame (ADR 0428)", async () => {
      const doc = await animatedUI(
        `<Canvas><div id="box" class="box"><p id="t">a</p><p id="own" class="own">b</p><div><p id="deep">c</p></div></div><p id="lone" class="lone">d</p></Canvas>`,
        `.box { color: #000000; font-size: 10px; transition: color 1s linear, font-size 1s linear } .box.on { color: #ffffff; font-size: 20px }
         .own { color: #00ff00 }
         .lone { color: #000000; transition: color 1s linear } .lone.on { color: #ffffff }`,
      );
      const t = byId(doc, "t", UIText), own = byId(doc, "own", UIText), deep = byId(doc, "deep", UIText), lone = byId(doc, "lone", UIText);
      step();
      expect([t.color, deep.color, t.fontSize]).toEqual([new Color(0, 0, 0, 1), new Color(0, 0, 0, 1), 10]);
      classList(doc.query("#box")!).add("on");
      classList(doc.query("#lone")!).add("on");
      step();
      expect([t.color, deep.color, t.fontSize]).toEqual([new Color(0, 0, 0, 1), new Color(0, 0, 0, 1), 10]); // the change's frame shows the start
      step(32);
      // Half way, as the panel (which has no colour of its own) passes it on, and as a text element's own transition is.
      expect(t.color!.r).toBeCloseTo(0.7353569, 5);
      expect(deep.color).toEqual(t.color);
      expect(t.color).toEqual(lone.color);
      expect(t.fontSize).toBeCloseTo(15, 5);
      expect(own.color).toEqual(Color.from("#00ff00")); // its own value, not inherited
      step(32);
      expect([t.color, deep.color, t.fontSize]).toEqual([new Color(1, 1, 1, 1), new Color(1, 1, 1, 1), 20]);
    });

    it("run on unscaled time: UI still animates while the game is paused", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 1s linear } .on { opacity: 0 }`);
      const p = byId(doc, "p", UIPanel);
      Time.timeScale = 0;
      classList(doc.query("#p")!).add("on");
      step(33);
      expect(p.opacity).toBe(0.5);
      Time.timeScale = 1;
    });

    it("send transitionend the frame after they finish, through element.on", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `.a { transition: opacity 0.5s linear, width 0.25s } .on { opacity: 0; width: 10px }`);
      const events: UIHostEvent[] = [];
      doc.query("#p")!.on("transitionend", (e) => events.push(e));
      classList(doc.query("#p")!).add("on");
      step(17); // width ends on the last of these
      expect(events).toEqual([]);
      step();
      expect(events.map((e) => [e.type, e.propertyName, e.elapsedTime])).toEqual([["transitionend", "width", 0.25]]);
      step(16);
      expect(events.map((e) => e.propertyName)).toEqual(["width", "opacity"]);
    });
  });

  describe("keyframe animations", () => {
    it("start when an element appears, and follow iterations, direction and fill", async () => {
      const doc = await animatedUI(
        `<Canvas><div id="a" class="grow"/><div id="b" class="alt"/><div id="c" class="once"/></Canvas>`,
        `@keyframes grow { from { width: 0px } to { width: 100px } }
         .grow { animation: grow 1s linear infinite }
         .alt { animation: grow 1s linear 2 alternate forwards }
         .once { animation: grow 0.5s linear }`,
      );
      const a = byId(doc, "a", UIPanel), b = byId(doc, "b", UIPanel), c = byId(doc, "c", UIPanel);
      step();
      expect([a.width, b.width, c.width]).toEqual(["0", "0", "0"]);
      step(16);
      expect([a.width, b.width, c.width]).toEqual(["25", "25", "50"]);
      step(64); // 1.25 s
      expect([a.width, b.width, c.width]).toEqual(["25", "75", "auto"]); // c ended (fill none): its own width again
      step(48); // 2 s: b ended, holding its last value (the reversed iteration's end)
      expect([a.width, b.width]).toEqual(["0", "0"]);
      step(16);
      expect([a.width, b.width]).toEqual(["25", "0"]);
    });

    it("eases each segment through its keyframe's timing function, and fills missing ends with the element's value", async () => {
      const doc = await animatedUI(
        `<Canvas><div id="a" class="a"/><div id="b" class="b"/></Canvas>`,
        `@keyframes k { 0% { opacity: 0 } 50% { opacity: 1; animation-timing-function: linear } 100% { opacity: 0.5 } }
         @keyframes fade { from { opacity: 0 } }
         .a { animation: k 1s ease-in } .b { opacity: 0.8; animation: fade 1s linear }`,
      );
      const a = byId(doc, "a", UIPanel), b = byId(doc, "b", UIPanel);
      step(17);
      expect(a.opacity).toBeCloseTo(cssBezier(0.42, 0, 1, 1, 0.5), 5);
      expect(b.opacity).toBeCloseTo(0.2, 6);
      step(32);
      expect(a.opacity).toBe(0.75);
      expect(b.opacity).toBeCloseTo(0.6, 6);
    });

    it("pause and resume with animation-play-state, and stop when their name goes", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="grow" width="7px"/></Canvas>`, `@keyframes grow { from { width: 0px } to { width: 100px } } .grow { animation: grow 1s linear infinite } .grow.hold { animation-play-state: paused }`);
      const p = byId(doc, "p", UIPanel);
      const el = doc.query("#p")!;
      step(17);
      expect(p.width).toBe("25");
      classList(el).add("hold");
      step(20);
      expect(p.width).toBe("25");
      classList(el).remove("hold");
      step(16);
      expect(p.width).toBe("50");
      classList(el).remove("grow");
      step();
      expect(p.width).toBe("7");
    });

    it("start part-way with a negative delay, end part-way with a fractional count, and step with steps()", async () => {
      const doc = await animatedUI(
        `<Canvas><div id="a" class="a"/><div id="b" class="b"/><div id="c" class="c"/></Canvas>`,
        `@keyframes grow { from { width: 0px } to { width: 100px } }
         .a { animation: grow 1s linear -0.5s } .b { animation: grow 1s linear 1.5 forwards } .c { animation: grow 1s steps(4) infinite }`,
      );
      const a = byId(doc, "a", UIPanel), b = byId(doc, "b", UIPanel), c = byId(doc, "c", UIPanel);
      step();
      expect([a.width, c.width]).toEqual(["50", "0"]);
      step(19); // 0.296875 s
      expect(c.width).toBe("25");
      step(77); // 1.5 s
      expect(b.width).toBe("50");
      step(32);
      expect(b.width).toBe("50");
    });

    it("send animationstart, animationiteration and animationend the frame after, through element.on", async () => {
      const doc = await animatedUI(`<Canvas><div id="p" class="a"/></Canvas>`, `@keyframes k { to { opacity: 0 } } .a { animation: k 0.25s linear 0.125s 2 }`);
      const events: string[] = [];
      const el = doc.query("#p")!;
      for (const type of ["animationstart", "animationiteration", "animationend"] as const) el.on(type, (e) => events.push(`${e.type} ${e.animationName} ${e.elapsedTime}`));
      step(9); // the delay ends on the last of these
      expect(events).toEqual([]);
      step();
      expect(events).toEqual(["animationstart k 0"]);
      step(16);
      expect(events).toEqual(["animationstart k 0", "animationiteration k 0.25"]);
      step(16);
      expect(events).toEqual(["animationstart k 0", "animationiteration k 0.25", "animationend k 0.5"]);
    });
  });

  describe("on hosted elements (the UI host, as Svelte views use it)", () => {
    afterEach(() => setUIHostStyles("ui/view.css", null));

    it("transition on class changes and send transitionend through the element's listeners", async () => {
      await loadUIHostSupport();
      setUIHostStyles("ui/view.css", parseStylesheet(`div { opacity: 1; transition: opacity 0.5s linear } div.off { opacity: 0 } @keyframes in { from { translate: 0 -20px } } span { animation: in 0.5s linear }`, "ui/view.css"));
      await uiAnimationReady(World.require());
      const tree = new UIHostTree(World.require(), GameObject.create("View"), "ui/view.svelte");
      const div = tree.create("div", "Panel", null, null, new Map([["class", "box"]]));
      const span = tree.create("span", "Text", div, null, new Map());
      tree.restyle(div);
      const events: UIHostEvent[] = [];
      div.on("transitionend", (e) => events.push(e));
      step();
      expect(uiAs(span, UIText).translateY).toBe("-20");
      tree.setAttributes(div, new Map([["class", "box off"]]));
      step(17);
      expect(uiAs(div, UIPanel).opacity).toBe(0.5);
      expect(uiAs(span, UIText).translateY).toBe("-9.375");
      step(17);
      expect(uiAs(div, UIPanel).opacity).toBe(0);
      expect(uiAs(span, UIText).translateY).toBe("0");
      expect(events.map((e) => [e.type, e.propertyName, e.elapsedTime])).toEqual([["transitionend", "opacity", 0.5]]);
      tree.dispose();
    });
  });
});
