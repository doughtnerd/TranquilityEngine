import { expect, type Page, play, test } from "./fixtures";

// The audio core (ADR 0157, `audio.backend: "core"`) in a real browser, through the Sound Lab sample (A2.6): one-shots,
// bus mute and peak, a snapshot, ducking, and a moving spatial source. The sample's scripts answer to keys 1..6; most
// steps press the key and check `Audio.debug()` and the buses' `peak` (the engine module project scripts import as "myco",
// `globalThis.__myco`). Headless Chromium has no sound output, so the checks read the core's own meters and status.
const LAB = "/editor.html?sample=sound-lab";

test.describe.configure({ timeout: 180_000 });

type Debug = {
  status: string;
  counters: { underruns: number; logicalVoices: number; mixedVoices: number };
  buses: { name: string; gain: number; effectiveGain: number; peakL: number; peakR: number; voices: number }[];
  voices: { clip: string; bus: string; state: string; gain: number }[];
  core: Record<string, number | string | boolean>;
};

const audioDebug = (page: Page) =>
  page.evaluate(() => {
    const myco = (globalThis as unknown as { __myco?: { Audio: { debug(): unknown } } }).__myco;
    return myco ? (myco.Audio.debug() as Debug) : null;
  });

const busInfo = async (page: Page, name: string) => (await audioDebug(page))!.buses.find((b) => b.name === name)!;

/** What a script sees of a bus: `Audio.bus(name)`. */
const busApi = (page: Page, name: string) =>
  page.evaluate((n) => {
    const b = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { peak: number; mute: boolean; effectiveGain: number; activeVoices: number } } } }).__myco.Audio.bus(n);
    return { peak: b.peak, mute: b.mute, effectiveGain: b.effectiveGain, activeVoices: b.activeVoices };
  }, name);

/** The underrun probe's threshold (`coreDriver.ts` `PROBE_THRESHOLD_S`): the audio thread this far behind the wall clock. */
const STARVED_MS = 24;

type HostLog = { starved: [number, number][]; underruns: { t: number; prev: number; n: number }[] };

/**
 * Host starvation, measured beside the core (F-32). The underrun probe counts the audio thread falling behind the wall clock,
 * which a core that can't keep up does, and so does a machine that doesn't run the page's threads (other workers, other
 * agents: under the full slow suite the audio thread missed its slot during the page's start). A worker thread with nothing
 * else to do times its own 10 ms timer and logs each late tick past the probe's threshold (wall-clock ms, late by); the page
 * logs each rise in `counters.underruns` with the poll before it. An underrun with no starved tick from a second before the
 * previous poll (the probe's 1 s window) to the poll that saw it is the core's; one beside a starved tick is the machine's.
 */
function hostMonitor(starvedMs: number): void {
  const g = globalThis as unknown as { __host?: HostLog; __myco?: { Audio: { debug(): { counters: { underruns: number } } } } };
  const log: HostLog = { starved: [], underruns: [] };
  g.__host = log;
  const src = `let last = performance.now();
    setInterval(() => { const n = performance.now(); const late = n - last - 10; last = n; if (late > ${starvedMs}) postMessage([performance.timeOrigin + n, late]); }, 10);`;
  try {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (e: MessageEvent<[number, number]>) => void log.starved.push(e.data);
  } catch {
    // No worker: every underrun counts as the core's.
  }
  let prev = performance.timeOrigin + performance.now();
  let seen = 0;
  setInterval(() => {
    const t = performance.timeOrigin + performance.now();
    let n = seen;
    try {
      n = g.__myco?.Audio.debug().counters.underruns ?? seen;
    } catch {
      // Not booted yet.
    }
    if (n > seen) log.underruns.push({ t, prev, n: n - seen });
    seen = n;
    prev = t;
  }, 250);
}

/** The underruns up to wall-clock `until` (ms): all of them, and those with no starved tick of the host beside them. */
function underrunsOf(log: HostLog, until = Infinity): { all: number; core: number } {
  let all = 0;
  let core = 0;
  for (const u of log.underruns) {
    if (u.t > until) continue;
    all += u.n;
    if (!log.starved.some(([t]) => t >= u.prev - 1000 && t <= u.t)) core += u.n;
  }
  return { all, core };
}

/** A key press the game sees: held across a few frames, since input is snapshotted once per frame. */
async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(120);
  await page.keyboard.up(key);
}

