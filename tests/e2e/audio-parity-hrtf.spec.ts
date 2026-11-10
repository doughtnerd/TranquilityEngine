import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures";
import { nullDb } from "./audio-parity/analysis";
import { renderCore } from "./audio-parity/coreRender";
import { HRTF_DRIFT_TOLERANCE, hrtfDigest, hrtfMeasure, hrtfTolerance, hrtfViolations, type HrtfDigest } from "./audio-parity/hrtfAnalysis";
import { HRTF_EDGE_DIRECTIONS, hrtfScene } from "./audio-parity/hrtfScenes";
import { loadReferencePage, renderReference } from "./audio-parity/referencePage";
import { HRTF_SCENES, type Scene } from "./audio-parity/scenes";

// HRTF parity (ADR 0157, api-and-models §8 "Web Audio parity"; task H4): the core's HRTF panner (the committed wasm in
// Node, with the shipped HRIR table, the voice's PLAY flagged HRTF: `coreRender.ts`) against a `PannerNode` with
// `panningModel: "HRTF"` in Chromium's `OfflineAudioContext`, at fixed directions: measured ones and ones between. Each
// scene is white noise through one panned voice at distance 1; the comparison is the null of the waveforms (core minus
// reference, relative to the reference, per ear), the band levels, the interaural level difference and the interaural
// time difference (cross-correlation lag between the ears). Chromium's HRTF panner delays its output by 256 frames, so
// the reference render drops them (`referenceLatency`); this spec also checks that the alignment holds.
//
// The tolerances are per rate (`HRTF_TOLERANCES` in `audio-parity/hrtfAnalysis.ts`, which says why they are not the owner's
// -90 dB). The reference renders are committed (`audio-parity/hrtf-reference.json`, regenerated with `PARITY_UPDATE=1`), so
// `src/plugins/audio/testing/hrtfParity.test.ts` checks the core in Node without a browser; this spec also checks that the
// committed digests still describe this Chromium. Chromium only. The second test reports directions exactly on a kernel
// boundary, where the two engines can pick different kernels (`HRTF_EDGE_DIRECTIONS`); it asserts nothing.

test.describe.configure({ timeout: 300_000 });

const REFERENCE_FILE = fileURLToPath(new URL("./audio-parity/hrtf-reference.json", import.meta.url));
const update = process.env.PARITY_UPDATE === "1";
const committed = JSON.parse(readFileSync(REFERENCE_FILE, "utf8")) as { chromium: string; scenes: Record<string, HrtfDigest> };

/** The page the reference renders in; replaced when a render hangs. */
interface Ref {
  page: Page;
}

/**
 * `renderReference` with a guard: a render that never returned (seen in Chromium here, at different scenes, and the
 * page is stuck after it) is abandoned after 30 s and retried once on a new page of the same context.
 */
async function renderRef(ref: Ref, scene: Scene): Promise<Awaited<ReturnType<typeof renderReference>>> {
  for (let attempt = 0; ; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the reference render of ${scene.id} did not return`)), 30_000);
    });
    try {
      return await Promise.race([renderReference(ref.page, scene), timeout]);
    } catch (err) {
      if (attempt > 0) throw err;
      const stuck = ref.page;
      ref.page = await stuck.context().newPage();
      void stuck.close({ runBeforeUnload: false }).catch(() => {});
      await loadReferencePage(ref.page);
    } finally {
      clearTimeout(timer);
    }
  }
}

test("core matches Web Audio: HRTF at fixed directions", { tag: "@slow" }, async ({ page }, info) => {
  await loadReferencePage(page);
  const ref0: Ref = { page };
  const fresh: Record<string, HrtfDigest> = {};
  const failures: string[] = [];
  const rows: string[] = ["scene | null L R (full) | null window | bands dB | ITD core ref | ILD core ref | align"];
  let userAgent = "";
  for (const scene of HRTF_SCENES) {
    const ref = await renderRef(ref0, scene);
    userAgent = ref.userAgent;
    const core = await renderCore(scene);
    const dRef = hrtfDigest(scene, ref.left, ref.right);
    const dCore = hrtfDigest(scene, core.left, core.right);
    fresh[scene.id] = dRef;
    const m = hrtfMeasure(dCore, dRef);
    const from = Math.round(scene.analyzeFrom * scene.rate);
    // The null over the whole aligned render past the crossfade, per ear.
    const nl = nullDb(core.left.subarray(from), ref.left.subarray(from));
    const nr = nullDb(core.right.subarray(from), ref.right.subarray(from));
    // Alignment: the shift (frames) at which the core's left ear matches the reference's best, over +-8.
    let bestLag = 0;
    let bestNull = Number.POSITIVE_INFINITY;
    for (let lag = -8; lag <= 8; lag++) {
      const n = core.left.length - 16 - from;
      const v = nullDb(core.left.subarray(from + 8, from + 8 + n), ref.left.subarray(from + 8 + lag, from + 8 + lag + n));
      if (v < bestNull) [bestNull, bestLag] = [v, lag];
    }
    const tol = hrtfTolerance(scene.rate);
    const lines = hrtfViolations(m, tol);
    const fullNull = Math.max(nl, nr);
    if (fullNull > tol.nullDb) lines.push(`the full aligned waveform null is ${fullNull.toFixed(1)} dB (tolerance ${tol.nullDb})`);
    if (Math.abs(bestLag) > 1) lines.push(`the renders line up ${bestLag} frames off the 256-frame latency`);
    if (!update) {
      const old = committed.scenes[scene.id];
      if (!old) lines.push("no committed reference digest (run with PARITY_UPDATE=1)");
      else for (const v of hrtfViolations(hrtfMeasure(dRef, old), HRTF_DRIFT_TOLERANCE)) lines.push(`committed reference vs this Chromium: ${v}`);
    }
    const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "exact");
    rows.push(
      `${scene.id} | ${f(nl)} ${f(nr)} | ${f(m.windowNullDb)} | ${m.bandsDb.toFixed(3)} | ${dCore.itdFrames.toFixed(3)} ${dRef.itdFrames.toFixed(3)} | ${dCore.ildDb.toFixed(3)} ${dRef.ildDb.toFixed(3)} | ${bestLag}`,
    );
    for (const line of lines) failures.push(`${scene.id}: ${line}`);
  }
  console.log(rows.join("\n"));
  await info.attach("hrtf-rows.txt", { body: rows.join("\n"), contentType: "text/plain" });
  if (update) writeFileSync(REFERENCE_FILE, JSON.stringify({ chromium: userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? userAgent, scenes: fresh }) + "\n");
  expect(failures, failures.join("\n")).toEqual([]);
});

test("HRTF directions exactly on a kernel boundary (reported, not asserted)", { tag: "@slow" }, async ({ page }) => {
  await loadReferencePage(page);
  const ref0: Ref = { page };
  const rows: string[] = ["scene | null L R (full)"];
  for (const direction of HRTF_EDGE_DIRECTIONS) {
    const scene = hrtfScene(direction, 44_100);
    const ref = await renderRef(ref0, scene);
    const core = await renderCore(scene);
    const from = Math.round(scene.analyzeFrom * scene.rate);
    rows.push(`${scene.id} | ${nullDb(core.left.subarray(from), ref.left.subarray(from)).toFixed(1)} ${nullDb(core.right.subarray(from), ref.right.subarray(from)).toFixed(1)}`);
  }
  console.log(rows.join("\n"));
});
