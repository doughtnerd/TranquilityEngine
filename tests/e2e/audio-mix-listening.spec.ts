import { expect, type Page, play, test, openEditor, playWithAudio, LAB } from "./fixtures";
import { mixDebug } from "./audioMix";
import { fader, openAudioSettings, openLabCopy, openMixer, savedProject } from "./audioMixLive";

// The M5 listening sections (ADR 0171 amended by 0172; waves plan, "Owner procedures"), one case per milestone, each an owner-run
// page and a headless walker in one (the shape of `audio-music-listening.spec.ts`). Today: **M5-0**, the stamped bus path: a
// scripted fade and a snapshot landing on their stamp, a presence duck on the sound's own frame, and a muted bus with a reverb
// send going silent, post-fader. The owner's section is `docs/design/0171-audio-mix/listening-notes/m5-0.md`; this file's steps
// carry the same numbers (S1 to S6).
//
//   headless (the smoke check, default):   npm run test:e2e:slow -- audio-mix-listening
//   the owner's mode, headphones, headed:   E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5-0 \(owner"
//
// The page is the Sound Lab's main page as it ships (the keys are the sample's own: B drums on Music, A noise on Ambience, 2 and N
// mute Music and Ambience, 3 and Z fade them, 4 the Underwater snapshot, 5 a burst on SFX, X the same burst scheduled 1 s ahead).
// The walker adds nothing the sample doesn't have but a recorder: a capture-phase key listener that logs each press and a 10 ms
// sampler of what the public API reports: the heard clock (`Audio.time`), the core's STATUS frame (`Audio.debug().core.currentFrame`),
// Music's duck (`Bus.duckGain`), the buses' effective gains, the stamp of each bus's last ramp (`lastRampStartFrame`) and the meters.
// Every timing assertion is on the audio clock (the core's STATUS frame, `Audio.time`, the stamps); the real-time intervals only pace
// the reads. In the owner's mode a step waits for the owner's key (the recorder sees it) and then reads what the page did, and fails
// if it did not run as built. What main writes for each change (one BUS_RAMP per lane that moved, its gain, low-pass and length, a
// snapshot's buses at one stamp; a presence record stamped at the voice's start frame, the PLAY at the same frame) is the unit tests'
// (`laneWriter.test.ts`, `presence.test.ts`, `voices.test.ts`), each driving its module through its own interface.
//
// **Owner mode, what it also covers (ground rules, "the walker also runs in the owner's mode"):** the `M5-0 (listen mode)` case
// presses the same keys at human pace (seconds between keys), one key late (after the page sat idle, so STATUS idles at 48 quanta),
// one key twice (two separate presses) and one key held (auto-repeat: it must act once), and checks the same landings.
//
// **What the walker cannot do:** hear. Headless Chromium has no sound output; it reads the lane values, the duck, the stamps and the
// core's meters. A click, a zipper or a thin spectrum is the owner's ear (and the objective `maxStep` checks of the goldens). The
// snapshot's low-pass is the owner's ear here and `laneWriter.test.ts`'s records; the walker checks its stamp and its gains.

const LISTEN = process.env.E2E_LISTEN === "1";
test.describe.configure({ timeout: LISTEN ? 3_600_000 : 240_000 });

type Press = { key: string; repeat: boolean; time: number; frame: number };
type Read = { frame: number; time: number; duck: number; music: number; ambience: number; sfxPeak: number; masterPeak: number; musicPeak: number; musicStamp: number | null; sfxStamp: number | null };
type Row = { name: string; effectiveGain: number; peakL: number; lastRampStartFrame?: number };
type Dbg = { sampleRate: number; buses: Row[]; voices: { id: number; clip: string; bus: string; state: string }[]; musicTotals?: { splitQuanta?: number }; counters: { underruns: number }; core: Record<string, number | string | boolean> };
type M50 = { presses: Press[]; reads: Read[] };

type Globals = { __myco: { Audio: { time: number; debug(): Dbg; buses: readonly string[]; bus(n: string): { effectiveGain: number; duckGain: number; peak: number } } } };

/** Installs the recorder: key log, the 10 ms sampler, and (owner mode) the card. */
async function installM50(page: Page, card: boolean): Promise<void> {
  await page.evaluate((showCard) => {
    const g = globalThis as unknown as Globals & { __m50?: M50 };
    const { Audio } = g.__myco;
    const st: M50 = { presses: [], reads: [] };
    g.__m50 = st;
    const now = () => Number(Audio.debug().core.currentFrame);
    window.addEventListener(
      "keydown",
      (e) => {
        st.presses.push({ key: e.key.toLowerCase(), repeat: e.repeat, time: Audio.time, frame: now() });
      },
      { capture: true },
    );
    setInterval(() => {
      const d = Audio.debug();
      const row = (n: string) => d.buses.find((b) => b.name === n)!;
      if (st.reads.length > 60_000) st.reads.splice(0, 10_000);
      st.reads.push({
        frame: Number(d.core.currentFrame),
        time: Audio.time,
        duck: Audio.bus("Music").duckGain,
        music: Audio.bus("Music").effectiveGain,
        ambience: Audio.bus("Ambience").effectiveGain,
        sfxPeak: row("SFX").peakL,
        masterPeak: row("Master").peakL,
        musicPeak: row("Music").peakL,
        musicStamp: row("Music").lastRampStartFrame ?? null,
        sfxStamp: row("SFX").lastRampStartFrame ?? null,
      });
    }, 10);
    if (showCard) {
      const el = document.createElement("pre");
      el.style.cssText = "position:fixed;z-index:99999;left:12px;top:12px;margin:0;padding:10px 14px;background:#000d;color:#fff;font:14px/1.45 monospace;border-radius:6px;pointer-events:none;max-width:80vw;white-space:pre-wrap";
      el.textContent = "M5-0: the stamped bus path (docs/design/0171-audio-mix/listening-notes/m5-0.md)\nP pause the tone  B drums  3 fade  4 snapshot  5 burst  X burst 1 s ahead\nA noise  2 mute Music  N mute Ambience\nThe terminal says which key, then checks what the page did.";
      document.body.append(el);
    }
  }, card);
}

const dbg = async (page: Page) => (await mixDebug(page)) as unknown as Dbg;
const audioTime = (page: Page) => page.evaluate(() => (globalThis as unknown as Globals).__myco.Audio.time);
const frameNow = (page: Page) => page.evaluate(() => (globalThis as unknown as { __m50: M50 }).__m50.reads.at(-1)!.frame);
const row = async (page: Page, bus: string) => (await dbg(page)).buses.find((b) => b.name === bus)!;

/** Waits on the audio clock: until `Audio.time` passes `t` (the reads pace in real time, the condition is heard time). */
const untilTime = (page: Page, t: number, timeout = 30_000) => page.waitForFunction((x) => (globalThis as unknown as Globals).__myco.Audio.time > x, t, { timeout, polling: 50 });

/** The highest meter reading of a bus over `seconds` of the audio clock, from the sampler. */
async function peakOver(page: Page, field: "masterPeak" | "musicPeak" | "sfxPeak", seconds: number): Promise<number> {
  const t0 = await audioTime(page);
  await untilTime(page, t0 + seconds);
  return page.evaluate(([f, from]) => Math.max(0, ...(globalThis as unknown as { __m50: M50 }).__m50.reads.filter((r) => r.time >= (from as number)).map((r) => r[f as "masterPeak"])), [field, t0] as const);
}

