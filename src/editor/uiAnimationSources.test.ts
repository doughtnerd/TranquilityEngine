// ADR 0422 wave 4: the Inspector's value sources name a running transition or keyframe animation, over the source of
// the value it animates to (in a World that plays: nothing animates in a scene being edited). The UI animator says
// which field is animated by what (`uiAnimatedField`, which `uiViews.ts` reads for a view's element); the Inspector's
// wording of such an origin is `describeOrigin`'s.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine } from "../engine";
import { World } from "../engine/core/World";
import { uiAnimatedField, uiAnimationReady } from "../engine/ui/animation/UIAnimator";
import { buildUI, classList, loadUITestSupport } from "../engine/tests/uiMarkup";
import { describeOrigin, originBadge, type FieldOrigin } from "./uiFieldSources";

let engine: Engine;

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUITestSupport();
  await uiAnimationReady(World.require());
});

afterEach(() => {
  engine.dispose();
  Assets.clearSources();
});

describe("value sources of animated fields", () => {
  it("say a transition or an animation is animating the field, then the rule again once it ends", () => {
    const ui = buildUI(`<Canvas><div id="p" class="a"></div></Canvas>`, {
      css: `@keyframes spin { to { rotate: 360deg } } .a { transition: opacity 0.25s linear; animation: spin 1s linear infinite } .a.on { opacity: 0.5 }`,
    });
    const el = ui.query("#p")!;
    classList(el).add("on");
    engine.step(1 / 64);
    const by = (field: string) => uiAnimatedField(World.require(), el.component, field);
    expect(by("opacity")).toEqual({ kind: "transition", name: "opacity" });
    expect(by("rotate")).toEqual({ kind: "animation", name: "spin" });
    for (let i = 0; i < 20; i++) engine.step(1 / 64);
    expect(by("opacity")).toBeNull();
    expect(by("rotate")).toEqual({ kind: "animation", name: "spin" }); // infinite
  });

  it("word an animated origin over the source of the value it animates to", () => {
    const rule: FieldOrigin = { kind: "rule", file: "ui/Hud.svelte", selector: ".a.on", property: "opacity", value: "0.5", span: { start: 0, end: 0 }, line: 3 };
    const transition: FieldOrigin = { kind: "animated", via: "transition", name: "opacity", origin: rule };
    expect(describeOrigin(transition)).toMatch(/^Transition of opacity, over \.a\.on \{ opacity: 0\.5 \}/);
    expect(originBadge(transition)).toBe("Transition");
    const animation: FieldOrigin = { kind: "animated", via: "animation", name: "spin", origin: { kind: "default" } };
    expect(describeOrigin(animation)).toBe('Animation "spin" (@keyframes), over Default');
    expect(originBadge(animation)).toBe("Animation");
  });
});
