// ADR 0470: UI animation holds the backend's curve assets through one curve cache — a curve is loaded while a tween eases
// through it and released when the last such tween ends, and a load that failed is tried again rather than remembered.
// The backend is the standalone one, installed through the engine's provider point with its curve calls observed (and
// its first load refused, as a full curve table would).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine } from "../index";
import { World } from "../core/World";
import type { Curve } from "../core/curve";
import { applyTestPlugins } from "../../plugins/testPlugins";
import { UIPanel } from "../ui/components";
import { uiAnimationReady } from "../ui/animation/UIAnimator";
import { TWEEN_BACKEND_PROVIDER, type TweenBackend } from "../tween/backend";
import { openStandaloneTweenBackend } from "../tween/standalone";
import { buildUI, byId, classList, loadUITestSupport } from "./uiMarkup";

const DT = 1 / 64;

describe("UI animation's curve assets (ADR 0470)", () => {
  let engine: Engine;
  let unregister: () => void;
  const calls = { loads: 0, refused: 0, releases: 0, live: new Set<number>() };

  beforeEach(async () => {
    calls.loads = calls.refused = calls.releases = 0;
    calls.live.clear();
    unregister = TWEEN_BACKEND_PROVIDER.register(async () => {
      const inner = await openStandaloneTweenBackend();
      if (!inner) throw new Error("this Node runs simd128: the standalone backend opens");
      return new Proxy(inner, {
        get(target, key) {
          if (key === "loadCurve")
            return (curve: Curve) => {
              if (calls.loads++ === 0) {
                calls.refused++;
                return 0;
              }
              const h = target.loadCurve(curve);
              if (h) calls.live.add(h);
              return h;
            };
          if (key === "releaseCurve")
            return (h: number) => {
              calls.releases++;
              calls.live.delete(h);
              return target.releaseCurve(h);
            };
          const v = Reflect.get(target, key) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as TweenBackend;
    });
    applyTestPlugins(["animation"]);
    engine = await Engine.create({ headless: true });
    await loadUITestSupport();
  });

  afterEach(() => {
    engine.dispose();
    Assets.clearSources();
    applyTestPlugins();
    unregister();
  });

  const step = (frames = 1) => {
    for (let i = 0; i < frames; i++) engine.step(DT);
  };

  it("tries a refused curve again on the next tween, and releases it when its tween ends", async () => {
    await uiAnimationReady(World.require());
    const doc = buildUI(`<Canvas><div id="p" class="a"/></Canvas>`, { css: `.a { opacity: 0; transition: opacity 1s ease-in } .a.on { opacity: 1 }` });
    const p = byId(doc, "p", UIPanel);
    step();
    const el = doc.query("#p")!;

    // The first load is refused: that transition eases linearly.
    classList(el).add("on");
    step(33);
    expect(calls.refused).toBe(1);
    expect(p.opacity).toBe(0.5);
    step(40);
    expect(p.opacity).toBe(1);

    // The next transition through the same curve loads it again, and eases through it (ease-in is below linear half way).
    classList(el).remove("on");
    step(33);
    expect(calls.loads).toBe(2);
    expect(calls.live.size).toBe(1);
    expect(p.opacity).toBeGreaterThan(0.5);

    // Its tween ended: the curve is released (not held until the tree goes).
    step(40);
    expect(p.opacity).toBe(0);
    expect(calls.releases).toBe(1);
    expect(calls.live.size).toBe(0);
  });
});
