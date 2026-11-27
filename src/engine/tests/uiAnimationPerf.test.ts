// ADR 0422 wave 4, performance sanity: 500 elements transitioning two properties each (a colour and a number), frame
// cost against the same document with no transitions, on both tween backends. Medians over several class changes,
// since a single frame's time is mostly the garbage collector's mood. Logs the numbers (the build log quotes them);
// the bound is loose, a tripwire against an accidental per-frame blow-up, not a budget.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine } from "../index";
import { World } from "../core/World";
import { applyTestPlugins } from "../../plugins/testPlugins";
import { uiAnimationReady } from "../ui/animation/UIAnimator";
import { UIPanel } from "../ui/components";
import { buildUI, classList, loadUITestSupport, uiAs } from "./uiMarkup";

const DT = 1 / 64;
const N = 500;
const ROUNDS = 8;
/** Frames per round: the 0.5 s transitions take 32. */
const FRAMES = 40;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe.each([
  ["the animation core's table", [] as string[], true],
  ["the standalone module", ["animation"], true],
  ["no transitions (baseline)", [] as string[], false],
])("500 transitioning elements: %s", (name, disabled, animated) => {
  let engine: Engine;

  beforeEach(async () => {
    applyTestPlugins(disabled);
    engine = await Engine.create({ headless: true });
    await loadUITestSupport();
  });

  afterEach(() => {
    engine.dispose();
    Assets.clearSources();
    applyTestPlugins();
  });

  it("costs little per frame", async () => {
    await uiAnimationReady(World.require());
    const panels = Array.from({ length: N }, (_, i) => `<div id="p${i}" class="p" position="absolute" width="10px" height="10px"/>`).join("");
    const transition = animated ? "transition: opacity 0.5s linear, background-color 0.5s ease" : "";
    const doc = buildUI(`<Canvas>${panels}</Canvas>`, { css: `.p { opacity: 1; background-color: #102030; ${transition} } .p.on { opacity: 0.2; background-color: #f0e0d0 }` });
    const els = doc.queryAll(".p");
    const p = uiAs(els[0], UIPanel);
    const changes: number[] = [];
    const moving: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (const el of els) classList(el).toggle("on");
      let t0 = performance.now();
      engine.step(DT); // 500 restyles, 1,000 transitions starting
      changes.push(performance.now() - t0);
      for (let f = 1; f < FRAMES; f++) {
        t0 = performance.now();
        engine.step(DT);
        if (f < 30) moving.push(performance.now() - t0);
        if (animated && f === 16) expect(p.opacity).not.toBe(round % 2 === 0 ? 0.2 : 1); // still on its way
      }
    }
    console.info(`[perf] UI animation, ${name}, ${N} elements x 2 transitions: class change frame ${median(changes).toFixed(2)} ms, each frame while transitioning ${median(moving).toFixed(3)} ms (medians)`);
    expect(median(moving)).toBeLessThan(25);
  });
});
