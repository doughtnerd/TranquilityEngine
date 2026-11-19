// ADR 0244: every Babylon engine is made by one factory, which falls back to WebGL2 when WebGPU is
// advertised but can't start. Node has neither GPU API, so the browser's are stood in for where the
// factory meets them: `navigator.gpu` (what WebGPU availability and start-up ask) and the canvas's
// `getContext` (what the WebGL2 engine asks). The canvas gives no WebGL context, so the WebGL2 engine
// can't finish starting here: the factory's rejection is Babylon's "WebGL not supported", after it asked
// the canvas for a WebGL2 context with the options it chose. Drawing on either backend is e2e's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../render/babylon/createEngine";

/** A canvas that records the contexts asked of it and gives none. */
function fakeCanvas() {
  const asked: { kind: string; options: Record<string, unknown> | undefined }[] = [];
  const canvas = {
    width: 300,
    height: 150,
    clientWidth: 300,
    clientHeight: 150,
    style: {},
    getContext: (kind: string, options?: Record<string, unknown>) => (asked.push({ kind, options }), null),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150 }),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, asked };
}

/** `navigator.gpu` with an adapter whose device can't be made (a blocklisted or lost GPU). */
function gpuThatFailsToStart() {
  const device = vi.fn(async () => {
    throw new Error("device creation failed");
  });
  const adapter = { features: new Set<string>(), limits: {}, info: {}, requestDevice: device };
  return { gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" }, device };
}

describe("the engine factory (ADR 0244)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to WebGL2 when WebGPU is advertised but can't start, warning once", async () => {
    const { gpu, device } = gpuThatFailsToStart();
    vi.stubGlobal("navigator", { ...globalThis.navigator, gpu });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { canvas, asked } = fakeCanvas();
    await expect(createEngine(canvas)).rejects.toThrow("WebGL not supported");
    expect(device).toHaveBeenCalledTimes(1); // WebGPU was tried
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("WebGPU couldn't start"))).toHaveLength(1);
    expect(asked.map((a) => a.kind)).toContain("webgl2"); // then WebGL2
    expect(asked.find((a) => a.kind === "webgl2")!.options).toMatchObject({ antialias: true });
  });

  it("asks WebGL2 for a transparent, readable canvas for previews", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, gpu: gpuThatFailsToStart().gpu });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { canvas, asked } = fakeCanvas();
    await expect(createEngine(canvas, { antialias: false, transparent: true })).rejects.toThrow("WebGL not supported");
    expect(asked.find((a) => a.kind === "webgl2")!.options).toMatchObject({ antialias: false, alpha: true, preserveDrawingBuffer: true });
  });

  it("goes straight to WebGL2 where there's no WebGPU, without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { canvas, asked } = fakeCanvas();
    await expect(createEngine(canvas)).rejects.toThrow("WebGL not supported");
    expect(asked[0]?.kind).toBe("webgl2");
    expect(asked.find((a) => a.kind === "webgl2")!.options).toMatchObject({ antialias: true, preserveDrawingBuffer: false }); // a game's canvas isn't read back
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("WebGPU"))).toHaveLength(0);
  });
});
