import { expect, type Page, play, test } from "./fixtures";

// Audio events (ADR 0158, M2 E5.4) in a real browser: the Sound Lab's events page (key E on the main page) on the audio
// core and on the Babylon fallback. Footsteps (keys 1-4), the blended engine (E, Up, Right), the single-clip engine (T)
// and the music intensity (N, M) are driven by key presses and checked through `Audio.debug()` (voices with their
// `event`, clip, bus, gain and pitch; the event rows) and, on the core, the bus meters. Headless Chromium has no sound
// output, so the core's own meters and status stand in for ears. The Babylon half also records what the sample's
// single-clip engine does to the native Web Audio nodes under Babylon (the decision log's open follow-up on live
// `loopStart`/`loopEnd` changes).
const LAB = "/editor.html?sample=sound-lab";

test.describe.configure({ timeout: 240_000 });

type Voice = { id: number; clip: string; bus: string; state: string; gain: number; pitch: number; playheadSeconds: number | null; audibility: number; event?: number | null };
type Debug = {
  status: string;
  counters: { underruns: number };
  buses: { name: string; effectiveGain: number; voices: number }[];
  voices: Voice[];
  events: { id: number; asset: string; voices: number; parameters: Record<string, number | string> }[];
  core: Record<string, number | string | boolean>;
};

const audioDebug = (page: Page) =>
  page.evaluate(() => {
    const myco = (globalThis as unknown as { __myco?: { Audio: { debug(): unknown } } }).__myco;
    return myco ? (myco.Audio.debug() as Debug) : null;
  });
/**
 * The Music bus's automated loudness. On Babylon the mixer applies the automation itself, so the debug `effectiveGain`
 * shows it. On the core the automation runs inside the worklet (`effectiveGain` is the bus tree's static gain, 0.6), so
 * the bus's meter is the evidence: the highest peak over 1.5 s (a meter is a snapshot; the pad is a slow wave).
 */
const musicLevel = (page: Page) =>
  page.evaluate(async (core) => {
    const { Audio } = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { peak: number; effectiveGain: number } } } }).__myco;
    if (!core) return Audio.bus("Music").effectiveGain;
    let max = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      max = Math.max(max, Audio.bus("Music").peak);
      await new Promise((r) => setTimeout(r, 15));
    }
    return max;
  }, onCore);
const busPeak = (page: Page, name: string) =>
  page.evaluate((n) => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { peak: number } } } }).__myco.Audio.bus(n).peak, name);
const eventRows = async (page: Page, asset: string) => (await audioDebug(page))!.events.filter((e) => e.asset.includes(asset));

/** A key press the game sees: held across a few frames, since input is snapshotted once per frame. */
async function press(page: Page, key: string, ms = 120): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// --- a sampler in the page (voice ids carry a generation on the core, so `seq` is the order voices were first seen in): short clips (a footstep is ~0.2 s) are over before a poll from the test sees them ---------
type Seen = { id: number; seq: number; clip: string; bus: string; event: number | null; first: number; last: number; gains: number[]; pitches: number[]; heads: number[] };
declare global {
  interface Window {
    __seen?: Record<number, Seen>;
  }
}
async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: { Audio: { debug(): { voices: Voice[] } } } }).__myco;
    window.__seen = {};
    let seq = 0;
    setInterval(() => {
      const t = performance.now();
      for (const v of Audio.debug().voices) {
        if (v.event == null) continue;
        const s = (window.__seen![v.id] ??= { id: v.id, seq: ++seq, clip: v.clip, bus: v.bus, event: v.event, first: t, last: t, gains: [], pitches: [], heads: [] });
        s.last = t;
        s.gains.push(v.gain);
        s.pitches.push(v.pitch);
        if (v.playheadSeconds !== null) s.heads.push(v.playheadSeconds);
      }
    }, 15);
  });
}
const seen = (page: Page, re: string) =>
  page.evaluate((r) => Object.values(window.__seen!).filter((s) => new RegExp(r).test(s.clip)), re);
