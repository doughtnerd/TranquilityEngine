import { expect, type Page, play, test } from "./fixtures";
import { bootMix, mixDebug } from "./audioMix";

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
// The walker adds nothing the sample doesn't have but a recorder: a capture-phase key listener that logs each press, spies on the
// command writer's `busRampFrames`, `busPresence` and `play` (what main sent and the frame it stamped), and a 10 ms sampler of
// the heard clock, the core's STATUS frame, the duck lane and the meters. Every timing assertion is on the audio clock (the core's
// STATUS frame, `Audio.time`, frames in records); the real-time intervals only pace the reads. In the owner's mode a step waits
// for the owner's key (the recorder sees it) and then reads what the page did, and fails if it did not run as built.
//
// **Owner mode, what it also covers (ground rules, "the walker also runs in the owner's mode"):** the `M5-0 (listen mode)` case
// presses the same keys at human pace (seconds between keys), one key late (after the page sat idle, so STATUS idles at 48 quanta),
// one key twice (two separate presses) and one key held (auto-repeat: it must act once), and checks the same landings.
//
// **What the walker cannot do:** hear. Headless Chromium has no sound output; it reads the lane values, the duck, the records
// main sent and the core's meters. A click, a zipper or a thin spectrum is the owner's ear (and the objective `maxStep` checks of
// the goldens). The snapshot's low-pass is read from the records sent (`busRampFrames` with `lpHz`), not from the sound.

const LISTEN = process.env.E2E_LISTEN === "1";
test.describe.configure({ timeout: LISTEN ? 3_600_000 : 240_000 });

const LANE = { runtime: 1, snapshot: 2 } as const;
const BUS_LP_OFF_HZ = 24000;

type Ramp = { kind: "ramp"; bus: number; lane: number; mask: number; gain: number; lpHz: number; frames: number; at?: number; now: number };
type Pres = { kind: "presence"; mask: number; at?: number; now: number };
type Play = { kind: "play"; at?: number; now: number };
type Sent = Ramp | Pres | Play;
type Press = { key: string; repeat: boolean; time: number; frame: number };
type Read = { frame: number; time: number; duck: number; music: number; ambience: number; sfxPeak: number; masterPeak: number; musicPeak: number };
type Row = { name: string; effectiveGain: number; peakL: number; lastRampStartFrame?: number };
type Dbg = { sampleRate: number; buses: Row[]; voices: { id: number; clip: string; bus: string; state: string }[]; musicTotals?: { splitQuanta?: number }; counters: { underruns: number } };
type M50 = { presses: Press[]; sent: Sent[]; reads: Read[]; slots: Record<string, number> };

type Globals = { __myco: { Audio: { time: number; debug(): Dbg; buses: readonly string[]; bus(n: string): { effectiveGain: number; duckGain: number; peak: number } } } };

