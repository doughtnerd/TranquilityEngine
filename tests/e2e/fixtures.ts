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
   * or pressing Play loads it when needed. Off is the user's setting (Settings > General > Code), stored before the
   * editor loads unless the page has already chosen one.
   */
  codePreload: [false, { option: true }],
  context: async ({ context, fps, editFps, codePreload }, use) => {
    if (fps > 0) await context.addInitScript(capFrames, { play: fps, edit: editFps || fps });
    if (!codePreload) {
      await context.addInitScript(() => {
        try {
          if (localStorage.getItem("myco.editor.preloadCodeEditor") === null) localStorage.setItem("myco.editor.preloadCodeEditor", "false");
        } catch {
          // no storage on this page (about:blank): nothing to warm up either
        }
      });
    }
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

// --- The editor's window hooks, and opening the editor (ADR 0330) ---------------------------------------------------------

/** A node of a World's tree, as specs walk it (`root`, `children`): the public node's shape. */
export type HookNode = { name: string; children: HookNode[]; transform: { position: { x: number; y: number; z: number } } | null; isValid: boolean };
/** A World as specs find it through the hooks: its name, tree and clock. */
export type HookWorld = { name: string; paused: boolean; root: HookNode; time: { frameCount: number }; destroy(): void };
/** An Engine as specs find it through the hooks (the editor's, or the play session's). */
export type HookEngine = { world: HookWorld; worlds(): HookWorld[]; findWorld(name: string): HookWorld | null; createWorld(config: object): HookWorld };
/** A gizmo handle of the scene view, at canvas CSS pixels. */
export type HookHandle = { id: string; x: number; y: number };
/** A rectangle at canvas CSS pixels. */
export type HookRect = { left: number; top: number; right: number; bottom: number };
/** A test project's files: project path → text, or bytes (a clip, a model). */
export type ProjectFiles = Record<string, string | Uint8Array>;

/**
 * The editor's debug and end-to-end hooks on `window` (src/editor/session.ts, main.tsx, playSession.ts): the one declaration
 * every spec reads them through. Page callbacks are serialized, so each casts `window` itself: `(window as unknown as Hooks)`.
 * They only find things: read the running game through the public `myco` API (`./liveWorld`), never engine internals.
 */
export type Hooks = {
  /** The editor's Engine, once a project has opened. */
  engine?: HookEngine;
  /** The play session's Engine; null while the editor edits. */
  playEngine?: HookEngine | null;
  /** The scene view's orbit camera. */
  orbit: { focus(point?: [number, number, number], distance?: number): void; focusPoint: { toArray(): number[] } };
  /** The scene view's gizmo handles. */
  overlayHandles?: () => HookHandle[];
  /** Where a document node (by path key) is on the scene view's canvas, or null. */
  nodeRect(key: string): HookRect | null;
  /** Opens the in-memory test project (what `openEditor(page, { files })` calls); there before the session loads. */
  openTestProject?(extra?: ProjectFiles): Promise<void>;
  /** The open test project's folder: what the editor wrote (specs read text files through it). */
  testFolder: { read(path: string): string | undefined };
};

/** The Sound Lab sample (`openEditor(page, { sample: LAB })`): the audio specs' project. */
export const LAB = "sound-lab";

/** When the editor counts as booted, and how long to wait for it. */
export type BootOptions = {
  /** Frames the edit World must have stepped past (default 10: past the first frames, where a project still settles). */
  frames?: number;
  /** How long to wait (default: Playwright's for `waitForFunction`, the test's timeout). */
  timeout?: number;
};

/**
 * Wait until the editor's edit World has booted: stepped more than `frames` frames. `openEditor` waits for it; call it on its
 * own after a reload, or after a project opened through the start screen.
 */
export async function waitForEditor(page: Page, o: BootOptions = {}): Promise<void> {
  await page.waitForFunction((n) => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > n, o.frames ?? 10, o.timeout === undefined ? {} : { timeout: o.timeout });
}

/** What `openEditor` opens: a read-only sample by id, or the writable test project with `files` written over the Flappy sample's. */
export type OpenEditor = ({ sample: string; files?: never } | { files: ProjectFiles; sample?: never }) &
  BootOptions & {
    /** The page's viewport size, set before the editor loads (the Project and Mixer panels want room). */
    viewport?: { width: number; height: number };
    /** A sample's audio backend in place of the one its audio.json names (the page gets audio.json with it, ADR 0344). */
    audioBackend?: "core" | "babylon";
  };

/**
 * Open the editor and wait until its edit World has booted (`waitForEditor`). `{ sample }` opens a read-only sample
 * (`?sample=<id>`, ADR 0031). `{ files }` opens the Flappy sample as a writable project folder in memory with `files` written
 * over it (project path → text or bytes), through the editor's `openTestProject` hook; the folder is on `window.testFolder`.
 * The test project opens from the start screen: opening the read-only sample first and then the folder would set up a
 * project, and its renderer, twice (each costs seconds of CPU with software GL).
 */
export async function openEditor(page: Page, o: OpenEditor): Promise<void> {
  if (o.viewport) await page.setViewportSize(o.viewport);
  if (o.sample !== undefined) {
    if (o.audioBackend) {
      const backend = o.audioBackend;
      // The backend is an engine setting of the sample's `audio.json` (ADR 0344; `project.json` holds no audio).
      await page.route(`**/samples/${o.sample}/audio.json`, async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        json.settings = { ...(json.settings ?? {}), backend };
        await route.fulfill({ response: res, json });
      });
    }
    await page.goto(`/editor.html?sample=${o.sample}`);
  } else {
    await page.goto("/editor.html");
    await page.waitForFunction(() => typeof (window as unknown as Hooks).openTestProject === "function");
    await page.evaluate((files) => (window as unknown as Hooks).openTestProject!(files), o.files);
  }
  await waitForEditor(page, o);
}

/** Wait until the editor's World has stepped `n` more frames: a camera move or an edit made from a test shows (and picks) from the next frame on. */
export async function afterFrames(page: Page, n = 2): Promise<void> {
  const start = await page.evaluate(() => (window as unknown as Hooks).engine?.world.time.frameCount ?? 0);
  await page.waitForFunction((until) => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) >= until, start + n);
}

// --- Play with audio ------------------------------------------------------------------------------------------------------

/** What every audio backend's `Audio.debug()` reports; each helper types the rest it reads. */
export type AudioDebug = { status: string; core: Record<string, unknown> };

/** The running game's `Audio.debug()` (the public `myco` API) as `T`; null before the game's `myco` is up. */
export const readAudioDebug = <T extends AudioDebug = AudioDebug>(page: Page): Promise<T | null> =>
  page.evaluate(() => ((globalThis as unknown as { __myco?: { Audio: { debug(): unknown } } }).__myco?.Audio.debug() as T | undefined) ?? null);

/**
 * Press Play, unlock the audio context with a click in the game view (the user gesture it waits for), and wait until audio
 * runs on `backend` (default the core). `startTimeout`: how long Play may take to start (default `PLAY_START`), longer for a
 * project with many scripts to type-check in a cold worker.
 */
export async function playWithAudio(page: Page, o: { backend?: "core" | "babylon"; startTimeout?: number } = {}): Promise<void> {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: o.startTimeout ?? PLAY_START });
  await page.mouse.click(480, 250);
  await expect.poll(async () => (await readAudioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
  expect((await readAudioDebug(page))!.core.backend).toBe(o.backend ?? "core");
}
