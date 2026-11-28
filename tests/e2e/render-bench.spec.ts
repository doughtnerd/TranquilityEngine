import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, openEditor, test } from "./fixtures";
import { inLiveWorld } from "./liveWorld";
import { BENCH_SCENES } from "./render-bench/scenes";

// The render benchmark (ADRs 0459 and 0460): each scene variant of `render-bench/scenes.ts` is opened, played, warmed up, then its
// play-mode Stats readout (draw calls, triangles, frame time) is sampled at fixed engine frame counts, and the p50 / p99 / max of
// each go to `test-results/render-bench.json`. The targets of the two records are tripwires compared by hand against that file;
// this spec only checks that the numbers are sane (the scene drew something). Frame counts, not waits, set the pace.
// Run: `npm run test:e2e:slow -- render-bench`. Not for the everyday run (@slow); software GL draws a frame of the big scenes in
// seconds (the spike measured about 47 s a frame of the forest), so a variant takes long there: lower RENDER_BENCH_SAMPLES.
//   RENDER_BENCH_WARMUP   engine frames to play before sampling (default 10)
//   RENDER_BENCH_SAMPLES  readings per scene (default 30)
//   RENDER_BENCH_STEP     engine frames between readings (default 2)
//   RENDER_BENCH_ONLY     a substring of the scene id to run alone (`forest`, `city-thin`)

const int = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};
const WARMUP = int("RENDER_BENCH_WARMUP", 10);
const SAMPLES = int("RENDER_BENCH_SAMPLES", 30);
const STEP = int("RENDER_BENCH_STEP", 2);
const ONLY = process.env.RENDER_BENCH_ONLY ?? "";
const REPORT = "test-results/render-bench.json";

// Uncapped frames (the default 10 fps cap would pace the readings), and a long timeout: Play type-checks first, a frame costs seconds on software GL.
test.use({ fps: 0 });
test.describe.configure({ mode: "serial", timeout: 90 * 60_000 });

interface Reading {
  drawCalls: number;
  triangles: number;
  frameMs: number;
}
interface Summary {
  p50: number;
  p99: number;
  max: number;
}

/** Percentile `q` (0..1) of `values`, nearest rank. */
const percentile = (values: readonly number[], q: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
const summarize = (values: readonly number[]): Summary => ({ p50: percentile(values, 0.5), p99: percentile(values, 0.99), max: Math.max(...values) });

/** The report so far (scenes from earlier tests of this run, and from earlier runs of other scenes). */
function readReport(): { scenes: Record<string, unknown> } {
  try {
    return JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {
    return { scenes: {} };
  }
}

test.beforeEach(async ({ page }) => {
  // Stats on (remembered per user): it is the readout this spec samples.
  await page.addInitScript(() => localStorage.setItem("myco.editor.playStats", "true"));
});

for (const bench of BENCH_SCENES) {
  if (!bench.id.includes(ONLY)) continue;
  test(`render bench: ${bench.id}`, { tag: "@slow" }, async ({ page }) => {
    await openEditor(page, { files: bench.files(), viewport: { width: 1600, height: 900 }, timeout: 5 * 60_000 });
    // Not the fixture's `play`: its 20 s start budget is for small scenes. Starting play on a 5,000-object scene with software GL
    // (the World's copy, model loads, the first frame's pipelines) takes longer.
    await page.getByRole("button", { name: "Play", exact: true, description: /^Play the open scene/ }).click();
    await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 30 * 60_000 });
    await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();

    // Warm up: pipelines compile and the first frames settle (frames of the engine's own clock).
    await expect.poll(() => inLiveWorld(page, null, (w) => w?.time.frameCount ?? 0), { timeout: 30 * 60_000 }).toBeGreaterThan(WARMUP);
    // The Stats readout shows the last finished frame's triangles: wait for the first one (on software GL a frame of these scenes
    // takes seconds, and the first ones can finish without drawing while models and pipelines load).
    const statTriangles = page.locator('.play-stats [data-stat="triangles"]');
    await expect.poll(async () => Number((await statTriangles.textContent())?.replace(/[^\d.]/g, "") ?? 0), { timeout: 30 * 60_000 }).toBeGreaterThan(0);

    // Sample: every STEP engine frames, read the Stats overlay (it refreshes about 4 times a second; the camera is still, so a reading
    // from the last refresh is the frame's). The loop runs in the page, so the readings don't wait on round trips.
    const readings: Reading[] = await inLiveWorld(
      page,
      null,
      (w, _tools, arg: { samples: number; step: number }) =>
        new Promise<Reading[]>((resolve, reject) => {
          if (!w) return reject(new Error("no live World"));
          const out: Reading[] = [];
          const num = (stat: string) => Number(document.querySelector(`.play-stats [data-stat="${stat}"]`)?.textContent?.replace(/[^\d.]/g, "") ?? "NaN");
          let next = w.time.frameCount + arg.step;
          const poll = () => {
            if (w.time.frameCount >= next) {
              out.push({ drawCalls: num("draw-calls"), triangles: num("triangles"), frameMs: num("frame-ms") });
              next = w.time.frameCount + arg.step;
              if (out.length >= arg.samples) return resolve(out);
            }
            requestAnimationFrame(poll);
          };
          poll();
        }),
      { samples: SAMPLES, step: STEP },
    );

    expect(readings).toHaveLength(SAMPLES);
    // On software GL some readings show a frame that drew nothing (0 triangles, see the build log), so those are left out:
    // at least half the samples must be drawn frames.
    const drawnReadings = readings.filter((r) => r.triangles > 0);
    expect(drawnReadings.length).toBeGreaterThanOrEqual(Math.ceil(SAMPLES / 2));
    for (const r of drawnReadings) expect(r.drawCalls).toBeGreaterThan(0);
    // Frame ms is recorded but not required: with software GL the overlay shows a frame rate of "paused" (frames take seconds).
    readings.splice(0, readings.length, ...drawnReadings);

    const report = readReport();
    report.scenes[bench.id] = {
      scene: bench.scene,
      variant: bench.variant,
      objects: bench.objects,
      warmupFrames: WARMUP,
      samples: SAMPLES,
      stepFrames: STEP,
      drawCalls: summarize(readings.map((r) => r.drawCalls)),
      triangles: summarize(readings.map((r) => r.triangles)),
      frameMs: summarize(readings.map((r) => r.frameMs)),
    };
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  });
}