/** Installs the recorder: key log, command-writer spies, the 10 ms sampler, and (owner mode) the card. */
async function installM50(page: Page, card: boolean): Promise<void> {
  await page.evaluate((showCard) => {
    type Writer = Record<string, (...a: never[]) => void>;
    type Mirror = { currentFrame: number; duckCount: number; duckSlot: Uint16Array; duckGain: Float32Array };
    type Backend = { mirror: Mirror; writer: Writer };
    type V = { backend?: Backend; inner?: { backend?: Backend } };
    const g = globalThis as unknown as Globals & { __m50?: M50 };
    const { Audio } = g.__myco;
    const seed = (Audio as unknown as { playOneShot(c: string, o?: object): { voice?: V } }).playOneShot("audio/beep.wav", { volume: 0.0001, bus: "UI" }).voice;
    const backend = (seed?.backend ?? seed?.inner?.backend)!;
    const st: M50 = { presses: [], sent: [], reads: [], slots: {} };
    for (const n of Audio.buses) st.slots[n] = Audio.buses.indexOf(n);
    g.__m50 = st;
    const now = () => backend.mirror.currentFrame;
    const w = backend.writer as unknown as {
      busRampFrames(bus: number, lane: number, mask: number, gain: number, lpHz: number, frames: number, seq?: number, at?: number): void;
      busPresence(mask: number, at?: number): void;
      play(args: unknown, at?: number): void;
    };
    const ramp = w.busRampFrames.bind(w);
    w.busRampFrames = (bus, lane, mask, gain, lpHz, frames, seq, at) => {
      st.sent.push({ kind: "ramp", bus, lane, mask, gain, lpHz, frames, at, now: now() });
      ramp(bus, lane, mask, gain, lpHz, frames, seq, at);
    };
    const pres = w.busPresence.bind(w);
    w.busPresence = (mask, at) => {
      st.sent.push({ kind: "presence", mask, at, now: now() });
      pres(mask, at);
    };
    const playW = w.play.bind(w);
    w.play = (args, at) => {
      st.sent.push({ kind: "play", at, now: now() });
      playW(args, at);
    };
    window.addEventListener(
      "keydown",
      (e) => {
        st.presses.push({ key: e.key.toLowerCase(), repeat: e.repeat, time: Audio.time, frame: now() });
      },
      { capture: true },
    );
    const m = backend.mirror;
    const music = Audio.buses.indexOf("Music");
    setInterval(() => {
      let duck = 1;
      for (let k = 0; k < m.duckCount; k++) if (m.duckSlot[k] === music) duck = m.duckGain[k]!;
      const d = Audio.debug();
      const row = (n: string) => d.buses.find((b) => b.name === n)!;
      if (st.reads.length > 60_000) st.reads.splice(0, 10_000);
      st.reads.push({ frame: m.currentFrame, time: Audio.time, duck, music: Audio.bus("Music").effectiveGain, ambience: Audio.bus("Ambience").effectiveGain, sfxPeak: row("SFX").peakL, masterPeak: row("Master").peakL, musicPeak: row("Music").peakL });
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
const sentCount = (page: Page) => page.evaluate(() => (globalThis as unknown as { __m50: M50 }).__m50.sent.length);

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

const sentSince = (page: Page, from: number) => page.evaluate((n) => (globalThis as unknown as { __m50: M50 }).__m50.sent.slice(n), from);
const readsSince = (page: Page, t: number) => page.evaluate((from) => (globalThis as unknown as { __m50: M50 }).__m50.reads.filter((r) => r.time >= from), t);
const slot = (page: Page, name: string) => page.evaluate((n) => (globalThis as unknown as { __m50: M50 }).__m50.slots[n]!, name);

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
  await bootMix(page);
  await installM50(page, LISTEN);
  // The clips decode on their first play; the drums and the noise start from their keys.
  await page.waitForTimeout(1000);
  return errors;
}

/** Every duck-lane sample and the Music bus's effective gain over a window of the heard clock. */
const duckSeries = (reads: Read[]) => ({ min: Math.min(...reads.map((r) => r.duck)), minGain: Math.min(...reads.map((r) => r.music)) });

test.describe("listening M5-0: the stamped bus path", () => {
  // One page at a time: two software-GL pages on this machine starve each other (the core underruns, which a headless walk cannot judge).
  test.describe.configure({ mode: "serial" });

  test("M5-0 (owner or headless): a fade and a snapshot on their stamp, a presence duck on the sound's own frame, a muted bus's send silent post-fader", { tag: "@slow" }, async ({ page }) => {
    const errors = await boot(page);
    const rate = (await dbg(page)).sampleRate;
    const split0 = (await dbg(page)).musicTotals?.splitQuanta ?? 0;
    const music = await slot(page, "Music");
    const ambience = await slot(page, "Ambience");
    const sfx = await slot(page, "SFX");

    await test.step("S0 setup: the tone is paused (P) and the drums play on Music (B), the project's hum plays on Ambience", async () => {
      await press(page, "p", "Pauses the Music tone so the drums are the only thing on Music.");
      await press(page, "b", "Starts the drum loop on the Music bus: a kick, a snare and hats, 120 bpm.");
      await expect.poll(async () => (await dbg(page)).voices.some((v) => v.clip.includes("drum-loop") && v.bus === "Music" && v.state === "playing"), { timeout: 15_000 }).toBe(true);
      expect(await peakOver(page, "musicPeak", 1.2), "the drums are on the Music meter").toBeGreaterThan(0.02);
      expect((await row(page, "Music")).effectiveGain).toBeCloseTo(0.6, 6);
    });

    await test.step("S1 key 3: a scripted fade lands on its stamp, down over 0.5 s to a quarter and back up", async () => {
      const base = (await row(page, "Music")).lastRampStartFrame ?? 0;
      const sent0 = await sentCount(page);
      const before = await peakOver(page, "musicPeak", 1.2);
      const t = await press(page, "3", "Fades Music (the drums) to a quarter over half a second, from about a tenth of a second after the key.");
      const stamp = await stampOf(page, "Music", base);
      expect(stamp, "stamped ahead of the core's frame at the key").toBeGreaterThan(t.frame);
      expect(stamp - t.frame, "within the lookahead and the clock's lead").toBeLessThan(0.5 * rate);
      const ramps = (await sentSince(page, sent0)).filter((s): s is Ramp => s.kind === "ramp" && s.bus === music && s.lane === LANE.runtime);
      expect(ramps.length, "one BUS_RAMP on Music's runtime lane, nothing re-sent while it runs").toBe(1);
      expect(ramps[0]!.at, "the record carries the stamp the row shows").toBe(stamp);
      expect(ramps[0]!.gain).toBeCloseTo(0.25, 6);
      expect(ramps[0]!.frames / rate, "0.5 s long").toBeCloseTo(0.5, 2);
      // On the audio clock: landed by stamp + 0.5 s (the core has rendered past it), monotone, not in one step.
      await expect.poll(() => frameNow(page), { timeout: 15_000 }).toBeGreaterThan(stamp + Math.round(0.5 * rate));
      await settle(page, "Music", 0.15);
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
      const sent0 = await sentCount(page);
      const t = await press(page, "4", "Underwater: the drums go muffled and quieter, the hum and noise too, over half a second. Press again afterwards to clear it.");
      const stamp = await stampOf(page, "Music", base);
      expect(stamp).toBeGreaterThan(t.frame);
      const ramps = (await sentSince(page, sent0)).filter((s): s is Ramp => s.kind === "ramp" && s.lane === LANE.snapshot);
      const by = (n: number) => ramps.find((r) => r.bus === n);
      expect(by(music), "Music's snapshot ramp").toMatchObject({ gain: expect.closeTo(0.6, 6), lpHz: 500, at: stamp });
      expect(by(ambience), "Ambience's snapshot ramp").toMatchObject({ gain: expect.closeTo(0.5, 6), lpHz: 900, at: stamp });
      expect(by(sfx), "SFX's snapshot ramp: its low-pass only").toMatchObject({ lpHz: 1500, at: stamp });
      expect(new Set(ramps.map((r) => r.at)).size, "one stamp for every bus the snapshot touches").toBe(1);
      expect((await row(page, "Ambience")).lastRampStartFrame, "the Ambience row shows the same stamp").toBe(stamp);
      await expect.poll(() => frameNow(page), { timeout: 15_000 }).toBeGreaterThan(stamp + Math.round(0.5 * rate));
      await settle(page, "Music", 0.36);
      await settle(page, "Ambience", 0.4);
      await settle(page, "SFX", 1);
      // Clear.
      const sent1 = await sentCount(page);
      const base1 = (await row(page, "Music")).lastRampStartFrame!;
      await press(page, "4", "Clears the snapshot: the sound opens up again.");
      const stamp1 = await stampOf(page, "Music", base1);
      const cleared = (await sentSince(page, sent1)).filter((s): s is Ramp => s.kind === "ramp" && s.lane === LANE.snapshot);
      expect(cleared.find((r) => r.bus === music), "Music's ramp back to open").toMatchObject({ gain: expect.closeTo(1, 6), lpHz: BUS_LP_OFF_HZ, at: stamp1 });
      await settle(page, "Music", 0.6);
      await settle(page, "Ambience", 0.8);
    });

    // The duck steps need the duck lane at rest.
    const duckRest = () => expect.poll(() => page.evaluate(() => (globalThis as unknown as Globals).__myco.Audio.bus("Music").duckGain), { timeout: 15_000 }).toBe(1);

    await test.step("S3 key 5: a burst on SFX ducks Music to the rule's 0.3 and releases it", async () => {
      await duckRest();
      const sent0 = await sentCount(page);
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
      const sent = await sentSince(page, sent0);
      const withSfx = sent.filter((s): s is Pres => s.kind === "presence" && (s.mask & (1 << sfx)) !== 0);
      const without = sent.filter((s): s is Pres => s.kind === "presence" && (s.mask & (1 << sfx)) === 0);
      expect(withSfx.length, "BUS_PRESENCE with SFX's bit").toBeGreaterThan(0);
      expect(without.length, "and the bit cleared when the burst ended").toBeGreaterThan(0);
      expect(reads[reads.length - 1]!.duck, "released to 1").toBeGreaterThan(0.999);
    });

    await test.step("S4 key X: the same burst scheduled 1 s ahead: Music ducks on the burst's own frame, not before and not after", async () => {
      await duckRest();
      const sent0 = await sentCount(page);
      const t = await press(page, "x", "The burst sounds one second after the key. The drums must dip exactly as it hits: no dip before it, no full-level drums under its first instant.");
      await expect.poll(async () => (await sentSince(page, sent0)).some((s) => s.kind === "presence" && s.at !== undefined), { timeout: 10_000 }).toBe(true);
      const sent = await sentSince(page, sent0);
      const pres = sent.find((s): s is Pres => s.kind === "presence" && s.at !== undefined && (s.mask & (1 << sfx)) !== 0)!;
      const stamp = pres.at!;
      expect(stamp - t.frame, "a second ahead, within the clock's lead").toBeGreaterThan(0.8 * rate);
      expect(stamp - t.frame).toBeLessThan(1.5 * rate);
      expect(sent.some((s) => s.kind === "play" && s.at === stamp), "the voice's PLAY carries the same frame").toBe(true);
      await expect.poll(() => frameNow(page), { timeout: 20_000 }).toBeGreaterThan(stamp + Math.round(0.4 * rate));
      const q0 = Math.floor(stamp / 128) * 128;
      const reads = await readsSince(page, t.time);
      for (const r of reads) if (r.frame <= q0) expect(r.duck, `STATUS frame ${r.frame}, before the stamp's quantum ${q0}`).toBe(1);
      for (const r of reads) if (r.frame <= q0) expect(r.sfxPeak, `the burst is not heard before its frame (${r.frame})`).toBeLessThan(0.01);
      const ducked = reads.find((r) => r.duck < 1)!;
      expect(ducked, "the duck was read").toBeTruthy();
      expect(ducked.frame, "first seen in a block after the stamp's quantum").toBeGreaterThan(q0);
      expect(ducked.frame - stamp, "and within a few blocks of it").toBeLessThan(0.3 * rate);
      const heard = reads.find((r) => r.sfxPeak > 0.01)!;
      expect(heard.frame, "the burst reaches the SFX meter after its frame, not before").toBeGreaterThan(q0);
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
      const sent0 = await sentCount(page);
      const tx = await press(page, "x", "", human);
      await expect.poll(async () => (await sentSince(page, sent0)).some((s) => s.kind === "presence" && s.at !== undefined), { timeout: 10_000 }).toBe(true);
      const stamp2 = (await sentSince(page, sent0)).find((s): s is Pres => s.kind === "presence" && s.at !== undefined)!.at!;
      expect(stamp2 - tx.frame).toBeGreaterThan(0.8 * rate);
      await expect.poll(() => frameNow(page), { timeout: 20_000 }).toBeGreaterThan(stamp2 + Math.round(0.3 * rate));
      await duckRest();
    });

    await test.step("two quick presses of key 3 (down, then up): two stamps in order, ends at the authored level; a held key acts once", async () => {
      await think(1);
      const base = (await row(page, "Music")).lastRampStartFrame!;
      const sent0 = await sentCount(page);
      await page.keyboard.press("3");
      await page.waitForTimeout(250); // two game frames (the page runs at 10 a second here): a quick double tap, mid-fade
      await page.keyboard.press("3");
      await expect.poll(async () => (await sentSince(page, sent0)).filter((s) => s.kind === "ramp" && s.lane === LANE.runtime).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      const ramps = (await sentSince(page, sent0)).filter((s): s is Ramp => s.kind === "ramp" && s.lane === LANE.runtime);
      expect(ramps.map((r) => r.gain.toFixed(2)), "down, then up").toEqual(["0.25", "1.00"]);
      expect(ramps[1]!.at!, "the second is stamped no earlier than the first").toBeGreaterThanOrEqual(ramps[0]!.at!);
      await expect.poll(() => frameNow(page), { timeout: 20_000 }).toBeGreaterThan(ramps[1]!.at! + Math.round(0.6 * rate));
      await settle(page, "Music", 0.6);
      expect((await row(page, "Music")).lastRampStartFrame).toBeGreaterThan(base);
      // A held key: the first keydown, then auto-repeats. The page's getKeyDown fires once, so the fade goes down once.
      const sent1 = await sentCount(page);
      await page.keyboard.down("3");
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(120);
        await page.keyboard.down("3");
      }
      await page.keyboard.up("3");
      await think(1);
      const held = (await sentSince(page, sent1)).filter((s): s is Ramp => s.kind === "ramp" && s.lane === LANE.runtime);
      expect(held.length, "a held key is one fade").toBe(1);
      expect(held[0]!.gain).toBeCloseTo(0.25, 6);
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

void play;
