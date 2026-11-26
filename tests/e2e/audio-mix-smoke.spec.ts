import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { expect, test, openEditor, playWithAudio, LAB } from "./fixtures";
import { installFrameClock, mixDebug, sampleBusGain, type MixDebug } from "./audioMix";
import { CAPTURE_FORMAT } from "../../src/plugins/audio/runtime/capture/format";

// M5 smoke (ADR 0171 amended by 0172, plan task S0, H6): the milestone path in the real editor app, through the Sound Lab
// sample, one case per milestone, grown by later waves (each owning task un-fixmes its case in its own wave).
// Today's live case is the bus behaviour M5-0 builds on: the buses exist, a bus's effective gain is the product of its tree,
// and a scripted `fadeTo` (the Sound Lab's Buses page, `scripts/behaviors/Buses.ts`) moves a bus's gain over time, measured
// on the audio clock (the core's rendered frames), never a wall-clock tolerance (ground rules, "Test rules").

test.describe.configure({ timeout: 120_000 });

test("M5 smoke (today): the buses exist, effective gain is the tree's product, and a fadeTo moves the gain over audio frames", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  await installFrameClock(page);

  await test.step("the project's buses exist in the API and in Audio.debug()", async () => {
    const d = (await mixDebug(page))!;
    const names = d.buses.map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(["Master", "Music", "SFX", "Ambience", "UI", "Engine"]));
    const api = await page.evaluate(() => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { buses: readonly string[]; bus(n: string): { exists: boolean } } } }).__myco;
      return { buses: [...Audio.buses], music: Audio.bus("Music").exists, nope: Audio.bus("NoSuchBus").exists };
    });
    expect(api.buses).toEqual(expect.arrayContaining(["Master", "Music", "Engine"]));
    expect(api.music).toBe(true);
    expect(api.nope).toBe(false);
  });

  await test.step("a bus's effective gain reads the product of its tree", async () => {
    // Authored in project.json: Music 0.6 and Engine 0.8, both under Master 1.
    const read = () =>
      page.evaluate(() => {
        const { Audio } = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { effectiveGain: number; volume: number }; debug(): { buses: { name: string; effectiveGain: number }[] } } } }).__myco;
        const row = (n: string) => Audio.debug().buses.find((b) => b.name === n)!.effectiveGain;
        return { music: Audio.bus("Music").effectiveGain, engine: Audio.bus("Engine").effectiveGain, musicRow: row("Music"), engineRow: row("Engine"), master: Audio.bus("Master").effectiveGain };
      });
    const before = await read();
    expect(before.master).toBeCloseTo(1, 6);
    expect(before.music).toBeCloseTo(0.6, 6);
    expect(before.engine).toBeCloseTo(0.8, 6);
    expect(before.musicRow).toBeCloseTo(0.6, 6);
    expect(before.engineRow).toBeCloseTo(0.8, 6);
    // Halving the parent halves every child: the product of the tree, in the API and the debug rows alike.
    await page.evaluate(() => ((globalThis as unknown as { __myco: { Audio: { bus(n: string): { volume: number } } } }).__myco.Audio.bus("Master").volume = 0.5));
    const halved = await read();
    expect(halved.master).toBeCloseTo(0.5, 6);
    expect(halved.music).toBeCloseTo(0.3, 6);
    expect(halved.engine).toBeCloseTo(0.4, 6);
    expect(halved.musicRow).toBeCloseTo(0.3, 6);
    expect(halved.engineRow).toBeCloseTo(0.4, 6);
    await page.evaluate(() => ((globalThis as unknown as { __myco: { Audio: { bus(n: string): { volume: number } } } }).__myco.Audio.bus("Master").volume = 1));
    expect((await read()).music).toBeCloseTo(0.6, 6);
  });

  await test.step("a scripted fadeTo moves the gain over audio frames", async () => {
    // The Buses page's key 3: `Audio.bus("Music").fadeTo(0.25, 0.5)`. Since M5's authored/runtime split (Mx1) `volume` is a
    // multiplier on the authored 0.6, so the bus is heard at 0.6 × 0.25 = 0.15, today's level. Sampled with the core's
    // rendered frame on each read.
    //
    // Nothing here depends on a reading landing inside the ramp (a page stalled under load can miss a half second whole, and
    // since the stamped lanes, Mx2, `Audio.time` steps with STATUS every 48 quanta): the bounds are proofs from the readings
    // that bracket the ramp, the core's own stamp record, and the law on any reading that did land inside.
    const samples = await sampleBusGain(page, "Music", 0.15, 96_000 * 4, `Audio.bus("Music").fadeTo(0.25, 0.5)`, 0.5);
    const rate = (await mixDebug(page))!.sampleRate;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    expect(first.gain).toBeCloseTo(0.6, 6);
    expect(first.rampStart, "no ramp had been stamped on Music yet").toBeUndefined();
    expect(first.frame, "the frame clock is the core's, and runs").toBeGreaterThan(0);
    expect(last.gain, "the fade lands on its target").toBeCloseTo(0.15, 4);
    expect(last.frame - first.frame, "the audio clock ran between the first and last reading").toBeGreaterThan(0);
    // The core's record: one ramp, stamped ahead of the core's frame at the call, and unchanged while it ran.
    const stamp = last.rampStart!;
    expect(stamp, "the core recorded the ramp's start frame").toBeGreaterThan(first.frame);
    for (const s of samples) if (s.rampStart !== undefined) expect(s.rampStart, "one stamp: nothing re-sent while it ran").toBe(stamp);
    // The audio clock ran past the ramp's end (the stamp plus 0.5 s) before the last reading, which is on the target.
    expect(last.timeEnd * rate, "the heard clock is past the ramp's end").toBeGreaterThan(stamp + 0.5 * rate);
    // Monotone, in the API and in the debug row (read just after the API, so between this reading and the next), with the frame never going back.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.frame).toBeGreaterThanOrEqual(samples[i - 1]!.frame);
      expect(samples[i]!.gain).toBeLessThanOrEqual(samples[i - 1]!.gain + 1e-9);
    }
    samples.forEach((s, i) => {
      const next = samples[i + 1]?.gain ?? 0.15;
      expect(s.debugGain).toBeLessThanOrEqual(s.gain + 1e-9);
      expect(s.debugGain).toBeGreaterThanOrEqual(Math.min(next, s.gain) - 1e-9);
    });
    // A half-second fade cannot finish sooner than its length on the heard clock. The last reading still at the start gives
    // a lower bound on the ramp's start, the first at the target an upper bound on its end, so the gap between them holds
    // the whole 0.5 s however sparse the readings were.
    const leftIdx = samples.findIndex((s) => s.gain < 0.6 - 1e-6);
    const landedIdx = samples.findIndex((s) => Math.abs(s.gain - 0.15) < 1e-4);
    expect(leftIdx, "the gain left the start").toBeGreaterThan(0);
    expect(landedIdx).toBeGreaterThanOrEqual(leftIdx);
    expect((samples[landedIdx]!.timeEnd - samples[leftIdx - 1]!.time) * rate, "the fade takes its 0.5 s of audio frames").toBeGreaterThanOrEqual(0.5 * rate - 1);
    // It moved over time, not in one step. Readings inside the ramp lie on its line (0.9 per second of audio clock); when the
    // clock steps over the whole ramp between two readings none lands inside it, and the stepped gap is the evidence instead.
    const inside = samples.filter((s) => s.gain < 0.6 - 1e-3 && s.gain > 0.15 + 1e-3);
    for (let i = 1; i < inside.length; i++) {
      const dt = inside[i]!.time - inside[i - 1]!.time;
      if (dt > 0.02 && inside[i]!.timeEnd === inside[i]!.time && inside[i - 1]!.timeEnd === inside[i - 1]!.time) {
        expect((inside[i - 1]!.gain - inside[i]!.gain) / dt, "linear: 0.45 over 0.5 s").toBeCloseTo(0.9, 1);
      }
    }
    if (inside.length === 0) {
      const a = samples[leftIdx - 1]!;
      const b = samples[landedIdx]!;
      expect(b.timeEnd - a.time, "no reading fell inside the ramp: the heard clock stepped over all of it").toBeGreaterThanOrEqual(0.5);
    }
    // Back up, as the page's key 3 does on its second press: the multiplier returns to 1, heard at the authored 0.6.
    await page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { fadeTo(v: number, s: number): void } } } }).__myco.Audio.bus("Music").fadeTo(1, 0.5));
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { effectiveGain: number } } } }).__myco.Audio.bus("Music").effectiveGain), { timeout: 15_000 }).toBeCloseTo(0.6, 4);
    expect((await mixDebug(page))!.status).toBe("running");
    expect(errors).toEqual([]);
  });
});