/** A key: the owner's (waited for) or the walker's own press. Resolves with the press record the page's key listener logged. */
async function press(page: Page, key: string, hint: string, o: { human?: boolean } = {}): Promise<Press> {
  const before = await page.evaluate(() => (globalThis as unknown as { __m50: M50 }).__m50.presses.length);
  if (LISTEN && !o.human) process.stdout.write(`\n[listen] M5-0: press ${key.toUpperCase()} in the page. ${hint}\n`);
  else await page.keyboard.press(key);
  await page.waitForFunction(([k, n]) => (globalThis as unknown as { __m50: M50 }).__m50.presses.slice(n as number).some((p) => p.key === k && !p.repeat), [key, before] as const, { timeout: LISTEN ? 3_600_000 : 20_000 });
  return page.evaluate(([k, n]) => (globalThis as unknown as { __m50: M50 }).__m50.presses.slice(n as number).find((p) => p.key === k && !p.repeat)!, [key, before] as const);
}

const readsSince = (page: Page, t: number) => page.evaluate((from) => (globalThis as unknown as { __m50: M50 }).__m50.reads.filter((r) => r.time >= from), t);
/** Each distinct stamp a bus row showed since `t` (heard time), in the order the sampler saw them. */
const stampsSince = async (page: Page, field: "musicStamp" | "sfxStamp", t: number, than: number): Promise<number[]> => {
  const out: number[] = [];
  for (const r of await readsSince(page, t)) {
    const s = r[field];
    if (s !== null && s > than && s !== out.at(-1)) out.push(s);
  }
  return out;
};

/** The next BUS_RAMP stamp on a bus row: waits until `lastRampStartFrame` moves past `than`. */
async function stampOf(page: Page, bus: string, than: number): Promise<number> {
  await expect.poll(async () => (await row(page, bus)).lastRampStartFrame ?? 0, { timeout: 15_000, message: `${bus}: a stamped ramp went out` }).toBeGreaterThan(than);
  return (await row(page, bus)).lastRampStartFrame!;
}

const settle = async (page: Page, bus: string, to: number, seconds = 15) => {
  await expect.poll(() => page.evaluate((b) => (globalThis as unknown as Globals).__myco.Audio.bus(b).effectiveGain, bus), { timeout: seconds * 1000 }).toBeCloseTo(to, 4);
};

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  await installM50(page, LISTEN);
  // The clips decode on their first play; the drums and the noise start from their keys.
  await page.waitForTimeout(1000);
  return errors;
}

/** Every duck-lane sample and the Music bus's effective gain over a window of the heard clock. */
const duckSeries = (reads: Read[]) => ({ min: Math.min(...reads.map((r) => r.duck)), minGain: Math.min(...reads.map((r) => r.music)) });

/**
 * The X key's burst is played with `at: Audio.time + 1` in the game's update after the key: its start frame is at least
 * `round((press.time + 1) x rate)` (the press's heard clock, read just before) and at most a few game frames later.
 */
const scheduledFrom = (t: Press, rate: number) => Math.round((t.time + 1) * rate);

