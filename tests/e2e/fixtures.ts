// The e2e specs' `test` and `expect`: Playwright's, with every page's animation frames capped.
//
// Every spec renders continuously (the editor's viewport, previews, thumbnails), and with software
// GL (SwiftShader: CI, and cloud containers without a GPU) every frame is CPU work in the GPU
// process: a frame of the 3D Playground costs about 160 ms of CPU whatever the canvas size
// (shadow cascades, probes), so four pages at full rate starve a four-core machine, clicks and
// locators wait seconds, and specs time out. No spec needs 60 frames a second, only that frames
// keep coming, so an init script caps render loops: at E2E_FPS frames a second (default 10 with
// software GL; 0, the default on the GPU, leaves them alone) in Play mode and outside the editor,
// and at E2E_EDIT_FPS (default 5) while the editor edits, where nothing runs on game time. Play
// keeps 10 because a World clamps each frame's step (`maxFrameTime`, 0.1 s by default): at fewer
// frames a second the game would run slower than the clock.
//
// Only loops are capped: a callback that has run before and is requested again (the engine's loop,
// previews, thumbnail renders: each re-requests the same function) waits for the next capped tick,
// while a new one (a one-off "after the next frame", such as Preact running effects after paint)
// runs on the next real frame, so start-up and UI updates aren't slowed. Each callback still gets
// the real time, so the World's clock and fixed steps follow wall time as before.
import { expect, test as base, type Page } from "@playwright/test";
import { gpuAngle } from "./gpu";

export { expect, type Locator, type Page } from "@playwright/test";

/** Frames a second each page may draw in Play mode and outside the editor; 0 doesn't cap them. */
const fps = Number(process.env.E2E_FPS ?? (gpuAngle ? 0 : 10));
/** Frames a second while the editor edits (no play session). */
const editFps = Number(process.env.E2E_EDIT_FPS ?? Math.min(fps, 5));

/** A spec's own cap, `at least` frames a second, unless frames aren't capped at all. */
export const fpsAtLeast = (atLeast: number): number => (fps === 0 ? 0 : Math.max(fps, atLeast));

/** Runs in each page before its scripts (serialized: self-contained). */
function capFrames({ play, edit }: { play: number; edit: number }): void {
  const realRequest = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const editor = location.pathname.endsWith("/editor.html");
  /** The editor's play session (its debug hook) is null while it edits. */
  const interval = () => 1000 / (editor && !(window as unknown as { playEngine?: unknown }).playEngine ? edit : play);
  /** Callbacks that have run: requested again, they're a loop. */
  const ran = new WeakSet<FrameRequestCallback>();
  let capped = new Map<number, FrameRequestCallback>();
  const real = new Map<number, number>();
  let nextId = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const run = (cb: FrameRequestCallback, now: number) => {
    ran.add(cb);
    try {
      cb(now);
    } catch (err) {
      setTimeout(() => {
        throw err; // reported as uncaught, as from a real frame
      });
    }
  };
  const tick = () => {
    timer = null;
    last = performance.now();
    const due = capped;
    capped = new Map();
    for (const cb of due.values()) run(cb, last);
  };
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    if (!ran.has(cb)) {
      real.set(id, realRequest((now) => (real.delete(id), run(cb, now))));
    } else {
      capped.set(id, cb);
      timer ??= setTimeout(tick, Math.max(0, last + interval() - performance.now()));
    }
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    capped.delete(id);
    const r = real.get(id);
    if (r !== undefined) (realCancel(r), real.delete(id));
  };
}

export const test = base.extend<{ fps: number; editFps: number; codePreload: boolean }, { webgpu: boolean }>({
  /** The frame cap in Play mode and outside the editor (`test.use({ fps })` raises it where timing is measured in frames). */
  fps: [fps, { option: true }],
  /** The frame cap while the editor edits. */
  editFps: [editFps, { option: true }],
  /**
   * Whether an open project warms up the Code panel in the background (Monaco and, with scripts,
   * its TypeScript worker): seconds of CPU per page, so off unless a spec tests it; opening a file
   * or pressing Play loads it when needed. Set on `window.mycoE2E` (src/editor/code/codeState.ts).
   */
  codePreload: [false, { option: true }],
  context: async ({ context, fps, editFps, codePreload }, use) => {
    if (fps > 0) await context.addInitScript(capFrames, { play: fps, edit: editFps || fps });
    if (!codePreload) await context.addInitScript(() => Object.assign(window, { mycoE2E: { codePreload: false } }));
    await use(context);
  },
  /**
   * Whether this browser gets a WebGPU adapter, asked once per worker on a stub page (a secure
   * context, which about:blank isn't), so specs that need WebGPU skip before booting the editor.
   */
  webgpu: [
    async ({ browser }, use) => {
      const page = await browser.newPage();
      await page.route("http://localhost/webgpu-check", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>WebGPU</title>" }));
      await page.goto("http://localhost/webgpu-check");
      const adapter = await page.evaluate(async () => !!(await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter().catch(() => null)));
      await page.close();
      await use(adapter);
    },
    { scope: "worker" },
  ],
});

/** Skip the current test unless the browser has WebGPU: shader graphs compile to WGSL alone (ADR 0081), so on the WebGL2 fallback they draw plain PBR. */
export function requireWebGPU(webgpu: boolean): void {
  test.skip(!webgpu, "shader graphs need WebGPU; the WebGL2 fallback draws plain PBR (ADR 0081)");
}

/** How long Play may take to start: it type-checks the project's scripts first (ADR 0125), in a TypeScript worker that starts cold in each page. */
export const PLAY_START = 20_000;

/** Press Play and wait until the game runs (the Stop button shows). */
export async function play(page: Page): Promise<void> {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: PLAY_START });
}

type FrameHooks = { engine?: { world: { time: { frameCount: number } } } };

/** Wait until the editor's World has stepped `n` more frames: a camera move or an edit made from a test shows (and picks) from the next frame on. */
export async function afterFrames(page: Page, n = 2): Promise<void> {
  const start = await page.evaluate(() => (window as unknown as FrameHooks).engine?.world.time.frameCount ?? 0);
  await page.waitForFunction((until) => ((window as unknown as FrameHooks).engine?.world.time.frameCount ?? 0) >= until, start + n);
}

type TestProjectHooks = FrameHooks & { openTestProject?(extra: Record<string, string>): Promise<void> };

/**
 * Open the Flappy sample as a writable project folder in memory, plus `extra` files (project path →
 * text), through the editor's `openTestProject` hook; the folder is on `window.testFolder`. It
 * opens from the start screen: opening the read-only sample first and then the folder would set up
 * a project, and its renderer, twice (each costs seconds of CPU with software GL).
 */
export async function openTestProject(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.goto("/editor.html");
  await page.waitForFunction(() => typeof (window as unknown as TestProjectHooks).openTestProject === "function");
  await page.evaluate((files) => (window as unknown as TestProjectHooks).openTestProject!(files), extra);
  await page.waitForFunction(() => ((window as unknown as TestProjectHooks).engine?.world.time.frameCount ?? 0) > 10);
}