// M5-0 (Mx2, then Dp1): the stamped bus path: Mx2's fade case (W3), Dp1's presence duck case (W4).
// The exact first-moving sample is asserted on the loopback host (`laneWriterLoopback.test.ts`); here, the shipped page.
test("M5-0 smoke: a fade lands through the lanes on its stamp", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  await installFrameClock(page);
  type Row = { name: string; effectiveGain: number; lastRampStartFrame?: number };
  type Dbg = MixDebugM5 & { buses: Row[] };
  type MixDebugM5 = { sampleRate: number; musicTotals?: { splitQuanta: number } };
  const read = () =>
    page.evaluate(() => {
      const g = globalThis as unknown as { __myco: { Audio: { debug(): unknown; bus(n: string): { effectiveGain: number } } }; __mixFrame: () => { frame: number } };
      const d = g.__myco.Audio.debug() as Dbg;
      return { frame: g.__mixFrame().frame, gain: g.__myco.Audio.bus("Music").effectiveGain, row: d.buses.find((b) => b.name === "Music")!, split: d.musicTotals?.splitQuanta ?? 0, rate: d.sampleRate };
    });
  const before = await read();
  expect(before.gain).toBeCloseTo(0.6, 6);
  // 1. The Buses page's fade (key 3), from a script: one BUS_RAMP on Music's runtime lane, stamped ahead of the core's frame.
  const called = await page.evaluate(() => {
    const g = globalThis as unknown as { __myco: { Audio: { bus(n: string): { fadeTo(v: number, s: number): void } } }; __mixFrame: () => { frame: number } };
    const frame = g.__mixFrame().frame;
    g.__myco.Audio.bus("Music").fadeTo(0.25, 0.5);
    return frame;
  });
  await expect.poll(async () => (await read()).row.lastRampStartFrame, { timeout: 15_000 }).toBeGreaterThan(0);
  const stamp = (await read()).row.lastRampStartFrame!;
  expect(stamp, "stamped ahead of the core's frame at the call").toBeGreaterThan(called);
  expect(stamp - called, "within the lookahead and the clock's lead (well under 0.5 s)").toBeLessThan(0.5 * before.rate);
  // 2. On the audio clock: once the heard clock (`Audio.time`, which the getters read) is past stamp + 0.5 s, the fade has
  // landed on 0.6 x 0.25. The core's rendered frame runs ahead of the heard clock by the lookahead, so waiting on it alone
  // can read the getter before the end it hears.
  const end = stamp + Math.round(0.5 * before.rate);
  const heard = () => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { time: number } } }).__myco.Audio.time);
  await expect.poll(async () => (await heard()) * before.rate, { timeout: 15_000 }).toBeGreaterThan(end);
  const landed = await read();
  expect(landed.gain, "landed on its target by stamp + duration").toBeCloseTo(0.15, 4);
  expect(landed.row.effectiveGain).toBeCloseTo(0.15, 4);
  expect(landed.row.lastRampStartFrame, "one stamp: nothing re-sent while it ran").toBe(stamp);
  // 3. Applied as a stamp: no quantum split. (Lateness isn't asserted here: a headless page whose main thread stalls past
  // the lookahead can deliver any stamped record late; the loopback case asserts it on a deterministic clock.)
  expect(landed.split).toBe(0);
  // Back up (the key's second press).
  await page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { bus(n: string): { fadeTo(v: number, s: number): void } } } }).__myco.Audio.bus("Music").fadeTo(1, 0.5));
  await expect.poll(async () => (await read()).gain, { timeout: 15_000 }).toBeCloseTo(0.6, 4);
  expect((await read()).row.lastRampStartFrame).toBeGreaterThan(stamp);
  expect(errors).toEqual([]);
});