test.describe("listening M5-0: the stamped bus path", () => {
  // One page at a time: two software-GL pages on this machine starve each other (the core underruns, which a headless walk cannot judge).
  test.describe.configure({ mode: "serial" });

  test("M5-0 (owner or headless): a fade and a snapshot on their stamp, a presence duck on the sound's own frame, a muted bus's send silent post-fader", { tag: "@slow" }, async ({ page }) => {
    const errors = await boot(page);
    const rate = (await dbg(page)).sampleRate;
    const split0 = (await dbg(page)).musicTotals?.splitQuanta ?? 0;

    await test.step("S0 setup: the tone is paused (P) and the drums play on Music (B), the project's hum plays on Ambience", async () => {
      await press(page, "p", "Pauses the Music tone so the drums are the only thing on Music.");
      await press(page, "b", "Starts the drum loop on the Music bus: a kick, a snare and hats, 120 bpm.");
      await expect.poll(async () => (await dbg(page)).voices.some((v) => v.clip.includes("drum-loop") && v.bus === "Music" && v.state === "playing"), { timeout: 15_000 }).toBe(true);
      expect(await peakOver(page, "musicPeak", 1.2), "the drums are on the Music meter").toBeGreaterThan(0.02);
      expect((await row(page, "Music")).effectiveGain).toBeCloseTo(0.6, 6);
    });

    await test.step("S1 key 3: a scripted fade lands on its stamp, down over 0.5 s to a quarter and back up", async () => {
      const base = (await row(page, "Music")).lastRampStartFrame ?? 0;
      const before = await peakOver(page, "musicPeak", 1.2);
      const t = await press(page, "3", "Fades Music (the drums) to a quarter over half a second, from about a tenth of a second after the key.");
      const stamp = await stampOf(page, "Music", base);
      expect(stamp, "stamped ahead of the core's frame at the key").toBeGreaterThan(t.frame);
      expect(stamp - t.frame, "within the lookahead and the clock's lead").toBeLessThan(0.5 * rate);
      // On the audio clock: landed by stamp + 0.5 s (the core has rendered past it), monotone, not in one step.
      await expect.poll(() => frameNow(page), { timeout: 15_000 }).toBeGreaterThan(stamp + Math.round(0.5 * rate));
      await settle(page, "Music", 0.15);
      expect(await stampsSince(page, "musicStamp", t.time, base), "one stamped ramp on Music, nothing re-sent while it ran").toEqual([stamp]);
      const reads = (await readsSince(page, t.time)).filter((r) => r.music > 0);
      for (let i = 1; i < reads.length; i++) expect(reads[i]!.music, "never rises while fading down").toBeLessThanOrEqual(reads[i - 1]!.music + 1e-9);
      const left = reads.find((r) => r.music < 0.6 - 1e-3)!;
      const landed = reads.find((r) => Math.abs(r.music - 0.15) < 1e-4)!;
      expect(reads.some((r) => r.music < 0.6 - 1e-3 && r.music > 0.15 + 1e-3), "an intermediate level was read").toBe(true);
      expect((landed.time - left.time) * rate, "takes about its 0.5 s of audio frames").toBeGreaterThanOrEqual(0.4 * rate);
      const after = await peakOver(page, "musicPeak", 1.2);
      expect(after, "the Music meter fell to about a quarter").toBeLessThan(before * 0.5);
      // Back up: the key's second press.
      const base2 = (await row(page, "Music")).lastRampStartFrame!;
      await press(page, "3", "Brings Music back up over half a second.");
      const stamp2 = await stampOf(page, "Music", base2);
      expect(stamp2).toBeGreaterThan(stamp);
      await settle(page, "Music", 0.6);
      expect((await dbg(page)).musicTotals?.splitQuanta ?? 0, "stamped, so no quantum split").toBe(split0);
    });

    await test.step("S2 key 4: the Underwater snapshot's ramps land on one stamp (Music, SFX and Ambience together), and key 4 again clears it", async () => {
      const base = (await row(page, "Music")).lastRampStartFrame ?? 0;
      const t = await press(page, "4", "Underwater: the drums go muffled and quieter, the hum and noise too, over half a second. Press again afterwards to clear it.");
      const stamp = await stampOf(page, "Music", base);
      expect(stamp).toBeGreaterThan(t.frame);
      // Every bus the snapshot touches shows the same stamp (SFX's ramp is its low-pass only).
      await expect.poll(async () => (await row(page, "Ambience")).lastRampStartFrame, { timeout: 15_000, message: "the Ambience row shows the same stamp" }).toBe(stamp);
      await expect.poll(async () => (await row(page, "SFX")).lastRampStartFrame, { timeout: 15_000, message: "the SFX row shows the same stamp" }).toBe(stamp);
      await expect.poll(() => frameNow(page), { timeout: 15_000 }).toBeGreaterThan(stamp + Math.round(0.5 * rate));
      await settle(page, "Music", 0.36);
      await settle(page, "Ambience", 0.4);
      await settle(page, "SFX", 1);
      // Clear.
      const base1 = (await row(page, "Music")).lastRampStartFrame!;
      await press(page, "4", "Clears the snapshot: the sound opens up again.");
      const stamp1 = await stampOf(page, "Music", base1);
      expect(stamp1, "the clear is a new ramp on Music's row").toBeGreaterThan(stamp);
      await settle(page, "Music", 0.6);
      await settle(page, "Ambience", 0.8);
    });

    // The duck steps need the duck lane at rest.
    const duckRest = () => expect.poll(() => page.evaluate(() => (globalThis as unknown as Globals).__myco.Audio.bus("Music").duckGain), { timeout: 15_000 }).toBe(1);

    await test.step("S3 key 5: a burst on SFX ducks Music to the rule's 0.3 and releases it", async () => {
      await duckRest();
      const t = await press(page, "5", "A noise burst; the drums dip hard under it at once and swell back after it ends, over about half a second.");
      await expect.poll(() => page.evaluate((from) => (globalThis as unknown as { __m50: M50 }).__m50.reads.filter((r) => r.time >= from).some((r) => r.duck < 0.35), t.time), { timeout: 10_000, message: "the duck reached the rule's amount" }).toBe(true);
      await duckRest();
      const reads = await readsSince(page, t.time);
      const { min, minGain } = duckSeries(reads);
      expect(min, "held near amount 0.3").toBeLessThan(0.35);
      expect(min).toBeGreaterThan(0.28);
      expect(minGain, "Music's effective gain follows: 0.6 x 0.3").toBeLessThan(0.2);
      const first = reads.find((r) => r.duck < 1)!;
      expect(first.frame, "no duck before the key").toBeGreaterThan(t.frame);
      expect(reads.some((r) => r.sfxPeak > 0.01), "the burst was on the SFX meter").toBe(true);
      expect(reads[reads.length - 1]!.duck, "released to 1 once the burst ended").toBeGreaterThan(0.999);
    });

    await test.step("S4 key X: the same burst scheduled 1 s ahead: Music ducks on the burst's own frame, not before and not after", async () => {
      await duckRest();
      const t = await press(page, "x", "The burst sounds one second after the key. The drums must dip exactly as it hits: no dip before it, no full-level drums under its first instant.");
      const earliest = scheduledFrom(t, rate);
      await expect.poll(() => frameNow(page), { timeout: 20_000 }).toBeGreaterThan(earliest + Math.round(0.6 * rate));
      const q0 = Math.floor(earliest / 128) * 128;
      const reads = await readsSince(page, t.time);
      expect(reads.some((r) => r.frame > t.frame && r.frame <= q0), "blocks between the key and the burst's frame were read").toBe(true);
      for (const r of reads) if (r.frame <= q0) expect(r.duck, `STATUS frame ${r.frame}, before the burst's frame ${earliest}`).toBe(1);
      for (const r of reads) if (r.frame <= q0) expect(r.sfxPeak, `the burst is not heard before its frame (${r.frame})`).toBeLessThan(0.01);
      const ducked = reads.find((r) => r.duck < 1)!;
      expect(ducked, "the duck was read").toBeTruthy();
      const heard = reads.find((r) => r.sfxPeak > 0.01)!;
      expect(heard, "the burst reached the SFX meter").toBeTruthy();
      expect(ducked.frame, "first seen in a block after the burst's earliest frame").toBeGreaterThan(q0);
      expect(heard.frame, "the burst reaches the SFX meter after its frame, not before").toBeGreaterThan(q0);
      // On the sound's own frame: the duck and the burst show up together, within a couple of STATUS blocks (6 quanta each).
      expect(Math.abs(ducked.frame - heard.frame), "the duck starts with the burst").toBeLessThanOrEqual(2 * 6 * 128);
      expect(ducked.frame - earliest, "a second after the key, within a few game frames").toBeLessThan(0.5 * rate);
      await duckRest();
    });

    await test.step("S5 keys A, 2, N: a muted bus's reverb send goes silent after its tail (post-fader), and unmuting brings it back", async () => {
      await press(page, "a", "Starts a looping noise on Ambience, whose bus sends to the reverb: noise in a room, with the project's hum.");
      await press(page, "2", "Mutes Music so only Ambience is heard (the noise, its room, the hum).");
      await expect.poll(async () => (await row(page, "Music")).effectiveGain, { timeout: 10_000 }).toBe(0);
      expect(await peakOver(page, "masterPeak", 1.5), "Ambience alone is audible on the master meter").toBeGreaterThan(0.02);
      const t = await press(page, "n", "Mutes Ambience: the noise stops at once, its room rings out over about two seconds and then the page is silent. A hiss that stays under silence is the defect.");
      await expect.poll(async () => (await row(page, "Ambience")).effectiveGain, { timeout: 10_000 }).toBe(0);
      expect((await dbg(page)).voices.filter((v) => v.bus === "Ambience").every((v) => v.state === "busMuted"), "its voices are bus-muted").toBe(true);
      const mutedAt = await audioTime(page);
      await untilTime(page, mutedAt + 5);
      const reads = await readsSince(page, t.time);
      expect(Math.max(...reads.filter((r) => r.time < t.time + 0.6).map((r) => r.masterPeak)), "the tail rings out (the send isn't cut with the fader)").toBeGreaterThan(0.005);
      expect(Math.max(...reads.filter((r) => r.time > t.time + 4).map((r) => r.masterPeak)), "silent once the tail is out: the send is post-fader").toBeLessThan(0.002);
      // Unmute: the noise and its room return.
      await press(page, "n", "Unmutes Ambience: the noise comes back, with its room, with no click.");
      await expect.poll(async () => (await row(page, "Ambience")).effectiveGain, { timeout: 10_000 }).toBeCloseTo(0.8, 6);
      expect(await peakOver(page, "masterPeak", 1.5)).toBeGreaterThan(0.02);
      // Put the page back: Music on, noise off, drums off, tone on.
      await press(page, "2", "Unmutes Music.");
      await press(page, "a", "Stops the noise.");
      await press(page, "b", "Stops the drums.");
      await press(page, "p", "Resumes the Music tone.");
      await expect.poll(async () => (await row(page, "Music")).effectiveGain, { timeout: 10_000 }).toBeCloseTo(0.6, 6);
    });

    expect(errors).toEqual([]);
  });

  test("M5-0 (listen mode): the same keys at human pace, one late, one twice, one held", { tag: "@slow" }, async ({ page }) => {
    test.skip(LISTEN, "the owner's mode is the case above; this one paces the keys itself");
    const errors = await boot(page);
    const rate = (await dbg(page)).sampleRate;
    const human = { human: true } as const;
    // The pace is wall time (a person's); the checks are on the audio clock.
    const think = (seconds: number) => page.waitForTimeout(seconds * 1000);
    const duckRest = () => expect.poll(() => page.evaluate(() => (globalThis as unknown as Globals).__myco.Audio.bus("Music").duckGain), { timeout: 15_000 }).toBe(1);

    await test.step("a late key: the page sat idle for 12 s (STATUS idles), then key 3 still stamps ahead and lands on its length", async () => {
      await press(page, "p", "", human);
      await press(page, "b", "", human);
      await think(12);
      const base = (await row(page, "Music")).lastRampStartFrame ?? 0;
      const t = await press(page, "3", "", human);
      const stamp = await stampOf(page, "Music", base);
      expect(stamp, "stamped ahead of the frame the key saw").toBeGreaterThan(t.frame);
      expect(stamp - t.frame, "a late key's stamp stays within a fraction of a second of the last STATUS frame").toBeLessThan(0.75 * rate);
      await expect.poll(() => frameNow(page), { timeout: 15_000 }).toBeGreaterThan(stamp + Math.round(0.5 * rate));
      await settle(page, "Music", 0.15);
    });

    await test.step("a key twice: 3 again after a human pause, then 4 and 4, then 5 and X each after the last one settled", async () => {
      await think(2);
      const base = (await row(page, "Music")).lastRampStartFrame!;
      await press(page, "3", "", human);
      const stamp = await stampOf(page, "Music", base);
      await settle(page, "Music", 0.6);
      expect(stamp).toBeGreaterThan(base);
      await think(2);
      await press(page, "4", "", human);
      await settle(page, "Music", 0.36);
      await think(2);
      await press(page, "4", "", human);
      await settle(page, "Music", 0.6);
      await think(2);
      await duckRest();
      const t5 = await press(page, "5", "", human);
      await expect.poll(() => page.evaluate((from) => (globalThis as unknown as { __m50: M50 }).__m50.reads.filter((r) => r.time >= from).some((r) => r.duck < 0.35), t5.time), { timeout: 10_000 }).toBe(true);
      await duckRest();
      await think(2);
      const tx = await press(page, "x", "", human);
      const earliest = scheduledFrom(tx, rate);
      await expect.poll(() => frameNow(page), { timeout: 20_000 }).toBeGreaterThan(earliest + Math.round(0.4 * rate));
      const reads = await readsSince(page, tx.time);
      const q0 = Math.floor(earliest / 128) * 128;
      for (const r of reads) if (r.frame <= q0) expect(r.duck, `no duck before the scheduled burst (${r.frame})`).toBe(1);
      expect(reads.find((r) => r.duck < 1)?.frame ?? 0, "the duck came, a second after the key").toBeGreaterThan(q0);
      await duckRest();
    });

    await test.step("two quick presses of key 3 (down, then up): two stamps in order, ends at the authored level; a held key acts once", async () => {
      await think(1);
      const base = (await row(page, "Music")).lastRampStartFrame!;
      const t0 = await audioTime(page);
      await page.keyboard.press("3");
      await page.waitForTimeout(250); // two game frames (the page runs at 10 a second here): a quick double tap, mid-fade
      await page.keyboard.press("3");
      await expect.poll(async () => (await stampsSince(page, "musicStamp", t0, base)).length, { timeout: 10_000, message: "two stamped ramps on Music" }).toBeGreaterThanOrEqual(2);
      const stamps = await stampsSince(page, "musicStamp", t0, base);
      expect(stamps, "down, then up: two ramps, the second stamped after the first").toHaveLength(2);
      expect(stamps[1]!, "the second is stamped no earlier than the first").toBeGreaterThanOrEqual(stamps[0]!);
      await expect.poll(() => frameNow(page), { timeout: 20_000 }).toBeGreaterThan(stamps[1]! + Math.round(0.6 * rate));
      await settle(page, "Music", 0.6);
      const dipped = (await readsSince(page, t0)).filter((r) => r.frame > stamps[0]!);
      expect(Math.min(...dipped.map((r) => r.music)), "the first press started down before the second turned it back").toBeLessThan(0.6 - 1e-3);
      // A held key: the first keydown, then auto-repeats. The page's getKeyDown fires once, so the fade goes down once.
      const base1 = (await row(page, "Music")).lastRampStartFrame!;
      const t1 = await audioTime(page);
      await page.keyboard.down("3");
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(120);
        await page.keyboard.down("3");
      }
      await page.keyboard.up("3");
      await think(1);
      expect(await stampsSince(page, "musicStamp", t1, base1), "a held key is one fade").toHaveLength(1);
      await settle(page, "Music", 0.15);
      await press(page, "3", "", human);
      await settle(page, "Music", 0.6);
    });

    await test.step("the muted bus at human pace, twice: N down, up, down, up with a pause between", async () => {
      await press(page, "a", "", human);
      await press(page, "2", "", human);
      for (let round = 0; round < 2; round++) {
        await think(1.5);
        const t = await press(page, "n", "", human);
        await expect.poll(async () => (await row(page, "Ambience")).effectiveGain, { timeout: 10_000 }).toBe(0);
        await untilTime(page, t.time + 5);
        const reads = await readsSince(page, t.time);
        expect(Math.max(...reads.filter((r) => r.time > t.time + 4).map((r) => r.masterPeak)), `round ${round}: silent after the tail`).toBeLessThan(0.002);
        await press(page, "n", "", human);
        await expect.poll(async () => (await row(page, "Ambience")).effectiveGain, { timeout: 10_000 }).toBeCloseTo(0.8, 6);
      }
      await press(page, "2", "", human);
      await press(page, "a", "", human);
    });

    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M5b (task LSb): loudness against a reference. The owner's section is `docs/design/0171-audio-mix/listening-notes/m5b.md`; the
// page is the Sound Lab's main page with its loudness keys (`scripts/behaviors/Loudness.ts`): L the reference (the other sounds
// pause, a 1 kHz sine at -23 dBFS plays on the metered UI bus), W the hot signal (-0.5 dBFS, 2 s), C reset, F pause or resume the
// meters, V the next target, D the on-screen readout. Same shape as M5-0: in the owner's mode a step waits for the owner's key and
// then reads what the page did; headless the walker presses the keys itself. Every wait is on a meter's `elapsed` (rendered audio
// since its last reset) or `Audio.time`, never a wall-clock tolerance (the `think` pauses are the human pace of the listen-mode case).
//
//   headless:                npm run test:e2e:slow -- audio-mix-listening --project chromium-slow --workers 1 -g M5b
//   the owner's mode:        E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5b \(owner"
//
// **What the walker cannot do:** hear (steadiness, clicks at the tone's start or stop, the hot tone's harshness are the owner's ear),
// and provoke the ladder (a real step needs the adaptive cap at its floor and seconds of underruns). The ladder's loudness step
// reaching the meters (non-master meters paused by "ladder", master metering on, the give-back marking them incomplete) is
// `ladderRecoveryLoopback.test.ts` on the real wasm, and `Audio.debug().mix.loudnessLadderStep` is `mixDebug.test.ts`.

type Loud = { momentary: number; shortTerm: number; integrated: number; lra: number; maxTruePeak: number; elapsed: number; paused: boolean; pausedBy: string | null; incomplete: boolean; tainted: boolean; target: { name: string; state: string; deviation: number; peakOver: boolean } | null };
type Press5b = { key: string; repeat: boolean; time: number };
type Globals5b = {
  __myco: { Audio: { time: number; loudnessTarget: string | null; debug(): Dbg & { mix: { metersPaused: number; loudnessLadderStep: number } }; bus(n: string): { loudness: Loud } } };
  __m5b: { presses: Press5b[] };
};

/** The M5b recorder: a capture-phase key log and (owner mode) the card. */
async function installM5b(page: Page, card: boolean): Promise<void> {
  await page.evaluate((showCard) => {
    const g = globalThis as unknown as Globals5b;
    g.__m5b = { presses: [] };
    window.addEventListener("keydown", (e) => g.__m5b.presses.push({ key: e.key.toLowerCase(), repeat: e.repeat, time: g.__myco.Audio.time }), { capture: true });
    if (showCard) {
      const el = document.createElement("pre");
      el.style.cssText = "position:fixed;z-index:99999;left:12px;bottom:12px;margin:0;padding:10px 14px;background:#000d;color:#fff;font:14px/1.45 monospace;border-radius:6px;pointer-events:none;max-width:80vw;white-space:pre-wrap";
      el.textContent = "M5b: loudness against a reference (docs/design/0171-audio-mix/listening-notes/m5b.md)\nL reference tone  W hot signal (loud!)  C reset  F pause or resume  V next target  D readout\nThe terminal says which key, then checks what the page did.";
      document.body.append(el);
    }
  }, card);
}

const meter = (page: Page, bus: string): Promise<Loud> =>
  page.evaluate((name) => {
    const m = (globalThis as unknown as Globals5b).__myco.Audio.bus(name).loudness;
    const t = m.target;
    return { momentary: m.momentary, shortTerm: m.shortTerm, integrated: m.integrated, lra: m.lra, maxTruePeak: m.maxTruePeak, elapsed: m.elapsed, paused: m.paused, pausedBy: m.pausedBy, incomplete: m.incomplete, tainted: m.tainted, target: t ? { name: t.name, state: t.state, deviation: t.deviation, peakOver: t.peakOver } : null };
  }, bus);
/** Waits until a meter has metered `seconds` since its last reset (rendered audio). */
const meteredFor = (page: Page, bus: string, seconds: number) => expect.poll(async () => (await meter(page, bus)).elapsed, { timeout: LISTEN ? 3_600_000 : 60_000, message: `${bus} has metered ${seconds} s` }).toBeGreaterThanOrEqual(seconds);
const audioFor = (page: Page, seconds: number) => audioTime(page).then((t0) => untilTime(page, t0 + seconds, 60_000));
const voicesNow = async (page: Page) => (await page.evaluate(() => (globalThis as unknown as Globals5b).__myco.Audio.debug())).voices;

/** A key: the owner's (waited for) or the walker's own press. */
async function press5b(page: Page, key: string, hint: string, o: { human?: boolean } = {}): Promise<Press5b> {
  const before = await page.evaluate(() => (globalThis as unknown as Globals5b).__m5b.presses.length);
  if (LISTEN && !o.human) process.stdout.write(`\n[listen] M5b: press ${key.toUpperCase()} in the page. ${hint}\n`);
  else await page.keyboard.press(key);
  await page.waitForFunction(([k, n]) => (globalThis as unknown as Globals5b).__m5b.presses.slice(n as number).some((p) => p.key === k && !p.repeat), [key, before] as const, { timeout: LISTEN ? 3_600_000 : 20_000 });
  return page.evaluate(([k, n]) => (globalThis as unknown as Globals5b).__m5b.presses.slice(n as number).find((p) => p.key === k && !p.repeat)!, [key, before] as const);
}

async function boot5b(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { sample: LAB });
  await playWithAudio(page);
  await installM5b(page, LISTEN);
  await page.waitForTimeout(1000); // the clips decode on their first play
  return errors;
}

const TONE = -22.99;
const near = (x: number, want: number, tol = 0.1) => Math.abs(x - want) <= tol;

test.describe("listening M5b: loudness against a reference", () => {
  test.describe.configure({ mode: "serial" });

  test("M5b (owner or headless): the reference reads -22.99 LUFS, the target verdicts, a hot signal's true peak, reset and pause", { tag: "@slow" }, async ({ page }) => {
    const errors = await boot5b(page);

    await test.step("S0 setup: the readout is on, and master reads the page's own sounds", async () => {
      await press5b(page, "d", "Shows the readout (top left): M, S, I, LRA, true peak and the target's verdict for Master and UI.");
      await expect.poll(async () => (await meter(page, "Master")).momentary, { timeout: 60_000 }).toBeGreaterThan(-70);
      expect((await meter(page, "Master")).momentary).toBeLessThan(0);
    });

    await test.step("S1 key L then C: the page's other sounds pause, a steady 1 kHz tone plays on UI, and master reads -22.99 LUFS", async () => {
      await press5b(page, "l", "The music and the hum stop (the hum's room rings out for a couple of seconds); a steady tone starts. Wait until the readout's M settles on -23, then press C.");
      await expect.poll(async () => (await voicesNow(page)).some((v) => v.clip.includes("loudness-reference") && v.bus === "UI" && v.state === "playing"), { timeout: 20_000 }).toBe(true);
      expect((await voicesNow(page)).filter((v) => (v.bus === "Music" || v.bus === "Ambience") && v.state === "playing"), "the page's other sounds are paused").toEqual([]);
      await expect.poll(async () => (await meter(page, "Master")).momentary, { timeout: LISTEN ? 3_600_000 : 60_000, message: "the room has rung out: M on the tone" }).toBeCloseTo(TONE, 1);
      await press5b(page, "c", "Resets Master's and UI's meters: from here they hold the tone alone.");
      await meteredFor(page, "Master", 6);
      await meteredFor(page, "UI", 6);
      for (const bus of ["Master", "UI"]) {
        const r = await meter(page, bus);
        expect(near(r.integrated, TONE), `${bus} integrated ${r.integrated}`).toBe(true);
        expect(near(r.momentary, TONE), `${bus} momentary ${r.momentary}`).toBe(true);
        expect(near(r.shortTerm, TONE), `${bus} short-term ${r.shortTerm}`).toBe(true);
        expect(r.maxTruePeak, `${bus} true peak`).toBeGreaterThan(-23.4);
        expect(r.maxTruePeak).toBeLessThan(-22.8);
        expect(r.lra).toBeGreaterThanOrEqual(0);
        expect(r.lra).toBeLessThan(0.1);
        expect(r.incomplete || r.tainted || r.paused).toBe(false);
      }
      expect((await meter(page, "Master")).target, "console: -24 +/- 2 LU").toMatchObject({ name: "console", state: "ok", peakOver: false });
    });

    await test.step("S2 key V twice: the same level against mobile (-18 +/- 2) is low, then back to console: ok", async () => {
      await press5b(page, "v", "The target becomes mobile (-18 LUFS): the same tone is now 5 LU under it. The readout's verdict reads low.");
      await expect.poll(() => page.evaluate(() => (globalThis as unknown as Globals5b).__myco.Audio.loudnessTarget), { timeout: 15_000 }).toBe("mobile");
      const low = await meter(page, "Master");
      expect(low.target).toMatchObject({ name: "mobile", state: "low", peakOver: false });
      expect(low.target!.deviation).toBeCloseTo(TONE + 18, 1);
      expect(near(low.integrated, TONE), "a target change is not a reset").toBe(true);
      await press5b(page, "v", "Back to console (-24 LUFS): ok again.");
      await expect.poll(() => page.evaluate(() => (globalThis as unknown as Globals5b).__myco.Audio.loudnessTarget), { timeout: 15_000 }).toBe("console");
      expect((await meter(page, "Master")).target).toMatchObject({ name: "console", state: "ok" });
    });

    await test.step("S3 keys L, C, W: the reference off, then a hot signal: UI reads high with its true peak over the ceiling", async () => {
      await press5b(page, "l", "The reference stops; the music and the hum come back.");
      await expect.poll(async () => (await voicesNow(page)).some((v) => v.clip.includes("loudness-reference")), { timeout: 15_000 }).toBe(false);
      await press5b(page, "c", "Resets both meters.");
      await expect.poll(async () => (await meter(page, "UI")).elapsed, { timeout: 15_000 }).toBeLessThan(1);
      await press5b(page, "w", "A loud steady tone for two seconds (turn the volume down first): the readout shows UI at about -1 LUFS, the verdict high and PEAK OVER.");
      await expect.poll(async () => (await voicesNow(page)).some((v) => v.clip.includes("loudness-hot")), { timeout: 20_000 }).toBe(true);
      // Wait for the burst itself to end, then half a second of audio (its last blocks complete), not a time counted from the
      // reset: a person pausing between C and W would otherwise spend the wait before the burst made any loudness block.
      await expect.poll(async () => (await voicesNow(page)).some((v) => v.clip.includes("loudness-hot")), { timeout: LISTEN ? 3_600_000 : 20_000 }).toBe(false);
      await audioFor(page, 0.5);
      const hot = await meter(page, "UI");
      expect(hot.target, "console, hot").toMatchObject({ name: "console", state: "high", peakOver: true });
      expect(hot.target!.deviation, "about -1 LUFS (the burst's edge blocks pass the gates at part energy) against -24").toBeGreaterThan(22.6);
      expect(hot.target!.deviation).toBeLessThan(23.6);
      expect(hot.maxTruePeak).toBeGreaterThan(-0.8);
      expect(hot.maxTruePeak).toBeLessThan(-0.2);
      await press5b(page, "c", "Resets both meters: the verdict goes back to waiting, the peak flag clears.");
      await expect.poll(async () => (await meter(page, "UI")).target!.peakOver, { timeout: 15_000 }).toBe(false);
    });

    await test.step("S4 key F twice: the meters pause (a frozen readout) and resume; key C resets", async () => {
      await press5b(page, "l", "The reference again (steady tone).");
      await expect.poll(async () => (await meter(page, "Master")).momentary, { timeout: LISTEN ? 3_600_000 : 60_000 }).toBeCloseTo(TONE, 1);
      await press5b(page, "c", "Reset.");
      await meteredFor(page, "UI", 2);
      await press5b(page, "f", "Pauses Master's and UI's meters: the readout's numbers freeze and its clock stops, the tone plays on.");
      await expect.poll(async () => (await meter(page, "UI")).paused, { timeout: 15_000 }).toBe(true);
      const held = await meter(page, "UI");
      expect(held.pausedBy).toBe("script");
      expect((await page.evaluate(() => (globalThis as unknown as Globals5b).__myco.Audio.debug())).mix.metersPaused).toBe(2);
      await audioFor(page, 2);
      const still = await meter(page, "UI");
      expect(still.elapsed, "no audio counted while paused").toBe(held.elapsed);
      expect(still.integrated).toBe(held.integrated);
      await press5b(page, "f", "Resumes: the readout moves again and the integrated level is the one it held.");
      await expect.poll(async () => (await meter(page, "UI")).paused, { timeout: 15_000 }).toBe(false);
      await meteredFor(page, "UI", held.elapsed + 1);
      const after = await meter(page, "UI");
      expect(near(after.integrated, TONE)).toBe(true);
      expect(after.incomplete, "a script's own pause is no gap").toBe(false);
      await press5b(page, "c", "Reset.");
      await expect.poll(async () => (await meter(page, "UI")).elapsed, { timeout: 15_000 }).toBeLessThan(1);
    });

    await test.step("the reference off: the page as the owner found it", async () => {
      await press5b(page, "l", "The reference off: the page is as you found it.");
    });

    expect(errors).toEqual([]);
  });

  test("M5b (listen mode): the same keys at human pace, one late, one twice, one held", { tag: "@slow" }, async ({ page }) => {
    test.skip(LISTEN, "the owner's mode is the case above; this one paces the keys itself");
    const errors = await boot5b(page);
    const human = { human: true } as const;
    // The pace is wall time (a person's); the checks are on the audio clock.
    const think = (seconds: number) => page.waitForTimeout(seconds * 1000);
    const refPlaying = async () => (await voicesNow(page)).filter((v) => v.clip.includes("loudness-reference") && v.state === "playing").length;

    await test.step("a late key: the page sat idle for 12 s, then L still plays the reference and master settles on it", async () => {
      await think(12);
      await press5b(page, "l", "", human);
      await expect.poll(refPlaying, { timeout: 20_000 }).toBe(1);
      await expect.poll(async () => (await meter(page, "Master")).momentary, { timeout: 60_000 }).toBeCloseTo(TONE, 1);
      await think(2);
      await press5b(page, "c", "", human);
      await meteredFor(page, "Master", 6);
      expect(near((await meter(page, "Master")).integrated, TONE)).toBe(true);
    });

    await test.step("a key twice: C and C again a moment later; the meter restarts from the second, and keeps reading the tone", async () => {
      await press5b(page, "c", "", human);
      await page.waitForTimeout(250); // two game frames at the capped rate: a quick double tap
      await press5b(page, "c", "", human);
      await expect.poll(async () => (await meter(page, "Master")).elapsed, { timeout: 15_000 }).toBeLessThan(1);
      await meteredFor(page, "Master", 3);
      expect(near((await meter(page, "Master")).integrated, TONE)).toBe(true);
    });

    await test.step("a key held: holding F is one pause, not a flutter; one more F resumes", async () => {
      await meteredFor(page, "UI", 1);
      await page.keyboard.down("f");
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(120);
        await page.keyboard.down("f");
      }
      await page.keyboard.up("f");
      await think(1);
      expect((await meter(page, "UI")).paused, "one toggle: paused").toBe(true);
      await press5b(page, "f", "", human);
      await expect.poll(async () => (await meter(page, "UI")).paused, { timeout: 15_000 }).toBe(false);
    });

    await test.step("L held: the reference toggles once and stays on; V at human pace twice comes back to console", async () => {
      // The reference is on now: one press turns it off, then a held L is one toggle, on, with one voice.
      await press5b(page, "l", "", human);
      await expect.poll(refPlaying, { timeout: 15_000 }).toBe(0);
      await page.keyboard.down("l");
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(120);
        await page.keyboard.down("l");
      }
      await page.keyboard.up("l");
      await think(1);
      expect(await refPlaying(), "one toggle: on, one voice").toBe(1);
      await press5b(page, "v", "", human);
      await think(2);
      await press5b(page, "v", "", human);
      await expect.poll(() => page.evaluate(() => (globalThis as unknown as Globals5b).__myco.Audio.loudnessTarget), { timeout: 15_000 }).toBe("console");
      await press5b(page, "l", "", human);
    });

    expect(errors).toEqual([]);
  });
});