test("the Sound Lab exercises the core: one-shots, buses, snapshots, ducking and a moving source", { tag: "@slow" }, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.addInitScript(hostMonitor, STARVED_MS);
  await page.goto(LAB);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await play(page);
  await page.mouse.click(480, 250); // the user gesture that unlocks the context, and focus for the keys

  await test.step("the core runs and the looping sources are voices", async () => {
    await expect.poll(async () => (await audioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
    const info = (await audioDebug(page))!;
    expect(info.core.backend).toBe("core");
    // The Music loop and the spatial emitter.
    await expect.poll(async () => (await audioDebug(page))!.voices.filter((v) => /(music|hum)-loop/.test(v.clip)).length, { timeout: 30_000 }).toBe(2);
    expect((await busInfo(page, "Music")).voices).toBe(1);
    await expect.poll(async () => (await busApi(page, "Music")).peak, { timeout: 15_000 }).toBeGreaterThan(0.01);
  });

  const startedAt = await page.evaluate(() => performance.timeOrigin + performance.now());

  await test.step("one-shots create voices and end", async () => {
    // From a script: the handle is playing at once, and not after the 0.25 s clip ends.
    const ended = await page.evaluate(async () => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { playOneShot(c: string, o?: object): { playing: boolean } } } }).__myco;
      const h = Audio.playOneShot("audio/beep.wav", { bus: "UI" });
      const first = h.playing;
      const start = performance.now();
      while (h.playing && performance.now() - start < 5000) await new Promise((r) => setTimeout(r, 25));
      return { first, playing: h.playing };
    });
    expect(ended).toEqual({ first: true, playing: false });
    // From the key: the script's click and beep reach the UI bus's meter.
    await press(page, "1");
    await expect.poll(async () => (await busApi(page, "UI")).peak, { timeout: 10_000 }).toBeGreaterThan(0.01);
    await expect.poll(async () => (await busInfo(page, "UI")).voices, { timeout: 10_000 }).toBe(0);
  });

  await test.step("muting the Music bus drops its peak", async () => {
    const before = (await busApi(page, "Music")).peak;
    expect(before).toBeGreaterThan(0.01);
    await press(page, "2");
    expect((await busApi(page, "Music")).mute).toBe(true);
    await expect.poll(async () => (await busApi(page, "Music")).peak, { timeout: 15_000 }).toBeLessThan(before * 0.1);
    await press(page, "2");
    expect((await busApi(page, "Music")).mute).toBe(false);
    await expect.poll(async () => (await busApi(page, "Music")).peak, { timeout: 15_000 }).toBeGreaterThan(before * 0.5);
  });

  await test.step("a snapshot changes the bus gains and clears again", async () => {
    const before = await busInfo(page, "Music");
    await press(page, "4"); // Underwater: Music x0.6
    await expect.poll(async () => (await busInfo(page, "Music")).effectiveGain, { timeout: 10_000 }).toBeLessThan(before.effectiveGain * 0.7);
    await press(page, "4");
    await expect.poll(async () => (await busInfo(page, "Music")).effectiveGain, { timeout: 10_000 }).toBeCloseTo(before.effectiveGain, 2);
  });

  await test.step("an SFX sound ducks the Music bus", async () => {
    const base = (await busInfo(page, "Music")).effectiveGain;
    // Sample the ducked gain in the page while the burst plays (it is gone after 0.3 s, plus the release).
    const lowest = await page.evaluate(async () => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { playOneShot(c: string, o?: object): unknown; bus(n: string): { effectiveGain: number } } } }).__myco;
      let min = Infinity;
      Audio.playOneShot("audio/burst.wav", { bus: "SFX" });
      const start = performance.now();
      while (performance.now() - start < 1500) {
        min = Math.min(min, Audio.bus("Music").effectiveGain);
        await new Promise((r) => setTimeout(r, 10));
      }
      return min;
    });
    expect(lowest).toBeLessThan(base * 0.6);
    await expect.poll(async () => (await busInfo(page, "Music")).effectiveGain, { timeout: 10_000 }).toBeCloseTo(base, 2); // the release brings it back
    // The key does the same through the script, and the SFX bus (with its compressor) meters it.
    await press(page, "5");
    await expect.poll(async () => (await busApi(page, "SFX")).peak, { timeout: 10_000 }).toBeGreaterThan(0.01);
  });

  await test.step("the spatial source moves", async () => {
    // The emitter orbits the listener every 4 s, so its distance gain changes while it does.
    const gains = await page.evaluate(async () => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { debug(): { voices: { clip: string; gain: number }[] } } } }).__myco;
      const out: number[] = [];
      for (let i = 0; i < 45; i++) {
        const v = Audio.debug().voices.find((x) => x.clip.includes("hum-loop"));
        if (v) out.push(v.gain);
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });
    expect(gains.length).toBeGreaterThan(30);
    expect(Math.max(...gains) - Math.min(...gains)).toBeGreaterThan(0.005);
  });

  await test.step("the core stayed healthy", async () => {
    const info = (await audioDebug(page))!;
    expect(info.status).toBe("running");
    expect(info.core.backend).toBe("core");
    // Headless Chromium renders in software on the same few cores as the audio thread. On a quiet machine a run sees 0 or
    // 1 underruns (one now and then, never during the quiet start); a loaded one (the full slow suite, other agents) sees
    // more, each beside a stretch where the machine ran none of the page's threads (`hostMonitor`). The bounds are on the
    // core's: those with the host running on time. A real fault (a wedged shell, a mix that can't keep up) underruns
    // continuously (the probe counts about one a second, re-anchoring after each), so a small bound still catches it.
    await page.waitForTimeout(500); // the last poll
    const log = await page.evaluate(() => (globalThis as unknown as { __host: HostLog }).__host);
    const start = underrunsOf(log, startedAt);
    const all = underrunsOf(log);
    console.log(`[audio-core] underruns: ${all.all} (${all.core} with the host on time; at the start ${start.all}, ${start.core}); the host starved ${log.starved.length} times, longest ${Math.round(Math.max(0, ...log.starved.map((s) => s[1])))} ms`);
    expect(start.core, "underruns at the start with the host running on time").toBe(0);
    expect(all.core, "underruns with the host running on time").toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});