// Dp1: the Sound Lab ducks Music under SFX by presence (amount 0.3, attack 0.05 s, release 0.4 s). That the BUS_PRESENCE goes
// out stamped at the voice's start frame, and asap at an explicit stop, is `presence.test.ts` (a recording writer); the exact
// first ducked sample is the loopback host's (`presenceLoopback.test.ts`). Here, the shipped page, through the public API: a
// voice played with `at` is due on the core frame `round(at x rate)` (the clock map's `frameOfTime`; this page never replaced
// its context), and `Bus.duckGain` stays 1 in every STATUS block (`Audio.debug().core.currentFrame`) up to that frame's quantum.
test("M5-0 smoke: a presence duck starts on its stamped frame", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  type Handle = { stop(): void };
  type Read = { frame: number; duck: number };
  type G = { __myco: { Audio: { time: number; debug(): MixDebug; bus(n: string): { duckGain: number }; playOneShot(c: string, o: object): Handle } }; __dp1?: Handle };
  /** The core's rebuilds and recoveries (`Audio.debug().core`): a rebuilt core's frames start again at 0, so no frame here compares across one. */
  const rebuilds = () => page.evaluate(() => {
    const core = (globalThis as unknown as G).__myco.Audio.debug().core;
    return Number(core.rebuilds ?? 0) + Number(core.recoveries ?? 0);
  });
  const rebuiltBefore = await rebuilds();
  const before = await page.evaluate(() => (globalThis as unknown as G).__myco.Audio.bus("Music").duckGain);
  expect(before, "nothing on SFX yet: Music not ducked").toBe(1);
  // 1. A quiet voice on SFX, `at` 1 s ahead of the heard clock: its start frame, and so the stamp of its presence. The core's
  //    frame already runs about 0.15 s ahead of the heard clock here (its output latency), and a stamped record reaches the
  //    core with the next engine frame's batch: at 0.3 s ahead, a loaded page that stalled 0.15–0.3 s (seen between two reads
  //    and before the batch went out) delivered the presence late, or left no read before the stamp. 1 s leaves room for that.
  const { stamp, rate } = await page.evaluate(() => {
    const g = globalThis as unknown as G;
    const at = g.__myco.Audio.time + 1;
    const rate = g.__myco.Audio.debug().sampleRate;
    g.__dp1 = g.__myco.Audio.playOneShot("audio/melody-loop.wav", { volume: 0.0001, bus: "SFX", at });
    return { stamp: Math.round(at * rate), rate };
  });
  /** Reads Music's duck with the STATUS frame it came in, every 10 ms, until a block at or past `until` (or, with `stopAtOne`, a duck of 1). */
  const sample = (until: number, stopAtOne: boolean) =>
    page.evaluate(
      async ([limit, one]) => {
        const g = globalThis as unknown as G;
        const out: Read[] = [];
        const read = () => out.push({ frame: Number(g.__myco.Audio.debug().core.currentFrame), duck: g.__myco.Audio.bus("Music").duckGain });
        read();
        while (out.at(-1)!.frame < (limit as number) && !(one && out.at(-1)!.duck === 1)) {
          await new Promise((r) => setTimeout(r, 10));
          read();
        }
        return out;
      },
      [until, stopAtOne] as const,
    );
  // 2. On the core's STATUS frames: Music's duck stays 1 in every block up to the quantum holding the stamp, then falls toward 0.3.
  //    When it began is dated by the duck's own curve, not by when a read happened to land (reads are 10 ms timers on a page
  //    that can stall): the follower moves one pole per quantum (`duck.rs`), so a reading g at frame F, `t` seconds into a move
  //    from `from` toward `goal`, is goal + (from - goal)·exp(-t/τ), and F - τ·sr·ln((from - goal)/(g - goal)) is the frame the
  //    move began. A follower within SETTLE (1e-5) of its goal lands on it, so only readings short of that date a move.
  const SETTLE = 1e-5;
  const AMOUNT = 0.3;
  const ATTACK = 0.05;
  const RELEASE = 0.4;
  const QUANTUM = 128;
  const onset = (r: Read, from: number, goal: number, tau: number) => r.frame - tau * rate * Math.log((from - goal) / (r.duck - goal));
  const reads = await sample(stamp + Math.round(0.5 * rate), false); // 0.5 s: ten attack constants, well inside the 4 s clip
  expect(await rebuilds(), "the core was not rebuilt while the duck was read (its frames would restart at 0)").toBe(rebuiltBefore);
  const q0 = Math.floor(stamp / QUANTUM) * QUANTUM;
  for (const r of reads) if (r.frame <= q0) expect(r.duck, `STATUS frame ${r.frame}, before the stamp's quantum ${q0}`).toBe(1);
  expect(reads.some((r) => r.frame <= q0), "a block before the stamp was read").toBe(true);
  const ducked = reads.filter((r) => r.duck < 1);
  expect(ducked.length, "the duck was read").toBeGreaterThan(0);
  expect(ducked[0]!.frame, "first seen in a block after the stamp's quantum").toBeGreaterThan(q0);
  // The attack begins in the stamp's quantum; a couple of quanta either way allow for the quantum boundary, the per-sample
  // interpolation inside it and f32 rounding of the reading (a dated onset lands within a frame of the quantum here). An attack
  // that waited for a later STATUS or the clip's end misses. A page stalled through the whole attack (reads are 10 ms timers,
  // and 0.3 s gaps happen on a loaded machine) leaves only readings that have landed on the amount, which bound the onset from
  // above by the landing time, ATTACK·ln(0.7/SETTLE) ≈ 0.56 s, so that case allows the stall instead.
  const dating = ducked.find((r) => r.duck - AMOUNT > SETTLE);
  if (dating) {
    const attackStart = onset(dating, 1, AMOUNT, ATTACK);
    expect(Math.abs(attackStart - q0), `the attack began at frame ${Math.round(attackStart)}, on the stamp's quantum ${q0}`).toBeLessThan(2 * QUANTUM);
  } else {
    const latest = ducked[0]!.frame - ATTACK * rate * Math.log((1 - AMOUNT) / SETTLE);
    expect(latest - q0, `no reading inside the attack; landed by frame ${ducked[0]!.frame}, so begun by ${Math.round(latest)}`).toBeLessThan(0.5 * rate);
  }
  expect(reads.at(-1)!.duck, "held near the rule's amount").toBeCloseTo(AMOUNT, 2);
  // 3. An explicit stop clears the presence at once: the duck releases with `release` (0.4 s) back to exactly 1, from the stop on.
  //    It lands on 1 once within SETTLE of it, τ·ln(0.7/SETTLE) ≈ 4.5 s after the release began.
  const settleSeconds = RELEASE * Math.log((1 - AMOUNT) / SETTLE);
  const stopFrame = await page.evaluate(() => {
    const g = globalThis as unknown as G;
    g.__dp1!.stop();
    return Number(g.__myco.Audio.debug().core.currentFrame);
  });
  const after = await sample(stopFrame + Math.round((settleSeconds + 4) * rate), true);
  expect(await rebuilds(), "nor while the release was read").toBe(rebuiltBefore);
  expect(after.at(-1)!.duck, "released to 1").toBe(1);
  const datingRelease = after.find((r) => r.duck - AMOUNT > 0.01 && 1 - r.duck > SETTLE);
  expect(datingRelease, "a reading inside the release, to date it").toBeDefined();
  const held = Math.min(...after.filter((r) => r.frame <= datingRelease!.frame).map((r) => r.duck)); // the gain it released from
  const releaseStart = onset(datingRelease!, held, 1, RELEASE);
  // asap: a stop goes out unstamped with the next engine frame's batch, so the release begins a lookahead, a STATUS interval
  // (`stopFrame` is the newest block's, up to 48 quanta old) and any main-thread stall after the stop: up to 0.5 s seen on a
  // loaded machine. Waiting for the voice's end instead would begin it at the 4 s clip's end, at least 3.5 s after the stop.
  expect(releaseStart - stopFrame, `asap: the release began at frame ${Math.round(releaseStart)}, soon after the stop at ${stopFrame}`).toBeLessThan(1 * rate);
  expect(releaseStart, "well before the clip's end").toBeLessThan(stamp + 3 * rate);
  expect(releaseStart - stopFrame, "and not before the stop").toBeGreaterThan(-4 * QUANTUM);
  expect(after.at(-1)!.frame - releaseStart, "back at 1 when the release settles (a read a STATUS block or a stalled timer later)").toBeLessThan((settleSeconds + 1) * rate);
  expect(errors).toEqual([]);
});