// ---- M5c: live mixing and level ducking (task LSc) --------------------------------------------------------------------------------------
//
// The owner's section is `docs/design/0171-audio-mix/listening-notes/m5c.md`: the Sound Lab's Mixer page (key "-" on the tour page;
// keys 1 the voice, 2 an SFX burst; the project's level rules Voice -> Music and Voice -> Ambience beside the presence rule SFX ->
// Music) with the Audio Mixer panel and Project Settings > Audio beside it, on a **writable copy** of the Sound Lab (the sample opens
// read-only, where an edit neither reaches the mixer nor is saved). The walker opens that copy in the editor's in-memory test project
// (`audioMixLive.ts` `openLabCopy`: every Sound Lab file over the Flappy files). Steps: S1 level against presence ducking on Music, S2
// fader keys (the zipper), S3 structural edits with their dip (a move, a mid-tree insert, a removal) and Undo, S4 Compare.
//
//   headless:                npm run test:e2e:slow -- audio-mix-listening --project chromium-slow --workers 1 -g M5c
//   the owner's mode:        E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5c \(owner"
//
// In the owner's mode a step prints what to do and waits for the page to show that the owner did it (a voice playing, a saved value
// moved, a bus moved), then reads what the page did, and fails if it did not run as built. Headless the walker does each action itself.
// Every wait is on the audio clock (`Audio.time`) or a reading that arrives; the wall-clock `think` pauses are the human pace of the
// listen-mode case. **What the walker cannot do:** hear (a dip's click, the fader's zipper, how natural the ducking sounds are).

