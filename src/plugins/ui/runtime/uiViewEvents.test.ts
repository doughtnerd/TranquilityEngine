import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { UIButton, UIText } from "../../../engine/ui/components";
import { UIPointer, stubDocument } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import * as EventsModule from "./testComponents/Events.svelte";
import * as InertModule from "./testComponents/Inert.svelte";

// ADR 0422 and 0423 in Svelte views: events travel through the renderer's nodes in capture, target and bubble phases
// and out of the view to <svelte:window>; nodes scroll with the DOM's members. Driven through a UI core routing
// `Input`'s DOM adapter (`UIPointer`), as a player drives them.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "ui/events.svelte": EventsModule, "ui/inert.svelte": InertModule }) });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Node = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollIntoView(o?: unknown): void;
  scrollBy(x: number, y: number): void;
  addEventListener(type: string, fn: (e: { type: string; eventPhase: number; defaultPrevented: boolean; preventDefault(): void }) => void, o?: unknown): void;
  dispatchEvent(e: unknown): boolean;
};

async function view(): Promise<{ v: UIView; log: string[]; nodes: Record<string, Node> }> {
  const log: string[] = [];
  const nodes: Record<string, Node> = {};
  const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/events.svelte", props: { log: (s: string) => log.push(s), onnode: (k: string, n: Node) => (nodes[k] = n) } });
  await v.ready;
  pointer = await UIPointer.create(World.require());
  return { v, log, nodes };
}

describe("UIView: inert (HTML's)", () => {
  async function inertView(): Promise<{ v: UIView; log: string[] }> {
    const log: string[] = [];
    const v = GameObject.create("UI").addBehavior(UIView, { component: "asset:ui/inert.svelte", props: { log: (s: string) => log.push(s) } });
    await v.ready;
    pointer = await UIPointer.create(World.require());
    engine.step(DT);
    return { v, log };
  }

  it("takes an inert element's subtree out of the pointer and focus, and gives them back when it stops being inert", async () => {
    const { v, log } = await inertView();
    const inner = v.query("#inner")!.as(UIButton);
    expect(() => pointer!.click(inner)).toThrow(/would hit nothing/); // the pointer passes through it (nothing behind)
    engine.step(DT);
    expect(log).toEqual([]);
    v.query("#inner")!.focus();
    expect(inner.focused).toBe(false);
    pointer!.click(v.query("#outer")!.as(UIButton));
    engine.step(DT);
    expect(log).toEqual(["outer"]);

    log.length = 0;
    v.props.inert = false;
    engine.step(DT);
    pointer!.click(inner);
    engine.step(DT);
    expect(log).toEqual(["inner"]);
    v.query("#inner")!.focus();
    expect(inner.focused).toBe(true);
  });

  it("takes focus away from an element inside one that becomes inert", async () => {
    const { v } = await inertView();
    v.props.inert = false;
    engine.step(DT);
    const inner = v.query("#inner")!.as(UIButton);
    v.query("#inner")!.focus();
    engine.step(DT);
    expect(inner.focused).toBe(true);
    v.props.inert = true;
    engine.step(DT);
    engine.step(DT);
    expect(inner.focused).toBe(false);
  });
});

describe("UIView: events propagate (ADR 0422)", () => {
  it("runs onclickcapture on the way down, the target's onclick, onclick on the way up, then <svelte:window>", async () => {
    const { v, log } = await view();
    pointer!.click(v.query("#a")!.as(UIButton));
    engine.step(DT);
    expect(log).toEqual(["down a", "capture a at list 1", "a", "bubble a at list 3", "window click a"]);
    // The handler's state change shows the same frame.
    expect(v.query("#picked")!.as(UIText).text).toBe("a");
  });

  it("stops at stopPropagation: neither the list's bubble handler nor the window hears it", async () => {
    const { v, log } = await view();
    pointer!.click(v.query("#b")!.as(UIButton));
    engine.step(DT);
    expect(log).toEqual(["down b", "capture b at list 1", "b"]);
  });

  it("sends keydown to the focused node, bubbling to its list and on to the window once", async () => {
    stubDocument();
    const { v, log } = await view();
    v.query("#a")!.focus();
    pointer!.dom.tap("x");
    engine.step(DT);
    expect(log).toEqual(["keydown x on a", "window keydown x"]);
  });

  it("propagates dispatchEvent through the nodes with capture, passive and once listeners", async () => {
    const { nodes } = await view();
    const seen: string[] = [];
    const scroller = nodes.scroller;
    scroller.addEventListener("ping", (e) => seen.push(`capture ${e.eventPhase}`), { capture: true });
    scroller.addEventListener("ping", (e) => (e.preventDefault(), seen.push(`passive ${e.defaultPrevented}`)), { passive: true });
    scroller.addEventListener("ping", () => seen.push("once"), { once: true });
    const event = () => ({ type: "ping", bubbles: true, defaultPrevented: false, preventDefault() {
      this.defaultPrevented = true;
    } });
    nodes.r3.dispatchEvent(event());
    nodes.r3.dispatchEvent(event());
    expect(seen).toEqual(["capture 1", "passive false", "once", "capture 1", "passive false"]);
  });
});

describe("UIView: nodes scroll (ADR 0423)", () => {
  it("offers scrollTop, scrollHeight, clientHeight, scrollBy and scrollIntoView, and onscroll the frame after", async () => {
    const { nodes, log } = await view();
    const scroller = nodes.scroller;
    expect([scroller.scrollHeight, scroller.clientHeight]).toEqual([400, 100]);
    scroller.scrollTop = 100;
    expect(scroller.scrollTop).toBe(100);
    scroller.scrollBy(0, 50);
    expect(scroller.scrollTop).toBe(150);
    nodes.r9.scrollIntoView({ block: "end" });
    expect(scroller.scrollTop).toBe(300);
    pointer!.sync();
    engine.step(DT);
    expect(log).toEqual(["scroll"]);
  });

  it("scrolls by the wheel over the list", async () => {
    const { v, nodes } = await view();
    pointer!.wheel(v.query("#r1")!.as(UIButton), 0, 70);
    engine.step(DT);
    expect(nodes.scroller.scrollTop).toBe(70);
  });
});