const seenSince = async (page: Page, re: string, afterId: number) => (await seen(page, re)).filter((s) => s.seq > afterId);
const lastId = (page: Page) => page.evaluate(() => Math.max(0, ...Object.values(window.__seen!).map((s) => s.seq)));
/**
 * The event voices playing a clip, each with its heard `level`: on the core a voice's `gain` stays 1 and the event's blend
 * and automation curves run inside the core (its `audibility` shows them, and a silent layer is "virtual"); on Babylon
 * the runtime sets the voice's `gain` and `pitch` itself.
 */
let onCore = true;
const live = async (page: Page, re: string) =>
  (await audioDebug(page))!.voices.filter((v) => new RegExp(re).test(v.clip) && v.event != null).map((v) => ({ ...v, level: onCore ? v.audibility : v.gain }));

/** On Babylon: the native nodes the sample's sounds play through, and a level tap on the output. Installed before the page's scripts. */
function tapWebAudio(): void {
  type Rec = { node: AudioBufferSourceNode; clip: number; at: number; ended: boolean };
  const w = window as unknown as { __abs: Rec[]; __level: () => number; __ctxs: AudioContext[] };
  w.__abs = [];
  w.__ctxs = [];
  const realStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: [number?, number?, number?]) {
    const rec: Rec = { node: this, clip: this.buffer?.duration ?? 0, at: this.context.currentTime, ended: false };
    this.addEventListener("ended", () => (rec.ended = true));
    w.__abs.push(rec);
    return realStart.apply(this, a);
  };
  // Every connection to a destination also feeds an analyser: the level of what would be heard.
  const analysers = new WeakMap<BaseAudioContext, AnalyserNode>();
  const realConnect = AudioNode.prototype.connect as (...a: unknown[]) => unknown;
  AudioNode.prototype.connect = function (this: AudioNode, ...a: unknown[]) {
    const target = a[0];
    if (target instanceof AudioDestinationNode) {
      let an = analysers.get(this.context);
      if (!an) {
        an = this.context.createAnalyser();
        an.fftSize = 2048;
        analysers.set(this.context, an);
        w.__ctxs.push(this.context as AudioContext);
      }
      realConnect.call(this, an);
    }
    return realConnect.apply(this, a);
  } as typeof AudioNode.prototype.connect;
  w.__level = () => {
    let peak = 0;
    for (const c of w.__ctxs) {
      const an = analysers.get(c);
      if (!an) continue;
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
    }
    return peak;
  };
}

type LoopRow = { t: number; peak: number; loop: boolean; start: number; end: number; clip: number; ended: boolean };