type Globals5c = {
  __myco: {
    Audio: { time: number; debug(): { counters: { lateCommands: number; traps: number }; voices: { clip: string; bus: string; state: string }[]; buses: { name: string }[]; mix: { busRecordsEarly: number; sidechainLate: number; liveRefused: number } }; buses: readonly string[]; bus(n: string): { effectiveGain: number; duckGain: number } };
  };
};

const LAB_ENTRY = { moveUnder: "Music", mover: "Engine", remover: "Load" } as const;

const gain5c = (page: Page, bus: string) => page.evaluate((b) => (globalThis as unknown as Globals5c).__myco.Audio.bus(b).effectiveGain, bus);
const duck5c = (page: Page, bus: string) => page.evaluate((b) => (globalThis as unknown as Globals5c).__myco.Audio.bus(b).duckGain, bus);
const names5c = (page: Page) => page.evaluate(() => [...(globalThis as unknown as Globals5c).__myco.Audio.buses]);
const records5c = async (page: Page) => {
  const d = await page.evaluate(() => (globalThis as unknown as Globals5c).__myco.Audio.debug());
  return { lateCommands: d.counters.lateCommands, traps: d.counters.traps, busRecordsEarly: d.mix.busRecordsEarly, sidechainLate: d.mix.sidechainLate, liveRefused: d.mix.liveRefused };
};
const voices5c = async (page: Page) => (await page.evaluate(() => (globalThis as unknown as Globals5c).__myco.Audio.debug())).voices;
const volumeOf = async (page: Page, bus: string) => (await savedProject(page)).audio!.buses!.find((b) => b.name === bus)!.volume;

