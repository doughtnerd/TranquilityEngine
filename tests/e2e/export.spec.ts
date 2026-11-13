import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { menu } from "./menus";

// Game builds (ADR 0041): `npm run export` turns a sample into a static web build, served here by
// the build's own serve.mjs on a free port, and the game boots in the browser with no editor:
// Flappy reaches its start screen (and plays), Arena shows its menu and Host creates its Server
// World at runtime from a template. The player comes from dist/player/, which the webServer's
// build:editor builds first.

test.describe.configure({ mode: "serial" }); // one export per sample per worker

interface Served {
  url: string;
  dir: string;
  server: ChildProcess;
}

function exportAndServe(sample: string): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), `myco-export-${sample}-`));
  const out = join(dir, "web");
  const result = spawnSync(process.execPath, ["src/export/cli.mjs", `samples/${sample}`, "--out", out], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`export of ${sample} failed:\n${result.stdout}\n${result.stderr}`);
  const server = spawn(process.execPath, [join(out, "serve.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let text = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /http:\/\/[\d.]+:\d+\//.exec(text);
      if (match) resolve({ url: match[0], dir, server });
    });
    server.on("exit", (code) => reject(new Error(`serve.mjs exited (${code}): ${text}`)));
  });
}

function stop(served: Served | undefined): void {
  if (!served) return;
  served.server.kill();
  rmSync(served.dir, { recursive: true, force: true });
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

function trackWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  return warnings;
}

type MusicRow ={ asset: string; state: string; segment: string | null };
type AudioApi = { debug(): { core?: { backend: string }; music?: MusicRow[] }; bus(name: string): { peak: number } };
/** `Audio.debug()` in the running game, or null before the player's engine is up. */
const audioDebug = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __myco?: { Audio: AudioApi } }).__myco?.Audio.debug() ?? null);
/** The highest peak of a bus's meter over `ms` (one reading can land in a quiet part of the clip). */
const busPeakOver = (page: Page, bus: string, ms: number) =>
  page.evaluate(
    async ([name, span]) => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: AudioApi } }).__myco;
      let max = 0;
      const start = performance.now();
      while (performance.now() - start < span) {
        max = Math.max(max, Audio.bus(name).peak);
        await new Promise((r) => setTimeout(r, 10));
      }
      return max;
    },
    [bus, ms] as const,
  );

type Hooks = { engine?: { world: { time: { frameCount: number } }; worlds(): { name: string }[] } };
type Engine = { GameObject: { findObjectOfType(type: unknown): Record<string, unknown> | null }; getComponentClass(id: string): unknown };

const frames = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine?.world.time.frameCount ?? 0);
const worldNames = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine?.worlds().map((w) => w.name) ?? null);
/** The first component of a script type in the running game, or null. */
const findScript = (page: Page, id: string, field: string) =>
  page.evaluate(
    ([id, field]) => {
      const t = (globalThis as unknown as { __myco?: Engine }).__myco;
      const type = t?.getComponentClass(id);
      try {
        const c = type ? t!.GameObject.findObjectOfType(type) : null;
        return c ? (c[field] as unknown) : null;
      } catch {
        return null; // the player's Engine isn't up yet: no active World
      }
    },
    [id, field],
  );