// M5a (Rc4): capture. A game that never calls `start` loads no recorder chunk; `Audio.capture.start()` fetches it, a take
// records the core's STATUS blocks while the audio clock runs, and `save()` downloads a deflate-raw `.sporesample` whose header
// parses and whose records are the take's. Every bound is on the core's rendered frames, never a wall-clock tolerance.
test("M5a smoke: a capture starts, stops, is saved and is non-empty", async ({ page }) => {
  type CaptureApi = { state: string; seconds: number; bytes: number; start(): Promise<void>; stop(): void; mark(t: string): void; save(n?: string): Promise<string> };
  type Api = { __myco: { Audio: { capture: CaptureApi; playOneShot(c: string, o?: object): unknown } }; __mixFrame: () => { frame: number } };
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("request", (req) => requests.push(req.url()));
  const isRecorderChunk = (url: string) => /(^|\/)recorder[-.][\w-]*\.js|capture\/recorder(\.ts)?(\?|$)/.test(url);
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  await installFrameClock(page);
  const rate = (await mixDebug(page))!.sampleRate;

  await test.step("before start() nothing of the recorder is loaded", async () => {
    expect(requests.filter(isRecorderChunk), "no recorder chunk requested while the page only plays").toEqual([]);
    const idle = await page.evaluate(() => {
      const c = (globalThis as unknown as Api).__myco.Audio.capture;
      return { state: c.state, seconds: c.seconds, bytes: c.bytes };
    });
    expect(idle).toEqual({ state: "idle", seconds: 0, bytes: 0 });
    // The empty save is refused, and refusing it loads nothing.
    const refused = await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.save().then(() => "saved", (e: Error) => e.message));
    expect(refused).toBe("nothing recorded: call Audio.capture.start() first");
    expect(requests.filter(isRecorderChunk)).toEqual([]);
  });

  let startFrame = 0;
  await test.step("start() fetches the chunk and begins a take; the audio clock runs with sound playing", async () => {
    await page.evaluate(() => void (globalThis as unknown as Api).__myco.Audio.playOneShot("audio/melody-loop.wav", { volume: 0.05, bus: "UI" }));
    await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.start());
    expect(requests.filter(isRecorderChunk).length, "the recorder chunk was fetched by start()").toBeGreaterThan(0);
    const now = await page.evaluate(() => {
      const g = globalThis as unknown as Api;
      return { state: g.__myco.Audio.capture.state, frame: g.__mixFrame().frame };
    });
    expect(now.state).toBe("recording");
    startFrame = now.frame;
    // Three seconds of the core's rendered frames (the poll only paces the reads).
    await page.waitForFunction(([from, span]) => (globalThis as unknown as Api).__mixFrame().frame - (from as number) >= (span as number), [startFrame, 3 * rate] as const, { timeout: 60_000 });
    await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.mark("smoke marker"));
    await page.waitForFunction(([from, span]) => (globalThis as unknown as Api).__mixFrame().frame - (from as number) >= (span as number), [startFrame, 3.2 * rate] as const, { timeout: 60_000 });
    const c = await page.evaluate(() => {
      const cap = (globalThis as unknown as Api).__myco.Audio.capture;
      return { state: cap.state, seconds: cap.seconds, bytes: cap.bytes };
    });
    expect(c.state).toBe("recording");
    expect(c.bytes, "the ring holds the take's records").toBeGreaterThan(10_000);
    expect(c.seconds, "the ring's content is the rendered frames since the start, in seconds").toBeGreaterThan(2);
  });

  await test.step("stop() holds the take and save() downloads a .sporesample whose header parses and whose records are the take's", async () => {
    await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.stop());
    expect(await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.state)).toBe("stopped");
    const [download, name] = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.save("smoke / take 1")),
    ]);
    expect(name).toBe("smoke_take_1.sporesample");
    expect(download.suggestedFilename()).toBe("smoke_take_1.sporesample");
    const bytes = readFileSync((await download.path())!);
    expect(bytes.byteLength, "non-empty").toBeGreaterThan(96 + 1000);
    // The 96 B plain header (§5.1).
    expect([...bytes.subarray(0, 8)]).toEqual([0x4d, 0x59, 0x43, 0x41, 0x50, 0x00, 0x01, 0x1a]);
    expect(bytes.readUInt16LE(8), "format").toBe(CAPTURE_FORMAT);
    const flags = bytes.readUInt16LE(10);
    expect(flags & 0b1000, "compressed (deflate-raw)").toBeTruthy();
    expect(flags & 0b0100, "hasIndex").toBeTruthy();
    expect(flags & 0b0001, "not truncated").toBe(0);
    expect(bytes.readUInt32LE(40), "sampleRate").toBe(rate);
    const metaBytes = bytes.readUInt32LE(60);
    const recordBytes = bytes.readUInt32LE(64);
    const uncompressed = bytes.readUInt32LE(68);
    const recordCount = bytes.readUInt32LE(72);
    expect(metaBytes + recordBytes).toBe(uncompressed);
    expect(recordCount, "EPOCH, keyframes, STATUS blocks and the INDEX").toBeGreaterThan(20);
    const payload = inflateRawSync(bytes.subarray(96));
    expect(payload.byteLength).toBe(uncompressed);
    // META is JSON data naming the project's audio section.
    const meta = JSON.parse(payload.subarray(0, metaBytes).toString("utf8")) as { engine: string; audio: { buses?: unknown[] } };
    expect(meta.engine).toBe("myco");
    expect(meta.audio.buses?.length ?? 0).toBeGreaterThan(0);
    // The records: head by head, 20 B each (§5.3).
    const types: number[] = [];
    const statusFrames: number[] = [];
    let marker = "";
    for (let off = metaBytes; off < payload.byteLength; ) {
      const type = payload.readUInt8(off);
      const len = payload.readUInt32LE(off + 4);
      types.push(type);
      if (type === 0x03) statusFrames.push(payload.readDoubleLE(off + 12));
      if (type === 0x06) marker = payload.subarray(off + 20 + 10, off + 20 + 10 + payload.readUInt16LE(off + 20 + 8)).toString("utf8");
      off += 20 + len;
    }
    expect(types.length, "the header's record count is the records").toBe(recordCount);
    expect(types[0], "EPOCH start leads").toBe(0x01);
    // The keyframe's names (NAMES, 0x07) come before it, since the keyframe refers to them (G7b's keyframe source).
    expect(types.slice(1).find((t) => t !== 0x07), "then a KEYFRAME, after the NAMES it refers to").toBe(0x04);
    expect(types[types.length - 1], "the INDEX closes the file").toBe(0x7f);
    expect(types.filter((t) => t === 0x04).length, "a keyframe a second of rendered frames").toBeGreaterThanOrEqual(3);
    expect(marker).toBe("smoke marker");
    // STATUS comes at least every 48 quanta (6,144 frames) even idle, and every 6 while the core is busy: the floor is the idle cadence.
    expect(statusFrames.length, "a STATUS block at least every 48 quanta of the frames that ran").toBeGreaterThanOrEqual(Math.floor((2.5 * rate) / (48 * 128)));
    for (let i = 1; i < statusFrames.length; i++) expect(statusFrames[i]).toBeGreaterThan(statusFrames[i - 1]!);
    expect(statusFrames[statusFrames.length - 1]! - statusFrames[0]!, "the take spans the audio frames that ran").toBeGreaterThan(2.5 * rate);
    expect(statusFrames[0]!, "the take starts at or after the call, at the keyframe before it at most a second earlier").toBeGreaterThanOrEqual(startFrame - rate - 768);
  });

  expect(errors).toEqual([]);
});

