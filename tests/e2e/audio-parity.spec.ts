import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures";
import { digest, measure, nullDb, TOLERANCES, violations, type Digest } from "./audio-parity/analysis";
import { renderCore } from "./audio-parity/coreRender";
import { loadReferencePage, renderReference } from "./audio-parity/referencePage";
import { SCENES, type Scene } from "./audio-parity/scenes";
import type { TestInfo } from "@playwright/test";

// Web Audio parity (ADR 0157, api-and-models §8 "Web Audio parity"; task A2.2c): every scene in
// `audio-parity/scenes.ts` is rendered twice, through the audio core (the committed wasm, in Node) and through an
// `OfflineAudioContext` running the reference graph (`src/plugins/audio/testing/webAudioReference.ts`, in Chromium), and
// the two are compared in dB: band levels, envelopes, RMS and peak, the reverb's decay curve, and a null test of the
// waveforms (core minus reference, relative to the reference).
//
// Tolerance: ADR 0157 names "the ADR's dB tolerance" without a figure; the harness enforces `TOLERANCES` in
// `audio-parity/analysis.ts` (per scene family: biquad, compressor, reverb, pan), set from the measured differences.
//
// The reference renders are committed as digests (`audio-parity/reference.json`) so a Node test
// (`src/plugins/audio/testing/webAudioParity.test.ts`) compares the core without a browser. This spec also checks that
// the committed digests still match what this Chromium renders, and regenerates them with `PARITY_UPDATE=1`.
//
// Chromium only here; WebKit and Firefox parity (Docker) is not run in this task. An engine's own `OfflineAudioContext`
// is a different reference, and its digests would be committed beside Chromium's.

test.describe.configure({ timeout: 180_000 });

const REFERENCE_FILE = fileURLToPath(new URL("./audio-parity/reference.json", import.meta.url));
const update = process.env.PARITY_UPDATE === "1";
const committed = JSON.parse(readFileSync(REFERENCE_FILE, "utf8")) as { chromium: string; scenes: Record<string, Digest> };

interface Row {
  id: string;
  profile: string;
  bandsDb: number;
  envDb: number;
  levelsDb: number;
  edcDb: number;
  windowsNullDb: number;
  fullNullDb: number;
  peakFrames: number;
}

const fresh: Record<string, Digest> = {};
let userAgent = "";

async function runGroup(page: Page, scenes: readonly Scene[], info: TestInfo): Promise<void> {
  await loadReferencePage(page);
  const rows: Row[] = [];
  const failures: string[] = [];
  for (const scene of scenes) {
    const ref = await renderReference(page, scene);
    userAgent = ref.userAgent;
    const core = await renderCore(scene);
    const dRef = digest(scene, ref.left, ref.right);
    const dCore = digest(scene, core.left, core.right);
    fresh[scene.id] = dRef;
    const m = measure(dCore, dRef);
    const tol = TOLERANCES[scene.profile];
    // The null test over the whole render: the worse channel.
    const fullNull = Math.max(nullDb(core.left, ref.left), nullDb(core.right, ref.right), Number.NEGATIVE_INFINITY);
    const lines = violations(scene, m);
    if (fullNull > tol.nullDb) lines.push(`the full waveform null is ${fullNull.toFixed(1)} dB (tolerance ${tol.nullDb})`);
    // The committed digest must still describe this Chromium's render.
    const old = (committed.scenes as Record<string, Digest>)[scene.id];
    if (!update) {
      if (!old) lines.push("no committed reference digest (run with PARITY_UPDATE=1)");
      else {
        const drift = measure(dRef, old);
        for (const v of violations(scene, drift)) lines.push(`committed reference vs this Chromium: ${v}`);
      }
    }
    rows.push({ id: scene.id, profile: scene.profile, bandsDb: m.bandsDb, envDb: m.envDb, levelsDb: m.levelsDb, edcDb: m.edcDb, windowsNullDb: m.windowsNullDb, fullNullDb: fullNull, peakFrames: m.peakFrames });
    for (const line of lines) failures.push(`${scene.id}: ${line}`);
  }
  const fmt = (x: number, d = 3): string => (Number.isFinite(x) ? x.toFixed(d) : Number.isNaN(x) ? "-" : x > 0 ? "inf" : "exact");
  console.log(
    ["id  bands env levels edc | null(windows) null(full) peakΔ"]
      .concat(rows.map((r) => `${r.id}  ${fmt(r.bandsDb)} ${fmt(r.envDb)} ${fmt(r.levelsDb)} ${fmt(r.edcDb)} | ${fmt(r.windowsNullDb, 1)} ${fmt(r.fullNullDb, 1)} ${r.peakFrames}`))
      .join("\n"),
  );
  await info.attach("parity-rows.json", { body: JSON.stringify(rows, null, 1), contentType: "application/json" });
  expect(failures, failures.join("\n")).toEqual([]);
}

const groups = ["filter", "snapshot", "compressor", "reverb", "pan"] as const;
for (const group of groups) {
  test(`core matches Web Audio: ${group} scenes`, { tag: "@slow" }, async ({ page }, info) => {
    await runGroup(page, SCENES.filter((s) => s.group === group), info);
  });
}

// H4's HRTF scenes (`HRTF_SCENES`) run in their own spec, `audio-parity-hrtf.spec.ts`.

test.afterAll(() => {
  if (!update) return;
  const scenes: Record<string, Digest> = {};
  for (const scene of SCENES) if (fresh[scene.id]) scenes[scene.id] = fresh[scene.id]!;
  // A partial run (one group, or another worker's groups) keeps the digests already in the file: it is read again here.
  const onDisk = JSON.parse(readFileSync(REFERENCE_FILE, "utf8")) as { scenes: Record<string, Digest> };
  const merged = { ...onDisk.scenes, ...scenes };
  const ordered: Record<string, Digest> = {};
  for (const scene of SCENES) if (merged[scene.id]) ordered[scene.id] = merged[scene.id]!;
  writeFileSync(REFERENCE_FILE, JSON.stringify({ chromium: userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? userAgent, scenes: ordered }) + "\n");
});