for (const backend of ["core", "babylon"] as const) {
  test(`the Sound Lab events page plays footsteps, both engines and the music on the ${backend} backend`, { tag: "@slow" }, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    if (backend === "babylon") {
      await page.addInitScript(tapWebAudio);
      await page.route("**/samples/sound-lab/project.json", async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        json.audio.backend = "babylon";
        await route.fulfill({ response: res, json });
      });
    }
    const core = backend === "core";
    onCore = core;
    await page.goto(LAB);
    await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
    await play(page);
    await page.mouse.click(480, 250); // the user gesture that unlocks the context, and focus for the keys
    await expect.poll(async () => (await audioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
    expect(((await audioDebug(page))!).core.backend).toBe(backend);

    await test.step("E opens the events page; its music starts about two seconds in", async () => {
      await press(page, "e");
      // The events page's footsteps are on key 1..4 and the music event comes from an AudioSource there.
      await expect.poll(async () => (await eventRows(page, "music-intensity")).length, { timeout: 30_000 }).toBe(1);
      await startSampler(page);
      await expect.poll(async () => (await live(page, "music-(pad|pulse|lead)")).length, { timeout: 15_000 }).toBe(3);
    });
    const startUnderruns = (await audioDebug(page))!.counters.underruns;

    await test.step("footsteps: each surface key starts instances on the Foley bus with that surface's clips", async () => {
      for (const [key, surface] of [["3", "wood"], ["4", "metal"], ["2", "gravel"], ["1", "grass"]]) {
        const after = await lastId(page);
        await press(page, key);
        await expect.poll(async () => (await seenSince(page, "step-", after)).length, { timeout: 10_000 }).toBeGreaterThan(0);
        await page.waitForTimeout(300);
        const steps = await seenSince(page, "step-", after);
        expect(steps.length).toBe(1);
        expect(steps[0].clip, `key ${key}`).toMatch(new RegExp(`step-${surface}-[123]\\.wav$`));
        expect(steps[0].bus).toBe("Foley");
      }
      // Walking (W): several steps, all on the current surface (grass), and not the same clip twice in a row.
      const after = await lastId(page);
      await press(page, "w", 1800);
      const walk = (await seenSince(page, "step-", after)).sort((a, b) => a.seq - b.seq);
      expect(walk.length).toBeGreaterThanOrEqual(3);
      for (const s of walk) expect(s.clip).toMatch(/step-grass-/);
      for (let i = 1; i < walk.length; i++) expect(walk[i].clip).not.toBe(walk[i - 1].clip); // avoidRepeat 1
      await expect.poll(async () => (await audioDebug(page))!.buses.find((b) => b.name === "Foley")!.voices, { timeout: 10_000 }).toBe(0);
    });

    if (core) {
      await test.step("a footstep reaches the Foley bus's meter", async () => {
        let best = 0;
        const sampling = page.evaluate(async () => {
          const { Audio } = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { peak: number } } } }).__myco;
          let max = 0;
          const t0 = performance.now();
          while (performance.now() - t0 < 1500) {
            max = Math.max(max, Audio.bus("Foley").peak);
            await new Promise((r) => setTimeout(r, 15));
          }
          return max;
        });
        await press(page, "3");
        best = await sampling;
        expect(best).toBeGreaterThan(0.005);
      });
    }

    await test.step("the blended engine: start clip, an RPM-driven blend, release into the end clip", async () => {
      const after = await lastId(page);
      await press(page, "e");
      await expect.poll(async () => (await eventRows(page, "engine.audioevent")).length, { timeout: 10_000 }).toBe(1);
      await expect.poll(async () => (await seenSince(page, "engine-start", after)).length, { timeout: 10_000 }).toBe(1);
      expect((await seenSince(page, "engine-start", after))[0].bus).toBe("Engine");
      // The start clip (0.9 s) runs into the idle loop.
      await expect.poll(async () => (await live(page, "engine-idle")).length, { timeout: 15_000 }).toBe(1);
      const idle0 = (await live(page, "engine-idle"))[0];
      const idlePitch0 = idle0.pitch;
      if (core) await expect.poll(async () => busPeak(page, "Engine"), { timeout: 10_000 }).toBeGreaterThan(0.005);
      // Hold Up: RPM 1 (the core smooths it at 1.5 a second): the high clip joins, the idle fades, the pitch rises.
      await page.keyboard.down("ArrowUp");
      await expect.poll(async () => (await live(page, "engine-high")).length, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await live(page, "engine-high"))[0]?.level ?? 0, { timeout: 10_000 }).toBeGreaterThan(0.4);
      await expect.poll(async () => (await live(page, "engine-idle"))[0]?.level ?? 0, { timeout: 10_000 }).toBeLessThan(0.05);
      const high = (await live(page, "engine-high"))[0];
      if (!core) expect(high.pitch).toBeGreaterThan(idlePitch0 * 1.2); // 0.9 -> 1.25 over the blend (the core applies it inside, `pitch` stays 1)
      const rpm = (await eventRows(page, "engine.audioevent"))[0].parameters.RPM as number;
      expect(rpm).toBeGreaterThan(0.9);
      await page.keyboard.up("ArrowUp");
      // Let go: RPM falls back to 0 and the idle clip is the one heard again.
      await expect.poll(async () => (await live(page, "engine-idle"))[0]?.level ?? 0, { timeout: 10_000 }).toBeGreaterThan(0.4);
      await expect.poll(async () => (await live(page, "engine-high"))[0]?.level ?? 0, { timeout: 10_000 }).toBeLessThan(0.05);
      // Half throttle (Right): the mid clip is the loudest.
      await page.keyboard.down("ArrowRight");
      await expect.poll(async () => (await live(page, "engine-mid"))[0]?.level ?? 0, { timeout: 10_000 }).toBeGreaterThan(0.4);
      await page.keyboard.up("ArrowRight");
      // E again: key off. The loop goes, the engine-off clip plays, then the instance ends.
      const beforeOff = await lastId(page);
      await press(page, "e");
      await expect.poll(async () => (await seenSince(page, "engine-off", beforeOff)).length, { timeout: 10_000 }).toBe(1);
      await expect.poll(async () => (await live(page, "engine-(idle|mid|high)")).length, { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => (await eventRows(page, "engine.audioevent")).length, { timeout: 10_000 }).toBe(0); // 1.2 s clip
      // The row can end a frame before the last voice leaves `Audio.debug().voices`: poll for it.
      await expect.poll(async () => (await live(page, "engine-")).length, { timeout: 5000 }).toBe(0);
    });

    let loopTrace: LoopRow[] = [];
    await test.step("the single-clip engine: run-up, a sustain loop, then its tail on release", async () => {
      const after = await lastId(page);
      await press(page, "t");
      await expect.poll(async () => (await seenSince(page, "engine-single", after)).length, { timeout: 10_000 }).toBe(1);
      expect((await seenSince(page, "engine-single", after))[0].bus).toBe("Engine");
      expect((await eventRows(page, "engine-single")).length).toBe(1);
      // The clip is 2.5 s: still playing after 4 s means it looped. On Babylon, trace the native node and the level.
      const trace = page.evaluate(async (isBabylon) => {
        const w = window as unknown as { __abs: { node: AudioBufferSourceNode; clip: number; ended: boolean }[]; __level: () => number };
        const out: LoopRow[] = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 7500) {
          if (isBabylon) {
            const n = [...w.__abs].reverse().find((r) => Math.abs(r.clip - 2.5) < 0.01);
            out.push({ t: performance.now() - t0, peak: w.__level(), loop: n?.node.loop ?? false, start: n?.node.loopStart ?? -1, end: n?.node.loopEnd ?? -1, clip: n?.clip ?? 0, ended: n?.ended ?? false });
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        return out;
      }, !core);
      await page.waitForTimeout(4200);
      const during = await live(page, "engine-single");
      expect(during.length).toBe(1);
      // T again: release. `loop` clears, the current pass finishes (to 1.5 s) and the clip plays on to its end at 2.5 s: the
      // tail is 1 to 2 s from the release, depending on where in the 0.5-1.5 s region it was.
      const releaseAt = await page.evaluate(() => performance.now());
      await press(page, "t");
      await expect.poll(async () => (await eventRows(page, "engine-single")).length, { timeout: 10_000 }).toBe(0);
      console.log("[single-engine] voices right after the row ended:", JSON.stringify(await live(page, "engine-single")));
      await expect.poll(async () => (await live(page, "engine-single")).length, { timeout: 5000 }).toBe(0);
      const single = (await seen(page, "engine-single")).find((s) => s.seq > after)!;
      const tail = (single.last - releaseAt) / 1000;
      console.log(`[single-engine ${backend}] looped ${((releaseAt - single.first) / 1000).toFixed(2)} s (clip 2.5 s), tail after release ${tail.toFixed(2)} s`);
      expect(releaseAt - single.first).toBeGreaterThan(4000); // looped: well past the clip's 2.5 s
      expect(tail).toBeGreaterThan(0.7);
      expect(tail).toBeLessThan(2.4);
      loopTrace = await trace;
    });

    if (!core) {
      await test.step("babylon: what a live loop region change does (decision log 2, open follow-up)", async () => {
        const rows = loopTrace.filter((r) => r.clip > 0);
        expect(rows.length, "the sound's native node was found").toBeGreaterThan(100);
        const sustained = rows.filter((r) => r.loop);
        const endedAt = rows.find((r) => r.ended)?.t ?? Infinity;
        const loopOffAt = rows.find((r) => !r.loop)?.t ?? Infinity;
        console.log(`[loop-region] native AudioBufferSourceNode of the 2.5 s clip: first sample loop=${rows[0].loop} loopStart=${rows[0].start} loopEnd=${rows[0].end}; loop on for ${(sustained[sustained.length - 1].t / 1000).toFixed(2)} s, cleared at ${(loopOffAt / 1000).toFixed(2)} s, node ended at ${(endedAt / 1000).toFixed(2)} s (trace starts at the key press)`);
        console.log(`[loop-region] output peak (includes the music) every 0.25 s:\n${rows.filter((_, i) => i % 12 === 0).map((r) => `${Math.round(r.t)}ms peak=${r.peak.toFixed(3)} loop=${r.loop} ended=${r.ended}`).join("\n")}`);
        // The region the event asked for (0.5-1.5 s) is on the node from its first sample, and it kept looping well past the
        // clip's own 2.5 s: only the release (loop cleared) let it run on to its end.
        expect(rows[0].start).toBeCloseTo(0.5, 2);
        expect(rows[0].end).toBeCloseTo(1.5, 2);
        expect(sustained[sustained.length - 1].t).toBeGreaterThan(4000);
        expect(endedAt).toBeGreaterThan(loopOffAt);
        expect(endedAt).toBeLessThan(Infinity);
      });
    }

    await test.step("the music: Intensity changes the pulse and lead layers and the Music bus's automated gain", async () => {
      // N lowers, M raises by a quarter; the heard value glides at 0.5 a second. Intensity starts at 0.
      await expect.poll(async () => (await live(page, "music-pulse"))[0]?.level ?? 1, { timeout: 15_000 }).toBeLessThan(0.05);
      const quiet = await musicLevel(page);
      const pulse0 = (await live(page, "music-pulse"))[0].level;
      const lead0 = (await live(page, "music-lead"))[0].level;
      for (let i = 0; i < 4; i++) { await press(page, "m", 160); await page.waitForTimeout(120); }
      await expect.poll(() => musicLevel(page), { timeout: 20_000 }).toBeGreaterThan(quiet * 1.8); // 0.45 -> 1
      await expect.poll(async () => (await live(page, "music-pulse"))[0]?.level ?? 0, { timeout: 15_000 }).toBeGreaterThan(0.5);
      await expect.poll(async () => (await live(page, "music-lead"))[0]?.level ?? 0, { timeout: 15_000 }).toBeGreaterThan(0.5);
      expect(pulse0).toBeLessThan(0.05);
      expect(lead0).toBeLessThan(0.05);
      const loud = await musicLevel(page);
      // Back down.
      for (let i = 0; i < 4; i++) { await press(page, "n", 160); await page.waitForTimeout(120); }
      await expect.poll(() => musicLevel(page), { timeout: 20_000 }).toBeLessThan(loud * 0.7);
      await expect.poll(async () => (await live(page, "music-pulse"))[0]?.level ?? 1, { timeout: 15_000 }).toBeLessThan(0.05);
    });

    await test.step("it stayed healthy", async () => {
      const info = (await audioDebug(page))!;
      expect(info.status).toBe("running");
      expect(info.core.backend).toBe(backend);
      if (core) {
        // As audio-core.spec.ts: software-rendered Chromium shares its cores with the audio thread, so a stray
        // underrun now and then is the machine's; a real fault underruns on every quantum.
        // The events page loads a scene and decodes about 25 clips on the main thread beside the audio thread, so a few
        // more than audio-core.spec.ts allows (observed: 1 or 2 while the page loads, none after).
        console.log(`[underruns] events page up: ${startUnderruns}, end: ${info.counters.underruns}`);
        expect(startUnderruns).toBeLessThanOrEqual(3);
        expect(info.counters.underruns).toBeLessThanOrEqual(startUnderruns + 3); // usually none while the page is played; two tests in parallel on a loaded machine saw 2 (a real fault underruns every quantum: hundreds)
      }
      expect(errors).toEqual([]);
    });
  });
}