// M5b (E2, un-fixme'd in W8): loudness. The shipped Sound Lab plays its music loop and a hum from the first frame, so master's
// meter has signal with no key pressed; the readings come from the public API (`Audio.bus("Master").loudness`), which is also
// what `Audio.debug()`'s bus rows are built beside (the rows carry the peak meter, the loudness reading is `Bus.loudness`).
// Every wait is on the meter's own `elapsed` (seconds of rendered audio since its last reset), never a wall-clock span; the
// -22.99 LUFS tone, the targets, resets, pause, taint and the ladder are `audio-mix-b.spec.ts`.
test("M5b smoke: master's momentary loudness reads a number, steadily, and is empty right after a reset", async ({ page }) => {
  type Loud = { momentary: number; shortTerm: number; integrated: number; elapsed: number; metered: boolean; reset(w?: string): void };
  type Api = { __myco: { Audio: { time: number; bus(n: string): { loudness: Loud } } } };
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  const master = () =>
    page.evaluate(() => {
      const m = (globalThis as unknown as Api).__myco.Audio.bus("Master").loudness;
      return { momentary: m.momentary, shortTerm: m.shortTerm, integrated: m.integrated, elapsed: m.elapsed, metered: m.metered };
    });

  await test.step("the page's loop is playing, so master's momentary level is a finite number below 0 LUFS", async () => {
    expect((await master()).metered, "master is always metered").toBe(true);
    await expect.poll(async () => (await master()).momentary, { timeout: 30_000, message: "momentary has its four sub-blocks of rendered audio" }).toBeGreaterThan(-70);
    const m = await master();
    expect(Number.isFinite(m.momentary)).toBe(true);
    expect(m.momentary).toBeLessThan(0);
    expect(m.integrated, "integrated is a number once a 400 ms block passes the gate").toBeGreaterThan(-70);
  });

  await test.step("a steady loop reads about the same a few seconds of audio later", async () => {
    // 8 s of rendered audio since Play: the 3 s short-term window lies wholly after the clips' decode and start, so both reads
    // see the loop and not its beginning.
    await expect.poll(async () => (await master()).elapsed, { timeout: 60_000, message: "8 s of metered audio" }).toBeGreaterThanOrEqual(8);
    const a = await master();
    expect(a.shortTerm).toBeGreaterThan(-70);
    await expect.poll(async () => (await master()).elapsed, { timeout: 60_000 }).toBeGreaterThanOrEqual(a.elapsed + 2);
    const b = await master();
    expect(Math.abs(b.shortTerm - a.shortTerm), "short-term LUFS of a steady loop (a moving hum allows a little)").toBeLessThan(2);
    expect(Math.abs(b.integrated - a.integrated)).toBeLessThan(2);
  });

  await test.step("right after a reset the readings are empty (-Infinity, not 0 or NaN), and fill from the audio that follows", async () => {
    const r = await page.evaluate(() => {
      const m = (globalThis as unknown as Api).__myco.Audio.bus("Master").loudness;
      m.reset("all");
      return { momentary: m.momentary, shortTerm: m.shortTerm, integrated: m.integrated, elapsed: m.elapsed };
    });
    expect(r).toEqual({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, elapsed: 0 });
    await expect.poll(async () => (await master()).elapsed, { timeout: 30_000 }).toBeGreaterThanOrEqual(0.5);
    const after = await master();
    expect(Number.isFinite(after.momentary)).toBe(true);
    expect(after.shortTerm, "short-term needs 3 s").toBe(-Infinity);
  });
  expect(errors).toEqual([]);
});