/** The lowest duck gain of each named bus over `seconds` of the audio clock (sampled in the page). */
const lowestDucks = (page: Page, buses: string[], seconds: number): Promise<Record<string, number>> =>
  page.evaluate(
    async ([names, span]) => {
      const A = (globalThis as unknown as Globals5c).__myco.Audio;
      const t0 = A.time;
      const low: Record<string, number> = Object.fromEntries((names as string[]).map((n) => [n, 1]));
      while (A.time < t0 + (span as number)) {
        for (const n of names as string[]) low[n] = Math.min(low[n]!, A.bus(n).duckGain);
        await new Promise((r) => setTimeout(r, 10));
      }
      return low;
    },
    [buses, seconds] as const,
  );

/** The owner's action (waited for in the owner's mode) or the walker's own, then a reading that says it happened. */
async function act5c(page: Page, hint: string, doIt: () => Promise<unknown>, done: () => Promise<unknown>): Promise<void> {
  if (LISTEN) process.stdout.write(`\n[listen] M5c: ${hint}\n`);
  else await doIt();
  await expect.poll(done, { timeout: LISTEN ? 3_600_000 : 30_000, message: hint }).toBeTruthy();
}

/** A click on the game view, so the page's keys reach the game (the panels take the focus when used). */
const clickGame = (page: Page) => page.mouse.click(480, 250);