test.describe("Flappy web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("flappy");
  });
  test.afterAll(() => stop(served));

  test("boots to the start screen full-window, and a click starts the game", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect(page).toHaveTitle("flappy");
    await expect.poll(() => findScript(page, "game.GameManager", "state"), { timeout: 20_000 }).toBe("ready");
    await expect.poll(() => frames(page), { timeout: 15_000 }).toBeGreaterThan(10); // the renderer's first frames compile its pipelines

    // The canvas fills the window at the project's aspect ratio (720×680), letterboxed.
    const box = (await page.locator("#game canvas").boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.max(box.width / viewport.width, box.height / viewport.height)).toBeGreaterThan(0.98);
    expect(box.width / box.height).toBeCloseTo(720 / 680, 1);

    await page.locator("#game canvas").click();
    await expect.poll(() => findScript(page, "game.GameManager", "state")).toBe("playing");
    expect(errors).toEqual([]);
  });

  test("the town music, started before the first gesture, plays after the click (F-35)", async ({ page }) => {
    const errors = trackErrors(page);
    const warnings = trackWarnings(page);
    await page.goto(served!.url);
    await expect.poll(() => findScript(page, "game.GameManager", "state"), { timeout: 20_000 }).toBe("ready");
    // The music prefab's AudioSource asked for the town music at load, while the audio core was still loading (the
    // pending backend; in a player's browser it stays so until this click; headless Chromium allows autoplay, so here
    // the core arrives a moment later on its own). Before F-35 the start was refused then, for good.
    await page.locator("#game canvas").click();
    await expect
      .poll(async () => (await audioDebug(page))?.music?.find((m) => m.asset.includes("town")) ?? null, { timeout: 20_000 })
      .toMatchObject({ state: "playing", segment: "town" });
    expect(await busPeakOver(page, "Music", 1000), "the Music bus meter").toBeGreaterThan(0);
    expect(warnings.filter((w) => w.includes("no music support"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("on a device with a 40 ms period (an Android emulator's) the probe counts no underruns: the cap and the ladder stay idle (F-37)", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium's device period follows latencyHint");
    // Chromium sizes its device buffer from latencyHint, so forcing 40 ms gives process() in 40 ms bursts, as on the
    // owner's phone. Before F-37 the underrun probe counted one a second there (its 24 ms threshold assumed a 10 ms
    // period), driving the adaptive cap to its floor in ~12 s and the shedding ladder on after.
    await page.addInitScript(() => {
      const Base = globalThis.AudioContext;
      const g = globalThis as unknown as { AudioContext: typeof AudioContext; __baseLatency?: number };
      g.AudioContext = class extends Base {
        constructor(options?: AudioContextOptions) {
          super({ ...options, latencyHint: 0.04 });
          g.__baseLatency = this.baseLatency;
        }
      };
    });
    await page.goto(served!.url);
    await expect.poll(async () => (await audioDebug(page))?.core?.backend ?? null, { timeout: 20_000 }).toBe("core");
    expect(await page.evaluate(() => (globalThis as unknown as { __baseLatency?: number }).__baseLatency)).toBeGreaterThanOrEqual(0.03);
    await page.waitForTimeout(8_000); // before F-37: ~7 underruns by now, the cap down to ~33
    const debug = (await page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { debug(): unknown } } }).__myco.Audio.debug())) as {
      counters: { underruns: number; mixedCap: number };
      core: { ladderState: string };
    };
    expect(debug.counters.underruns).toBe(0);
    expect(debug.core.ladderState).toBe("idle");
    expect(debug.counters.mixedCap).toBeGreaterThan(16);
  });

  test("a file:// page explains how to serve it", async ({ page }) => {
    await page.goto(`file://${join(served!.dir, "web", "index.html").replace(/\\/g, "/").replace(/^\/?/, "/")}`);
    await expect(page.getByRole("alert")).toContainText("served over HTTP");
  });
});

