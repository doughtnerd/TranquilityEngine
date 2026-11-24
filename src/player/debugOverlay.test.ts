// The pairing overlay (ADR 0403 "Pairing code"), through its module's interface, with a minimal stand-in page (the unit
// tests run without a DOM): shown while no tool is connected, hidden once one pairs, shown again when the last leaves,
// F8 toggling, and the code updating. The player's release safety is checked below with the build's lazy-only rule.
import { describe, expect, it } from "vitest";
import type { Rollup } from "vite";
import { DEBUG_LINK, lazyOnly } from "../../vite.shared";
import { installDebugOverlay, type OverlayElement, type OverlayHost } from "./debugOverlay";

type KeyHandler = (e: { key: string; preventDefault(): void }) => void;

function fakePage() {
  const boxes: (OverlayElement & { removed: boolean })[] = [];
  const handlers = new Set<KeyHandler>();
  const host: OverlayHost = {
    document: {
      createElement: () => {
        const el = { hidden: false, textContent: null as string | null, style: { cssText: "" }, removed: false, remove() { el.removed = true; } };
        boxes.push(el);
        return el;
      },
      body: { append: () => undefined },
    },
    addEventListener: (_t, h) => void handlers.add(h),
    removeEventListener: (_t, h) => void handlers.delete(h),
  };
  const press = (key: string) => handlers.forEach((h) => h({ key, preventDefault: () => undefined }));
  return { host, boxes, handlers, press };
}

function setup(code: string | null = "3F9QK-7KD2X") {
  const page = fakePage();
  const source = { code: code as string | null, address: "ws://127.0.0.1:7790/myco-debug", tools: [] as unknown[] };
  const overlay = installDebugOverlay(source, { host: page.host, schedule: () => () => undefined });
  return { page, source, overlay, box: page.boxes[0]! };
}

describe("the pairing overlay", () => {
  it("shows the code while no tool is connected", () => {
    const { box, overlay } = setup();
    expect(overlay.visible).toBe(true);
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain("3F9QK-7KD2X");
  });

  it("asks for the address when there is no code", () => {
    const { box } = setup(null);
    expect(box.textContent).toContain("type the address: ws://127.0.0.1:7790/myco-debug");
  });

  it("shows a page's notice under its room code, or in its place while there is no code", () => {
    const { box, source, overlay } = setup("RA1B2-C3D4E");
    const withNotice = source as typeof source & { notice: string | null };
    withNotice.notice = "Open this page by its network address (not localhost) to pair from another machine.";
    overlay.update();
    expect(box.textContent).toBe("Debug pairing code: RA1B2-C3D4E\nOpen this page by its network address (not localhost) to pair from another machine.\n(F8 hides this)");
    source.code = null;
    withNotice.notice = "Opening a pairing room…";
    overlay.update();
    expect(box.textContent).toBe("Debug link: Opening a pairing room…\n(F8 hides this)");
    expect(box.textContent).not.toContain("type the address");
  });

  it("hides once a tool pairs and shows again when the last one leaves", () => {
    const { box, source, overlay } = setup();
    source.tools = [{}, {}];
    overlay.update();
    expect(box.hidden).toBe(true);
    source.tools = [{}];
    overlay.update();
    expect(box.hidden).toBe(true);
    source.tools = [];
    overlay.update();
    expect(box.hidden).toBe(false);
  });

  it("toggles with F8 at any time, and a connection change resets the choice", () => {
    const { page, box, source, overlay } = setup();
    page.press("F7");
    expect(box.hidden).toBe(false);
    page.press("F8");
    expect(box.hidden).toBe(true);
    page.press("F8");
    expect(box.hidden).toBe(false);
    source.tools = [{}];
    overlay.update();
    expect(box.hidden).toBe(true);
    page.press("F8"); // connected: F8 shows the code again
    expect(box.hidden).toBe(false);
    overlay.update(); // still connected: the choice stays
    expect(box.hidden).toBe(false);
    page.press("F8");
    source.tools = [];
    overlay.update(); // the last tool left: shown again whatever F8 chose
    expect(box.hidden).toBe(false);
  });

  it("shows the next code the gate issues", () => {
    const { box, source, overlay } = setup();
    source.code = "AAAAA-BBBBB";
    overlay.update();
    expect(box.textContent).toContain("AAAAA-BBBBB");
    expect(box.textContent).not.toContain("3F9QK");
  });

  it("is driven by its scheduler, and dispose removes the box and the key listener", () => {
    const page = fakePage();
    const source = { code: "A", address: "x", tools: [] as unknown[] };
    let tick = () => undefined as void;
    let stopped = false;
    const overlay = installDebugOverlay(source, { host: page.host, schedule: (u) => { tick = u; return () => void (stopped = true); } });
    source.code = "B";
    tick();
    expect(page.boxes[0]!.textContent).toContain("B");
    overlay.dispose();
    expect(stopped).toBe(true);
    expect(page.boxes[0]!.removed).toBe(true);
    expect(page.handlers.size).toBe(0);
  });
});

describe("the overlay in a release export", () => {
  type Chunk = { fileName: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; moduleIds: string[] };
  const bundleOf = (chunks: Chunk[]): Rollup.OutputBundle =>
    Object.fromEntries(chunks.map((c) => [c.fileName, { type: "chunk", isEntry: false, imports: [], dynamicImports: [], ...c } as unknown as Rollup.OutputChunk]));
  const check = (bundle: Rollup.OutputBundle): string | null => {
    const hook = lazyOnly([DEBUG_LINK]).generateBundle as (this: unknown, options: unknown, bundle: Rollup.OutputBundle, isWrite: boolean) => void;
    try {
      hook.call({ error: (m: string) => { throw new Error(m); } }, {}, bundle, true);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };
  const ROOT = "/repo/src";

  it("passes when the player reaches the overlay only by import()", () => {
    const bundle = bundleOf([
      { fileName: "player.js", isEntry: true, dynamicImports: ["overlay.js"], moduleIds: [`${ROOT}/player/main.ts`] },
      { fileName: "overlay.js", moduleIds: [`${ROOT}/player/debugOverlay.ts`] },
    ]);
    expect(check(bundle)).toBeNull();
  });

  it("fails when the player's static imports reach the overlay", () => {
    const bundle = bundleOf([
      { fileName: "player.js", isEntry: true, imports: ["overlay.js"], moduleIds: [`${ROOT}/player/main.ts`] },
      { fileName: "overlay.js", moduleIds: [`${ROOT}/player/debugOverlay.ts`] },
    ]);
    expect(check(bundle)).toContain("player/debugOverlay.ts");
  });
});
