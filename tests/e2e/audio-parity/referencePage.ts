// The Chromium side of the parity harness: bundles `browserRender.ts` (the reference graph and the scene driver) and
// renders scenes in a page with it. Node-only (Playwright spec).
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Page } from "@playwright/test";
import { typescriptTranspile } from "../../../vite.shared";
import type { ReferencePayload, ReferenceResult } from "./browserRender";
import { makeClip, prerollFrames, sceneBuses, sceneFrames, type Scene } from "./scenes";

let bundle: Promise<string> | null = null;

/** `browserRender.ts` and the reference graph as one script (no output files). */
export function bundleBrowserRender(): Promise<string> {
  return (bundle ??= (async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [typescriptTranspile()],
      oxc: false,
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL("./browserRender.ts", import.meta.url)), formats: ["iife"], name: "MycoParityBundle", fileName: "browserRender" },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((r) => ("output" in r ? r.output : [])) : "output" in result ? result.output : [];
    const chunk = outputs.find((o) => o.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("the browser render bundle produced no chunk");
    return chunk.code;
  })());
}

/** Loads the bundle into a blank page; call once per page. */
export async function loadReferencePage(page: Page): Promise<void> {
  await page.goto("about:blank");
  await page.addScriptTag({ content: await bundleBrowserRender() });
}

const b64 = (a: Float32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

/** One scene through the reference graph in the page: the rendered channels (pre-roll trimmed) and the browser's user agent. */
export async function renderReference(page: Page, scene: Scene): Promise<{ left: Float32Array; right: Float32Array; userAgent: string }> {
  const payload: ReferencePayload = {
    rate: scene.rate,
    prerollFrames: prerollFrames(scene),
    frames: sceneFrames(scene),
    skipFrames: scene.referenceLatency ?? 0,
    clips: scene.clips.map((c) => makeClip(c, scene.rate).map(b64)),
    buses: sceneBuses(scene),
    voices: scene.voices.map((v) => ({
      clip: v.clip,
      bus: v.bus,
      gain: v.gain ?? 1,
      spatial: v.spatial ? { dir: [...v.spatial.dir], panner: v.spatial.panner ?? "equalpower" } : null,
    })),
  };
  const result = await page.evaluate((p) => (globalThis as unknown as { MycoParity: { render(p: unknown): Promise<unknown> } }).MycoParity.render(p), payload);
  const { left, right, userAgent } = result as ReferenceResult;
  const f32 = (s: string): Float32Array => {
    const buf = Buffer.from(s, "base64");
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  };
  return { left: f32(left), right: f32(right), userAgent };
}