test("the editor's Export… dialog: the player ships beside the editor; a browser editor without folder access explains, and shows the desktop command", { tag: "@slow" }, async ({ page, browserName }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=flappy"); // relative to baseURL (E2E_PORT)
  await expect(page.locator(".project-name")).toHaveText("Flappy Bird (sample, read-only)");
  const player = await page.evaluate(async () => ((await (await fetch("player/files.json")).json()) as { files: string[] }).files);
  expect(player).toContain("player.html");
  expect(player).toContain("myco.js");

  await menu(page, "File", "Build and Export…");
  const dialog = page.getByRole("dialog", { name: "Build / Export" });
  await expect(dialog).toBeVisible();
  if (browserName === "chromium") {
    // Chromium opens folders through File System Access (ADR 0038), so the web build can be written.
    await expect(dialog.getByRole("button", { name: "Choose Folder and Export…" })).toBeEnabled();
  } else {
    await expect(dialog).toContainText("this browser editor can't do");
    await expect(dialog.getByRole("button", { name: "Choose Folder and Export…" })).toBeDisabled();
  }
  await dialog.getByLabel("Desktop app").check();
  await expect(dialog.locator(".export-command")).toContainText("npm run export -- \"<projectDir>\" --target desktop");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("Sound Lab web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("sound-lab");
  });
  test.afterAll(() => stop(served));

  test("after a tap, the music page plays its World music (F-35)", async ({ page }) => {
    const errors = trackErrors(page);
    const warnings = trackWarnings(page);
    await page.goto(served!.url);
    await expect.poll(() => frames(page), { timeout: 20_000 }).toBeGreaterThan(10);
    await page.locator("#game canvas").click(); // the gesture that unlocks sound
    await page.keyboard.press("m");
    await expect
      .poll(async () => (await audioDebug(page))?.music?.find((m) => m.asset.includes("music-world")) ?? null, { timeout: 20_000 })
      .toMatchObject({ state: "playing", segment: expect.any(String) });
    expect(await busPeakOver(page, "Music", 1000), "the Music bus meter").toBeGreaterThan(0);
    expect(warnings.filter((w) => w.includes("no music support"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  // M5-0 shipped form (ADR 0171 amended by 0172, task SX0): in the exported page, after the first tap, a scripted fade (the
  // main page's key 3) moves Music's lane on the stamp the core was given, and a burst on SFX (key 5) ducks Music through the
  // core's presence lane. Both read from `Audio.debug()` and the bus API; every bound is on the audio clock (`Audio.time`, the
  // frame the stamp is in), never a wall-clock tolerance. The wall-clock polls only pace the reads.
  test("after a tap, a fade lands on its stamp and a presence duck shows in Audio.debug() (M5-0)", async ({ page }) => {
    type Row = { name: string; effectiveGain: number; lastRampStartFrame?: number };
    type Dbg = { status: string; sampleRate: number; time: number; core: { backend: string }; buses: Row[] };
    type Api = { Audio: { time: number; debug(): Dbg; bus(n: string): { effectiveGain: number; duckGain: number } } };
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect.poll(() => frames(page), { timeout: 20_000 }).toBeGreaterThan(10);
    await page.locator("#game canvas").click(); // the gesture that unlocks sound
    await expect
      .poll(async () => (await page.evaluate(() => (globalThis as unknown as { __myco?: Api }).__myco?.Audio.debug().status)) ?? null, { timeout: 30_000 })
      .toBe("running");
    const read = () =>
      page.evaluate(() => {
        const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
        const d = Audio.debug();
        const music = d.buses.find((b) => b.name === "Music")!;
        return { backend: d.core.backend, rate: d.sampleRate, time: Audio.time, frame: Math.round(Audio.time * d.sampleRate), gain: Audio.bus("Music").effectiveGain, row: music.effectiveGain, stamp: music.lastRampStartFrame, duck: Audio.bus("Music").duckGain };
      });
    const before = await read();
    expect(before.backend).toBe("core");
    expect(before.gain, "Music's authored 0.6, undisturbed").toBeCloseTo(0.6, 6);
    expect(before.duck, "nothing on SFX yet").toBe(1);

    // 1. The fade: key 3 is `Audio.bus("Music").fadeTo(0.25, 0.5)`. One stamped record, landed by stamp + 0.5 s of audio frames.
    const pressedAt = (await read()).frame;
    await page.keyboard.press("3");
    await expect.poll(async () => (await read()).stamp ?? 0, { timeout: 15_000, message: "Music's row shows the stamped BUS_RAMP" }).toBeGreaterThan(pressedAt);
    const stamp = (await read()).stamp!;
    expect(stamp - pressedAt, "stamped within the lookahead and the clock's lead").toBeLessThan(0.5 * before.rate);
    await page.waitForFunction(([s, r]) => (globalThis as unknown as { __myco: Api }).__myco.Audio.time * (r as number) > (s as number) + 0.5 * (r as number), [stamp, before.rate] as const, { timeout: 20_000 });
    const landed = await read();
    expect(landed.gain, "landed on 0.6 x 0.25 by stamp + its 0.5 s").toBeCloseTo(0.15, 4);
    expect(landed.row, "the Audio.debug() row says the same").toBeCloseTo(0.15, 4);
    expect(landed.stamp, "one stamp: nothing was re-sent while it ran").toBe(stamp);

    // 2. The duck: key 5 plays a burst on SFX; the project's rule ducks Music to 0.3 (attack 0.05 s, release 0.4 s). The core owns
    // the duck lane: `duckGain` reads its STATUS value, and the bus's effective gain carries it.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __myco: Api; __duck?: { time: number; duck: number; gain: number }[] };
      g.__duck = [];
      setInterval(() => g.__duck!.push({ time: g.__myco.Audio.time, duck: g.__myco.Audio.bus("Music").duckGain, gain: g.__myco.Audio.bus("Music").effectiveGain }), 10);
    });
    const t5 = (await read()).time;
    await page.keyboard.press("5");
    await page.waitForFunction((t) => (globalThis as unknown as { __myco: Api }).__myco.Audio.time > (t as number) + 2, t5, { timeout: 20_000 });
    const duck = await page.evaluate((t) => (globalThis as unknown as { __duck: { time: number; duck: number; gain: number }[] }).__duck.filter((d) => d.time >= (t as number)), t5);
    const lowest = Math.min(...duck.map((d) => d.duck));
    expect(lowest, "the duck reached the rule's 0.3").toBeLessThan(0.35);
    expect(lowest).toBeGreaterThan(0.28);
    expect(Math.min(...duck.map((d) => d.gain)), "Music's effective gain carried it: 0.15 x ~0.3").toBeLessThan(0.15 * 0.4);
    expect(duck[0]!.duck, "the duck begins from 1, not a step").toBeGreaterThan(0.9);
    await expect.poll(async () => (await read()).duck, { timeout: 15_000, message: "released back to 1" }).toBe(1);
    expect((await read()).gain, "the fade's level is back under the released duck").toBeCloseTo(0.15, 4);
    expect(errors).toEqual([]);
  });

  // M5a shipped form (ADR 0171 amended by 0172, task Rc4): an exported game that never calls `Audio.capture.start` loads no
  // recorder chunk. The build does carry the chunk (a file named for the recorder sits beside the page), the page plays sound
  // for two seconds of the audio clock without requesting it, and `start()` is what fetches it.
  test("a game that never calls Audio.capture.start loads no recorder chunk; start() fetches it (M5a)", async ({ page }) => {
    type Capture = { state: string; start(): Promise<void>; stop(): void; save(name?: string): Promise<string> };
    type Api = { Audio: { time: number; capture: Capture; debug(): { status: string; core: { backend: string } } } };
    const errors = trackErrors(page);
    const requested: string[] = [];
    page.on("request", (req) => requested.push(new URL(req.url()).pathname));
    const isRecorder = (path: string) => /(^|\/)recorder[-.][\w-]*\.js$/.test(path);
    const chunks = (readdirSync(join(served!.dir, "web"), { recursive: true }) as string[]).map((f) => f.replace(/\\/g, "/")).filter(isRecorder);
    expect(chunks.length, "the build carries a recorder chunk, so its absence from the page's requests means something").toBeGreaterThan(0);

    await page.goto(served!.url);
    await expect.poll(() => frames(page), { timeout: 20_000 }).toBeGreaterThan(10);
    await page.locator("#game canvas").click(); // the gesture that unlocks sound
    await expect
      .poll(async () => (await page.evaluate(() => (globalThis as unknown as { __myco?: Api }).__myco?.Audio.debug().status)) ?? null, { timeout: 30_000 })
      .toBe("running");
    expect(await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.debug().core.backend)).toBe("core");
    await page.keyboard.press("m"); // the music page: a running game with sound
    const t0 = await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.time);
    await page.waitForFunction((t) => (globalThis as unknown as { __myco: Api }).__myco.Audio.time > (t as number) + 2, t0, { timeout: 30_000 });

    // Two seconds of the audio clock with sound playing: no chunk of the recorder (or Audio.capture's state) was touched.
    expect(requested.filter(isRecorder), "no recorder chunk requested by a game that never captures").toEqual([]);
    expect(await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.capture.state)).toBe("idle");
    expect(requested.filter(isRecorder)).toEqual([]);

    // Positive control: start() is what fetches it, and the take is real.
    await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.capture.start());
    expect(requested.filter(isRecorder).length, "start() fetched the recorder chunk").toBeGreaterThan(0);
    expect(requested.filter(isRecorder).every((p) => chunks.some((c) => p.endsWith(c)))).toBe(true);
    expect(await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.capture.state)).toBe("recording");
    const t1 = await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.time);
    await page.waitForFunction((t) => (globalThis as unknown as { __myco: Api }).__myco.Audio.time > (t as number) + 1, t1, { timeout: 30_000 });
    const [download, name] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(() => {
        const c = (globalThis as unknown as { __myco: Api }).__myco.Audio.capture;
        c.stop();
        return c.save("exported");
      }),
    ]);
    expect(name).toBe("exported.mycap");
    expect(download.suggestedFilename()).toBe("exported.mycap");
    expect(errors).toEqual([]);
  });

  // M5b shipped form (ADR 0171 amended by 0172, task SXb): in the exported page, after the first tap, master's meter reads a
  // number, and the loudness page's reference (key L: the other sounds pause, a 1 kHz sine at -23 dBFS plays on the metered UI
  // bus) reads -22.99 LUFS (EBU Tech 3341 case 1, +/- 0.1 LU) on master and on UI. The editor's Play and its reset-on-Play are
  // not in this page: the meter starts with the engine and the game's own key (C) resets it. Waits are on the meters' `elapsed`
  // (seconds of rendered audio since the reset), never a wall-clock span.
  test("after a tap, master's meter reads a number and the reference tone reads -22.99 LUFS (M5b)", async ({ page }) => {
    type Loud = { momentary: number; integrated: number; lra: number; maxTruePeak: number; elapsed: number; metered: boolean; incomplete: boolean; tainted: boolean; target: { name: string; state: string; peakOver: boolean; deviation: number } | null };
    type Api = { Audio: { time: number; debug(): { status: string; core: { backend: string } }; bus(n: string): { loudness: Loud } } };
    const errors = trackErrors(page);
    const read = (bus: string) =>
      page.evaluate((name) => {
        const m = (globalThis as unknown as { __myco: Api }).__myco.Audio.bus(name).loudness;
        const t = m.target;
        return { momentary: m.momentary, integrated: m.integrated, lra: m.lra, maxTruePeak: m.maxTruePeak, elapsed: m.elapsed, metered: m.metered, incomplete: m.incomplete, tainted: m.tainted, target: t ? { name: t.name, state: t.state, peakOver: t.peakOver, deviation: t.deviation } : null };
      }, bus);
    await page.goto(served!.url);
    await expect.poll(() => frames(page), { timeout: 20_000 }).toBeGreaterThan(10);
    await page.locator("#game canvas").click(); // the gesture that unlocks sound
    await expect
      .poll(async () => (await page.evaluate(() => (globalThis as unknown as { __myco?: Api }).__myco?.Audio.debug().status)) ?? null, { timeout: 30_000 })
      .toBe("running");
    expect(await page.evaluate(() => (globalThis as unknown as { __myco: Api }).__myco.Audio.debug().core.backend)).toBe("core");

    // 1. The page's own loop and hum are playing: master reads a number, and it is metered in the shipped build.
    await expect.poll(async () => (await read("Master")).momentary, { timeout: 30_000, message: "master's momentary level has its four sub-blocks" }).toBeGreaterThan(-70);
    const first = await read("Master");
    expect(first.metered).toBe(true);
    expect(first.momentary).toBeLessThan(0);
    expect((await read("UI")).metered, "the project's metered UI bus is metered in the build").toBe(true);

    // 2. The reference: L pauses the page's other sounds and plays the tone; once master's momentary level has settled on it (the
    // hum's reverb has rung out) C resets, and after 6 s of metered audio the integrated level is the tone's.
    await page.keyboard.press("l");
    await expect.poll(async () => (await read("Master")).momentary, { timeout: 60_000, message: "master settled on the tone" }).toBeCloseTo(-22.99, 1);
    await page.keyboard.press("c");
    await expect.poll(async () => (await read("Master")).elapsed, { timeout: 15_000 }).toBeLessThan(1);
    await expect.poll(async () => Math.min((await read("Master")).elapsed, (await read("UI")).elapsed), { timeout: 60_000, message: "6 s of rendered audio on both meters" }).toBeGreaterThanOrEqual(6);
    for (const bus of ["Master", "UI"]) {
      const r = await read(bus);
      expect(r.integrated, `${bus} integrated`).toBeGreaterThan(-22.99 - 0.1);
      expect(r.integrated).toBeLessThan(-22.99 + 0.1);
      expect(r.maxTruePeak, `${bus} true peak`).toBeGreaterThan(-23.4);
      expect(r.maxTruePeak).toBeLessThan(-22.8);
      expect(r.lra).toBeGreaterThanOrEqual(0);
      expect(r.lra).toBeLessThan(0.1);
      expect(r.incomplete).toBe(false);
      expect(r.tainted).toBe(false);
    }
    expect((await read("Master")).target, "the project's first target: console, -24 LUFS +/- 2 LU").toMatchObject({ name: "console", state: "ok", peakOver: false });
    expect(errors).toEqual([]);
  });
});

