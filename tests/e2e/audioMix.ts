import { expect, type Page, play } from "./fixtures";

// Shared helpers of the M5 audio-mix e2e specs (ADR 0171 amended by 0172): `audio-mix-smoke.spec.ts` and later the listening walker.
// Timing here is on the product's clock: the core's rendered frame (the STATUS mirror's `currentFrame`), never a wall-clock tolerance.

export const LAB = "/editor.html?sample=sound-lab";

export type BusRow = { name: string; gain: number; effectiveGain: number; peakL: number; peakR: number; voices: number };
export type MixDebug = {
  status: string;
  sampleRate: number;
  time: number;
  counters: { underruns: number };
  buses: BusRow[];
  core: Record<string, number | string | boolean>;
};
type BusApi = { volume: number; mute: boolean; effectiveGain: number; exists: boolean; fadeTo(v: number, s: number): void };
type Api = { Audio: { debug(): unknown; time: number; bus(n: string): BusApi; buses: readonly string[]; playOneShot(c: string, o?: object): { voice?: { backend?: unknown; inner?: { backend?: unknown } } } } };

export const mixDebug = (page: Page) => page.evaluate(() => ((globalThis as unknown as { __myco?: Api }).__myco?.Audio.debug() as MixDebug | undefined) ?? null);

/** Opens a sample in Play mode and unlocks the audio context with a click; waits for the running core backend. */
export async function bootMix(page: Page, url = LAB): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await play(page);
  await page.mouse.click(480, 250); // the user gesture that unlocks the context
  await expect.poll(async () => (await mixDebug(page))?.status, { timeout: 30_000 }).toBe("running");
  expect((await mixDebug(page))!.core.backend).toBe("core");
}

/**
 * Installs `globalThis.__mixFrame()` in the page: the core's last rendered frame (STATUS `currentFrame`), read through a
 * voice's backend (TypeScript-private, a plain property at run time). `Audio.debug()` carries no frame field today; the
 * fallback is the audio clock in frames (`Audio.time` x the sample rate), the same clock at the update's granularity.
 */
export async function installFrameClock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __myco: Api; __mixFrame?: () => { frame: number; source: string } };
    const v = g.__myco.Audio.playOneShot("audio/beep.wav", { volume: 0.0001, bus: "UI" }).voice;
    const backend = (v?.backend ?? v?.inner?.backend) as { mirror?: { currentFrame?: number } } | undefined;
    g.__mixFrame = () => {
      const f = backend?.mirror?.currentFrame;
      if (typeof f === "number" && f > 0) return { frame: f, source: "status.currentFrame" };
      const d = g.__myco.Audio.debug() as MixDebug;
      return { frame: Math.round(d.time * d.sampleRate), source: "Audio.time * sampleRate" };
    };
  });
}

export type GainSample = { frame: number; gain: number; debugGain: number };

/**
 * Runs `start` in the page, then samples the bus's `effectiveGain` (and its `Audio.debug()` row) every 15 ms, each stamped with
 * the audio frame, until the gain has been within 1e-4 of `target` for 3 samples or `maxFrames` audio frames have passed.
 * The stop condition is on the audio clock; the real-time interval only paces the reads.
 */
export const sampleBusGain = (page: Page, bus: string, target: number, maxFrames: number, start: string) =>
  page.evaluate(
    async ([name, to, limit, startSrc]) => {
      const g = globalThis as unknown as { __myco: Api; __mixFrame: () => { frame: number } };
      const out: { frame: number; gain: number; debugGain: number }[] = [];
      const read = () => {
        const d = g.__myco.Audio.debug() as MixDebug;
        return { frame: g.__mixFrame().frame, gain: g.__myco.Audio.bus(name as string).effectiveGain, debugGain: d.buses.find((b) => b.name === name)!.effectiveGain };
      };
      out.push(read());
      new Function("Audio", startSrc as string)(g.__myco.Audio);
      const first = out[0]!.frame;
      let settled = 0;
      while (settled < 3 && g.__mixFrame().frame - first < (limit as number)) {
        await new Promise((r) => setTimeout(r, 15));
        const s = read();
        out.push(s);
        settled = Math.abs(s.gain - (to as number)) < 1e-4 ? settled + 1 : 0;
      }
      return out;
    },
    [bus, target, maxFrames, start] as const,
  );
