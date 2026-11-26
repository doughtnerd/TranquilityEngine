// ADR 0418 wave 4: the Inspector's value sources name a running transition or keyframe animation, over the source of
// the value it animates to (in a World that plays: nothing animates in a scene being edited).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine } from "../engine";
import { World } from "../engine/core/World";
import { loadUIDocumentSupport } from "../engine/ui/UIDocument";
import { uiAnimationReady } from "../engine/ui/animation/UIAnimator";
import { buildUI } from "../engine/tests/uiMarkup";
import { describeOrigin, fieldSources } from "./uiDocuments";

let engine: Engine;

beforeEach(async () => {
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
  await uiAnimationReady(World.require());
});

afterEach(() => {
  engine.dispose();
  Assets.clearSources();
});

describe("value sources of animated fields", () => {
  it("say a transition or an animation is animating the field, then the rule again once it ends", async () => {
    const doc = buildUI(`<Canvas><Panel id="p" class="a"/></Canvas>`, {
      css: `@keyframes spin { to { rotate: 360deg } } .a { transition: opacity 0.25s linear; animation: spin 1s linear infinite } .a.on { opacity: 0.5 }`,
    });
    await doc.ready;
    const el = doc.query("#p")!;
    el.classList.add("on");
    engine.step(1 / 64);
    const origin = (field: string) => fieldSources(el).find((r) => r.field === field)!.origin;
    expect(origin("opacity")).toMatchObject({ kind: "animated", via: "transition", name: "opacity", origin: { kind: "rule", selector: ".a.on" } });
    expect(describeOrigin(origin("opacity"))).toMatch(/^Transition of opacity, over \.a\.on \{ opacity: 0\.5 \}/);
    expect(origin("rotate")).toMatchObject({ kind: "animated", via: "animation", name: "spin", origin: { kind: "default" } });
    for (let i = 0; i < 20; i++) engine.step(1 / 64);
    expect(origin("opacity")).toMatchObject({ kind: "rule", selector: ".a.on" });
  });
});