async function boot5c(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openLabCopy(page);
  await playWithAudio(page, { startTimeout: 90_000 });
  await page.keyboard.press("-"); // the tour page's key to the Mixer page
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { __myco?: { getComponentClass(id: string): unknown } }).__myco?.getComponentClass("lab.MixerLab") !== undefined), { timeout: 30_000 })
    .toBe(true);
  await expect.poll(async () => (await names5c(page)).includes("Voice"), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(1500); // the clips decode on their first play
  if (LISTEN) {
    await page.evaluate(() => {
      const el = document.createElement("pre");
      el.style.cssText = "position:fixed;z-index:99999;left:12px;bottom:12px;margin:0;padding:10px 14px;background:#000d;color:#fff;font:14px/1.45 monospace;border-radius:6px;pointer-events:none;max-width:80vw;white-space:pre-wrap";
      el.textContent = "M5c: live mixing and level ducking (docs/design/0171-audio-mix/listening-notes/m5c.md)\n1 voice  2 burst  (game view)   Mixer panel: faders, Compare   Project Settings > Audio: move and remove buses\nThe terminal says what to do, then checks what the page did.";
      document.body.append(el);
    });
  }
  return errors;
}

test.describe("listening M5c: live mixing and level ducking", () => {
  test.describe.configure({ mode: "serial" });

  test("M5c (owner or headless): level against presence ducking on Music, fader keys, structural edits with their dip and Undo, Compare", { tag: "@slow" }, async ({ page }) => {
    const errors = await boot5c(page);
    const voiceOn = async () => (await voices5c(page)).some((v) => v.clip.includes("voice-loop") && v.bus === "Voice" && v.state === "playing");
    const undo = () => page.locator(".panel.project .project-settings-toolbar").getByRole("button", { name: "Undo" });

    await test.step("S1 keys 1 and 2: the voice ducks Music through the level rule (0.35) and Ambience (0.5), a burst through the presence rule (0.3), both: the lower", async () => {
      await clickGame(page);
      expect(await duck5c(page, "Music"), "nothing on the triggers yet").toBe(1);
      await act5c(page, "press 1: the voice starts; Music and the bed dip inside each phrase and come back in the gaps.", () => page.keyboard.press("1"), voiceOn);
      const voice = await lowestDucks(page, ["Music", "Ambience"], 7);
      expect(voice.Music, "level (RMS -30): Music to 0.35").toBeLessThan(0.42);
      expect(voice.Music).toBeGreaterThan(0.3);
      expect(voice.Ambience, "level (peak -20): Ambience to 0.5").toBeLessThan(0.56);
      expect(voice.Ambience).toBeGreaterThan(0.45);
      await act5c(page, "press 1 again: the voice stops; the ducks release.", () => page.keyboard.press("1"), async () => !(await voiceOn()));
      await expect.poll(() => duck5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
      const before = (await voices5c(page)).filter((v) => v.clip.includes("burst")).length;
      await act5c(page, "press 2: a burst on SFX; Music dips to 0.3 (presence) for as long as it plays.", () => page.keyboard.press("2"), async () => (await voices5c(page)).filter((v) => v.clip.includes("burst")).length > before);
      const burst = await lowestDucks(page, ["Music"], 2);
      expect(burst.Music, "presence: Music to 0.3").toBeLessThan(0.36);
      expect(burst.Music).toBeGreaterThan(0.26);
      await expect.poll(() => duck5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
      await act5c(page, "press 1 then 2 (the voice, then a burst inside it): Music takes the lower of its two ducks.", async () => { await page.keyboard.press("1"); await page.waitForTimeout(1500); await page.keyboard.press("2"); }, voiceOn);
      const both = await lowestDucks(page, ["Music"], 5);
      expect(both.Music, "the lower of 0.3 and 0.35").toBeLessThan(0.36);
      await act5c(page, "press 1: the voice off.", () => page.keyboard.press("1"), async () => !(await voiceOn()));
      await expect.poll(() => duck5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
    });

    await openMixer(page);
    const records0 = await records5c(page);

    await test.step("S2 the fader: keys on Music's fader are one edit each, the effective gain follows each, and Undo walks them back", async () => {
      const v0 = await volumeOf(page, "Music");
      const g0 = await gain5c(page, "Music");
      await act5c(
        page,
        "click Music's fader, then press the Down arrow five times (or drag it): listen for steps or zipper as the level falls.",
        async () => {
          await fader(page, "Music").focus();
          for (let i = 0; i < 5; i++) {
            await page.keyboard.press("ArrowDown");
            await audioFor(page, 0.15);
          }
        },
        async () => (await volumeOf(page, "Music")) < v0,
      );
      const v1 = await volumeOf(page, "Music");
      await expect.poll(() => gain5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(v1, 3);
      expect(await gain5c(page, "Music"), "the heard level followed the fader").toBeLessThan(g0);
      // Undo, one step per edit, until the value is back; the count is the number of edits made.
      let steps = 0;
      await fader(page, "Music").focus();
      while ((await volumeOf(page, "Music")) !== v0 && steps < 40) {
        await page.keyboard.press("Control+z");
        steps++;
        await audioFor(page, 0.1);
      }
      expect(await volumeOf(page, "Music"), "undone all the way").toBe(v0);
      if (!LISTEN) expect(steps, "five key presses, five edits").toBe(5);
      await expect.poll(() => gain5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(v0, 3);
    });

    await test.step("S3 structural edits: a move, a mid-tree insert and a removal each dip and land; Undo brings each back", async () => {
      await openAudioSettings(page);
      const field = (label: string) => page.locator(".panel.project").getByRole("group", { name: "Audio settings" }).getByLabel(label, { exact: true });
      const musicVol = await volumeOf(page, "Music");
      const engineVol = await volumeOf(page, "Engine");
      await act5c(page, `in Project Settings > Audio, set ${LAB_ENTRY.mover}'s parent to ${LAB_ENTRY.moveUnder}: a short dip, then ${LAB_ENTRY.mover} sits under it (quieter by Music's level).`, () => field(`${LAB_ENTRY.mover} parent`).selectOption(LAB_ENTRY.moveUnder), async () => (await savedProject(page)).audio!.buses!.find((b) => b.name === LAB_ENTRY.mover)!.parent === LAB_ENTRY.moveUnder);
      await expect.poll(() => gain5c(page, LAB_ENTRY.mover), { timeout: 30_000 }).toBeCloseTo(engineVol * musicVol, 3);
      await act5c(page, "press Undo in the Project panel: the bus goes back to Master, with a dip.", () => undo().click(), async () => (await savedProject(page)).audio!.buses!.find((b) => b.name === LAB_ENTRY.mover)!.parent === "Master");
      await expect.poll(() => gain5c(page, LAB_ENTRY.mover), { timeout: 30_000 }).toBeCloseTo(engineVol, 3);

      // A mid-tree insert: a new bus under Music (direct), then Engine moved under it (a dip).
      const before = await names5c(page);
      await act5c(page, "press + child on Music, then set Engine's parent to the new bus: a bus inserted between Music and Engine.", () => page.locator(".panel.project").getByRole("button", { name: "Add child bus to Music", exact: true }).click(), async () => (await names5c(page)).length === before.length + 1);
      const added = (await names5c(page)).find((n) => !before.includes(n))!;
      await act5c(page, `set Engine's parent to ${added}.`, () => field("Engine parent").selectOption(added), async () => (await savedProject(page)).audio!.buses!.find((b) => b.name === "Engine")!.parent === added);
      await expect.poll(() => gain5c(page, "Engine"), { timeout: 30_000 }).toBeCloseTo(engineVol * musicVol, 3);

      // A removal with its sounds on it: Load is a bus the page puts sounds on.
      const loadVoices = (await voices5c(page)).filter((v) => v.bus === LAB_ENTRY.remover).length;
      await act5c(page, `press x on ${LAB_ENTRY.remover} in Project Settings > Audio: its sounds (if any) dip and move to Master.`, () => page.locator(".panel.project").getByRole("button", { name: `Remove bus ${LAB_ENTRY.remover}`, exact: true }).click(), async () => !(await names5c(page)).includes(LAB_ENTRY.remover));
      await expect.poll(async () => (await voices5c(page)).filter((v) => v.bus === LAB_ENTRY.remover).length, { timeout: 30_000 }).toBe(0);
      void loadVoices;
      // Undo all three (the removal, Engine's move, the insert): the tree is as it was.
      for (const want of [() => (names5c(page).then((n) => n.includes(LAB_ENTRY.remover))), async () => (await savedProject(page)).audio!.buses!.find((b) => b.name === "Engine")!.parent === "Master", async () => (await names5c(page)).length === before.length]) {
        await undo().click();
        await expect.poll(want, { timeout: 30_000 }).toBe(true);
      }
      await audioFor(page, 1);
      // No click: no record early or refused and no trap across the three edits and their undos. `lateCommands` is reported, not
      // asserted: in this heavy page (the whole Sound Lab, software GL on a shared box) one or two records reach the core after
      // their frame in about half of the runs, at a different edit each time (the removal, the move); `audio-mix-c.spec.ts` on its
      // small project asserts it exactly and never sees one. A late record is a stamp missed by a quantum under main-thread load.
      const end = await records5c(page);
      expect({ ...end, lateCommands: 0 }).toEqual({ ...records0, lateCommands: 0 });
      test.info().annotations.push({ type: "lateCommands", description: `${end.lateCommands - records0.lateCommands} across S3 (reported, not asserted)` });
    });

    await test.step("S4 Compare: the saved mix from Play start is heard with the faders locked, then the edited mix is back", async () => {
      await openMixer(page);
      const v0 = await volumeOf(page, "Music");
      await act5c(page, "press the Down arrow on Music's fader three times, then press Compare: Music is back at its Play-start level; press Compare again.", async () => {
        await fader(page, "Music").focus();
        for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
      }, async () => (await volumeOf(page, "Music")) < v0);
      const edited = await volumeOf(page, "Music");
      await expect.poll(() => gain5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(edited, 3);
      const compare = page.getByRole("button", { name: "Compare", exact: true });
      await act5c(page, "Compare on.", () => compare.click(), async () => (await compare.getAttribute("aria-pressed")) === "true");
      await expect.poll(() => gain5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(v0, 3);
      expect(await volumeOf(page, "Music"), "Compare saves nothing").toBe(edited);
      await act5c(page, "Compare off.", () => compare.click(), async () => (await compare.getAttribute("aria-pressed")) === "false");
      await expect.poll(() => gain5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(edited, 3);
      await fader(page, "Music").focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");
      await expect.poll(() => volumeOf(page, "Music"), { timeout: 10_000 }).toBe(v0);
    });

    expect(errors).toEqual([]);
  });

  test("M5c (listen mode): the same at human pace, one late, one twice, one held", { tag: "@slow" }, async ({ page }) => {
    test.skip(LISTEN, "the owner's mode is the case above; this one paces the keys itself");
    const errors = await boot5c(page);
    const think = (seconds: number) => page.waitForTimeout(seconds * 1000); // a person's pace is wall time; the checks are on the audio clock
    const voiceOn = async () => (await voices5c(page)).some((v) => v.clip.includes("voice-loop") && v.bus === "Voice" && v.state === "playing");

    await test.step("a late key: the page sat idle for 12 s, then 1 still ducks Music through the level rule", async () => {
      await clickGame(page);
      await think(12);
      await page.keyboard.press("1");
      await expect.poll(voiceOn, { timeout: 20_000 }).toBe(true);
      const low = await lowestDucks(page, ["Music"], 7);
      expect(low.Music).toBeLessThan(0.42);
      expect(low.Music).toBeGreaterThan(0.3);
      await page.keyboard.press("1");
      await expect.poll(() => duck5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
    });
    await test.step("a key twice: 2 and 2 again a quarter of a second later: two bursts, Music at 0.3, then released", async () => {
      const bursts = async () => (await voices5c(page)).filter((v) => v.clip.includes("burst")).length;
      const n = await bursts();
      await page.keyboard.press("2");
      await page.waitForTimeout(250);
      await page.keyboard.press("2");
      await expect.poll(bursts, { timeout: 10_000 }).toBeGreaterThanOrEqual(n + 1);
      expect((await lowestDucks(page, ["Music"], 2)).Music).toBeLessThan(0.36);
      await expect.poll(() => duck5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(1, 2);
    });
    await test.step("a key held: holding the Down arrow on a fader is one edit per repeat, each one undo step", async () => {
      await openMixer(page);
      const v0 = await volumeOf(page, "Music");
      await fader(page, "Music").focus();
      const seen: number[] = [v0];
      await page.keyboard.down("ArrowDown");
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(120);
        await page.keyboard.down("ArrowDown");
        seen.push(await volumeOf(page, "Music"));
      }
      await page.keyboard.up("ArrowDown");
      await think(1);
      const end = await volumeOf(page, "Music");
      expect(end, "the holding moved the fader down").toBeLessThan(v0);
      expect(seen.every((v, i) => i === 0 || v <= seen[i - 1]!), "never up while held").toBe(true);
      await expect.poll(() => gain5c(page, "Music"), { timeout: 20_000 }).toBeCloseTo(end, 3);
      let steps = 0;
      while ((await volumeOf(page, "Music")) !== v0 && steps < 40) {
        await page.keyboard.press("Control+z");
        steps++;
        await audioFor(page, 0.1);
      }
      expect(await volumeOf(page, "Music")).toBe(v0);
      expect(steps, "each repeat was its own undo step").toBeGreaterThanOrEqual(4);
    });
    expect(errors).toEqual([]);
  });
});

void play;
