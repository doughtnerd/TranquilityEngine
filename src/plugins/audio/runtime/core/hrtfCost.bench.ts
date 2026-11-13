// H3 / A3.5, the wall-clock half of the HRTF loopback test: the per-voice cost of HRTF in the real wasm (compare with
// `wu::HRTF_VOICE`), with the shell and the loopback host. A wall-clock gate is machine-dependent, so it lives here
// and not in `npm test` (ground rules, test rules); `hrtfLoopback.test.ts` asserts the work (16 voices stay flagged).
//
//   npx vitest run --config tools/audio-bench/selection.vitest.config.mts hrtfCost
//
// Run it alone on a quiet machine.
import { describe, expect, it } from "vitest";
import { req, rig } from "./hrtfLoopbackRig";

/** µs per quantum with 16 spatial voices; `moving` turns the listener 3° a frame (4 quanta), so kernels crossfade. */
async function time(hrtf: number, moving: boolean) {
  const r = await rig({ hrtf });
  if (!r) return null;
  for (let k = 0; k < 16; k++) r.backend.play(req(`s${k}.wav`, Math.sin(k), -Math.cos(k)));
  await r.until(() => r.backend.debug().core.hrtfReady === true || hrtf === 0, "the HRIR table");
  await r.step(40);
  const flagged = r.backend.debug().counters.hrtfVoices;
  const frames = 300;
  let spent = 0;
  const blocks: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (moving) {
      const a = (f * 3 * Math.PI) / 180;
      r.backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: Math.sin(a), y: 0, z: -Math.cos(a) }, up: { x: 0, y: 1, z: 0 } });
      r.backend.update(0.01);
    }
    const t0 = performance.now();
    r.loop.renderQuanta(4);
    const dt = performance.now() - t0;
    spent += dt;
    blocks.push(dt);
  }
  r.backend.dispose();
  blocks.sort((a, b) => a - b);
  return { per: (spent / (frames * 4)) * 1000, flagged, p99: (blocks[Math.floor(blocks.length * 0.99)]! / 4) * 1000 };
}

async function best(hrtf: number, moving: boolean) {
  let out: Awaited<ReturnType<typeof time>> = null;
  for (let k = 0; k < 2; k++) {
    const r = await time(hrtf, moving);
    if (r && (!out || r.per < out.per)) out = r;
  }
  return out;
}

describe("HRTF per-voice cost in the wasm (wall clock)", () => {
  it("measures the per-voice HRTF cost in the wasm", async (ctx) => {
    const ep = await best(0, false);
    const still = await best(16, false);
    const epMoving = await best(0, true);
    const moving = await best(16, true);
    if (!ep || !still || !epMoving || !moving) return ctx.skip();
    expect(still.flagged).toBe(16);
    const perStill = (still.per - ep.per) / 16;
    const perMoving = (moving.per - epMoving.per) / 16;
    console.log(
      `[hrtf cost] wasm (loopback, with the shell): equal-power quantum ${ep.per.toFixed(1)} µs for 16 voices; per HRTF voice +${perStill.toFixed(2)} µs static, +${perMoving.toFixed(2)} µs with the listener turning (kernel crossfades); p99 of 4-quantum blocks per quantum: ${epMoving.p99.toFixed(0)} µs equal-power, ${moving.p99.toFixed(0)} µs HRTF turning`,
    );
    expect(perStill).toBeLessThan(200);
  });
});