test.describe("Arena web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("arena");
  });
  test.afterAll(() => stop(served));

  test("boots to the menu; Host creates the Server World at runtime", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect.poll(() => findScript(page, "arena.Menu", "serverUrl"), { timeout: 20_000 }).toBeTruthy();
    expect(await worldNames(page)).toEqual(["Client"]);
    await expect.poll(() => frames(page), { timeout: 15_000 }).toBeGreaterThan(10); // the renderer's first frames compile its pipelines

    await page.keyboard.press("h");
    await expect.poll(() => worldNames(page), { timeout: 15_000 }).toEqual(["Client", "Server"]);
    expect(errors).toEqual([]);
  });
});

test.describe("3D Playground web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("playground3d");
  });
  test.afterAll(() => stop(served));

  test("loads its OBJ and FBX models and materials, and the crates fall under 3D physics (ADR 0043–0045)", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect(page).toHaveTitle("3D Playground");
    await expect.poll(() => frames(page), { timeout: 20_000 }).toBeGreaterThan(10);
    type Myco = {
      MeshRenderer: unknown;
      RigidBody: unknown;
      GameObject: { findObjectsOfType(type: unknown): { node: { name: string; transform: { position: { y: number } } } }[] };
    };
    const state = () =>
      page.evaluate(() => {
        const m = (globalThis as unknown as { __myco: Myco }).__myco;
        const drawn = m.GameObject.findObjectsOfType(m.MeshRenderer).map((r) => r.node.name);
        const heights = m.GameObject.findObjectsOfType(m.RigidBody).map((b) => b.node.transform.position.y);
        return { drawn: drawn.sort(), highest: Math.max(...heights) };
      });
    await expect.poll(async () => (await state()).drawn).toEqual(["Ball", "Body", "Crate 1", "Crate 2", "Crate 3", "Crate 4", "Ground", "Head", "Orb", "Pillar", "Street Lamp"]);
    // Everything starts 3 m or higher; after a few seconds it has all landed on the ground.
    await expect.poll(async () => (await state()).highest, { timeout: 15_000 }).toBeLessThan(3);
    expect(errors).toEqual([]);
  });
});
