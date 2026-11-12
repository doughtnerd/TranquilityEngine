import { expect, type Page, play, test } from "./fixtures";
import { addAssets, audioDebug as fullDebug, bootSample, FLAPPY, pauseWorkers, peakOver as peakOverFull, playlist3, readLate, startEvent, stems8, watchConsole } from "./audioMusic";

// The interactive-music milestones' listening sections (ADR 0166/0167; waves plan, "Owner procedures"): one case per
// milestone, grown a case at a time (M4a and M4b are here, M4c follows). Each case is an owner-run page and a headless walker in one:
//
//   headless (the smoke check, default):  npm run test:e2e:slow -- audio-music-listening
//   owner (headphones, a headed window):   E2E_LISTEN=1 npm run test:e2e:slow -- audio-music-listening --headed --workers 1
//
// In the owner run the spec loads the scene, shows the keys on a card over the page and waits for each key; the owner
// presses it and listens. Headless, the spec presses the keys itself. Either way, after an item the spec reads
// `Audio.debug()`, the bus meters and the log of calls the page kept, and fails if the named voice or fade law did not run.
// Headless Chromium has no sound output, so the headless checks read the core's own meters and status.
//
// **M4-0: in-voice stamped records.** One voice among 66 (a crowd of 64 quiet looping voices and the item's own voices;
// the first spec that puts a single stamped record in a busy mix). Every record is stamped (`at` ahead of the audio clock):
// the core applies it inside the voice, so the other voices are untouched and `splitQuanta` stays 0. The keys:
//   1  a stamped fade of one voice to 0.1 over 1.5 s (linear)
//   2  a stamped stop: the voice fades to 0 over 0.4 s and ends
//   3  an equal-length crossfade, 2 s, linear in and out
//   4  the same crossfade with the S-curve
//   5  the same crossfade with the equal-power laws
//   0  stop every item voice and the crowd
// The Music, Ambience, SFX and Engine buses are muted for the page so only the item and its crowd are heard; the items
// play on the Tape bus (its meter shows the item alone) and the crowd on UI.
const LAB = "/editor.html?sample=sound-lab";
const LISTEN = process.env.E2E_LISTEN === "1";

test.describe.configure({ timeout: LISTEN ? 3_600_000 : 180_000 });

type Voice = { id: number; clip: string; bus: string; state: string };
type Debug = { status: string; voices: Voice[]; core: Record<string, number | string | boolean>; musicTotals?: { splitQuanta?: number } };
type Fade = { item: string; role: string; voiceId: number; clip: string; law: string; to: number; seconds: number; at: number; stopAtEnd: boolean };
type Lab = {
  log: Fade[];
  /** The last item that ran: its key, its voices by role (audio ids), and when the stamped records take effect. */
  last: { key: string; ids: Record<string, number>; at: number; endsAt: number } | null;
  /** Items finished (their voices stopped, the crowd stopped) by key, counted. */
  done: Record<string, number>;
  crowd: number;
};

const audioDebug = (page: Page) => page.evaluate(() => ((globalThis as unknown as { __myco?: { Audio: { debug(): unknown } } }).__myco?.Audio.debug() as Debug | undefined) ?? null);
const lab = (page: Page) => page.evaluate(() => (globalThis as unknown as { __m40: Lab }).__m40);

/** The highest peak of a bus's meter over `ms` in the page (one reading can land in a quiet part of the clip). */
const peakOver = (page: Page, bus: string, ms = 300) =>
  page.evaluate(
    async ([name, span]) => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { bus(n: string): { peak: number } } } }).__myco;
      let max = 0;
      const start = performance.now();
      while (performance.now() - start < (span as number)) {
        max = Math.max(max, Audio.bus(name as string).peak);
        await new Promise((r) => setTimeout(r, 10));
      }
      return max;
    },
    [bus, ms] as const,
  );

/**
 * Installs M4-0's page: templates for the lab's clips (captured from silent one-shots, so a voice can be played with
 * options `playOneShot` doesn't have: `loop`, `fadeZero`, `at`), the crowd, the items and the keys.
 */
async function installM40(page: Page, listen: boolean): Promise<void> {
  await page.evaluate((showCard) => {
    type Req = Record<string, unknown> & { path: string };
    type V = { id: number; fadeShaped?(f: Record<string, unknown>): void; stop(s?: number): void; backend?: unknown; inner?: { backend?: unknown } };
    type Backend = { play(req: Req): V | null };
    const g = globalThis as unknown as { __myco: { Audio: { time: number; bus(n: string): { volume: number }; buses: readonly string[]; playOneShot(c: string, o?: object): { voice?: V } } }; __m40?: unknown };
    const { Audio } = g.__myco;
    const state: { log: Fade[]; last: Lab["last"]; done: Record<string, number>; crowd: number } = { log: [], last: null, done: {}, crowd: 0 };
    g.__m40 = state;

    // Templates: a silent one-shot of each clip goes through the backend's `play`, which is wrapped to keep its request.
    const clips = ["noise-loop", "hum-loop", "music-loop", "orbit-pulse-loop", "bright", "radio-loop", "melody-loop"].map((c) => `audio/${c}.wav`).concat(["audio/events/music-pad.wav", "audio/events/music-lead.wav"]);
    const seed = Audio.playOneShot("audio/beep.wav", { volume: 0.0001, bus: "UI" }).voice;
    const be = (seed?.backend ?? seed?.inner?.backend) as Backend | undefined;
    if (!be) throw new Error("the core backend is not reachable from a voice");
    const origPlay = be.play.bind(be);
    const templates: Record<string, Req> = {};
    be.play = (req: Req) => {
      templates[req.path] = { ...req };
      return origPlay(req);
    };
    for (const c of clips) Audio.playOneShot(c, { volume: 0.0001, bus: "UI" });
    for (const n of Audio.buses) if (!["UI", "Tape", "Master"].includes(n)) Audio.bus(n).volume = 0;

    const voices: V[] = [];
    const start = (clip: string, o: { volume: number; bus: string; pitch?: number; fadeZero?: boolean; at?: number }): V => {
      const t = templates[`audio/${clip}.wav`];
      if (!t) throw new Error(`no template for ${clip}`);
      const v = origPlay({ ...t, loop: true, oneShot: false, volume: o.volume, bus: o.bus, pitch: o.pitch ?? 1, ...(o.fadeZero ? { fadeZero: true } : null), ...(o.at !== undefined ? { at: o.at } : null) });
      if (!v) throw new Error(`${clip} did not start`);
      voices.push(v);
      return v;
    };
    const stopAll = () => {
      for (const v of voices.splice(0)) {
        try {
          v.stop(0.05);
        } catch {
          /* ended */
        }
      }
      state.crowd = 0;
    };
    const fade = (item: string, role: string, v: V, clip: string, f: { to: number; seconds: number; law: string; at: number; stopAtEnd?: boolean }) => {
      state.log.push({ item, role, voiceId: v.id, clip, law: f.law, to: f.to, seconds: f.seconds, at: f.at, stopAtEnd: f.stopAtEnd === true });
      v.fadeShaped?.(f);
    };
    // The crowd: 64 quiet looping voices of five clips at spread pitches (so they don't add coherently).
    const crowd = () => {
      const names = ["noise-loop", "hum-loop", "music-loop", "orbit-pulse-loop", "bright"];
      for (let i = 0; i < 64; i++) start(names[i % names.length]!, { volume: 0.004, bus: "UI", pitch: 0.6 + (i % 11) * 0.11 });
      state.crowd = 64;
    };

    type Item = { name: string; run(at: number): { ids: Record<string, number>; seconds: number } };
    const crossfade = (name: string, lawOut: string, lawIn: string): Item => ({
      name,
      run(at) {
        const a = start("events/music-pad", { volume: 0.5, bus: "Tape" });
        const b = start("events/music-lead", { volume: 0.5, bus: "Tape", fadeZero: true, at });
        fade(name, "out", a, "music-pad", { to: 0, seconds: 2, law: lawOut, at, stopAtEnd: true });
        fade(name, "in", b, "music-lead", { to: 1, seconds: 2, law: lawIn, at });
        return { ids: { out: a.id, in: b.id }, seconds: 2 };
      },
    });
    const items: Record<string, Item> = {
      "1": {
        name: "fade",
        run(at) {
          const v = start("radio-loop", { volume: 0.6, bus: "Tape" });
          fade("fade", "target", v, "radio-loop", { to: 0.1, seconds: 1.5, law: "linear", at });
          return { ids: { target: v.id }, seconds: 1.5 };
        },
      },
      "2": {
        name: "stop",
        run(at) {
          const v = start("melody-loop", { volume: 0.6, bus: "Tape" });
          fade("stop", "target", v, "melody-loop", { to: 0, seconds: 0.4, law: "linear", at, stopAtEnd: true });
          return { ids: { target: v.id }, seconds: 0.4 };
        },
      },
      "3": crossfade("crossfade-linear", "linear", "linear"),
      "4": crossfade("crossfade-sCurve", "sCurve", "sCurve"),
      "5": crossfade("crossfade-equalPower", "equalPowerOut", "equalPowerIn"),
    };
    let busy = false;
    const press = (key: string) => {
      if (key === "0") {
        stopAll();
        return;
      }
      const item = items[key];
      if (!item || busy) return;
      busy = true;
      stopAll();
      crowd();
      // The stamped records land 1 s on, after every voice of the item has started.
      const at = Audio.time + 1;
      const { ids, seconds } = item.run(at);
      state.last = { key, ids, at, endsAt: at + seconds };
      setTimeout(() => {
        stopAll();
        state.done[key] = (state.done[key] ?? 0) + 1;
        busy = false;
      }, (seconds + 2.5) * 1000);
    };
    window.addEventListener("keydown", (e) => press(e.key));

    if (showCard) {
      const card = document.createElement("pre");
      card.style.cssText = "position:fixed;z-index:99999;left:12px;top:12px;margin:0;padding:10px 14px;background:#000d;color:#fff;font:14px/1.45 monospace;border-radius:6px;pointer-events:none;max-width:70vw;white-space:pre-wrap";
      card.textContent = "M4-0: one voice among 66, every record stamped\n1 fade   2 stop   3 crossfade linear   4 crossfade S-curve   5 crossfade equal power   0 stop all\nPress a key, listen. The test then reads the voice and law that ran.";
      document.body.append(card);
    }
  }, listen);
}

/** The owner's key (waited for) or the spec's own press (headless); resolves once the item has run to its end. */
async function runItem(page: Page, key: string, before: number): Promise<void> {
  if (LISTEN) {
    process.stdout.write(`\n[listen] M4-0: press ${key} in the page (it plays about ${key === "2" ? 4 : 6} s), listen, then the spec checks it.\n`);
  } else {
    await page.keyboard.press(key);
  }
  await page.waitForFunction(([k, n]) => ((globalThis as unknown as { __m40: Lab }).__m40.done[k as string] ?? 0) > (n as number), [key, before] as const, { timeout: LISTEN ? 3_600_000 : 60_000 });
}

test.describe("listening M4-0: in-voice stamped records", () => {
  test("M4-0: a stamped fade, a stamped stop and three crossfade curves on one voice among many", { tag: "@slow" }, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(LAB);
    await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
    await play(page);
    await page.mouse.click(480, 250); // the user gesture that unlocks the context
    await expect.poll(async () => (await audioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
    expect((await audioDebug(page))!.core.backend).toBe("core");
    await installM40(page, LISTEN);
    // The clips decode on their first play: wait for the templates' silent plays to be gone from the voice table.
    await page.waitForTimeout(1500);

    const splitOf = async () => {
      const d = (await audioDebug(page))!;
      return d.musicTotals?.splitQuanta ?? (typeof d.core.splitQuanta === "number" ? d.core.splitQuanta : null);
    };
    const splitBefore = await splitOf();
    expect(splitBefore, "Audio.debug() reports splitQuanta").not.toBeNull();

    const expected: Record<string, { item: string; roles: Record<string, { clip: string; law: string; stop: boolean }> }> = {
      "1": { item: "fade", roles: { target: { clip: "radio-loop", law: "linear", stop: false } } },
      "2": { item: "stop", roles: { target: { clip: "melody-loop", law: "linear", stop: true } } },
      "3": { item: "crossfade-linear", roles: { out: { clip: "music-pad", law: "linear", stop: true }, in: { clip: "music-lead", law: "linear", stop: false } } },
      "4": { item: "crossfade-sCurve", roles: { out: { clip: "music-pad", law: "sCurve", stop: true }, in: { clip: "music-lead", law: "sCurve", stop: false } } },
      "5": { item: "crossfade-equalPower", roles: { out: { clip: "music-pad", law: "equalPowerOut", stop: true }, in: { clip: "music-lead", law: "equalPowerIn", stop: false } } },
    };

    for (const key of ["1", "2", "3", "4", "5"]) {
      await test.step(`key ${key}: ${expected[key]!.item}`, async () => {
        const { done, last: prev } = await lab(page);
        const before = done[key] ?? 0;
        const prevAt = prev?.at ?? 0;
        // The item starts on the key; read its state as soon as it has begun, before its stamped records land.
        const running = (async () => {
          await page.waitForFunction(([k, t]) => { const l = (globalThis as unknown as { __m40: Lab }).__m40.last; return l?.key === k && l.at > (t as number); }, [key, prevAt] as const, { timeout: LISTEN ? 3_600_000 : 20_000 });
          const l = (await lab(page)).last!;
          // One voice among many: the crowd and the item's own voices are all in the table, the named voices playing.
          await expect.poll(async () => (await audioDebug(page))!.voices.length, { timeout: 15_000, message: "the crowd and the item are in the table" }).toBeGreaterThanOrEqual(60);
          const d = (await audioDebug(page))!;
          for (const [role, id] of Object.entries(l.ids)) {
            const row = d.voices.find((v) => v.id === id);
            expect(row, `the ${role} voice ${id} is in the voice table`).toBeTruthy();
            expect(row!.clip, `the ${role} voice plays ${expected[key]!.roles[role]!.clip}`).toContain(expected[key]!.roles[role]!.clip);
          }
          expect(await peakOver(page, "Tape"), "the item is audible on its bus before its records land").toBeGreaterThan(0.01);
        })();
        const finished = runItem(page, key, before);
        await Promise.all([running, finished]);

        // What ran: the page's log names each voice, law and stop; the stop and the fade-out left the table.
        const { log, last } = await lab(page);
        const entries = log.filter((e) => e.item === expected[key]!.item);
        expect(entries.length, "one stamped fade per role").toBe(Object.keys(expected[key]!.roles).length);
        for (const [role, want] of Object.entries(expected[key]!.roles)) {
          const e = entries.find((x) => x.role === role)!;
          expect(e, `${role}: logged`).toBeTruthy();
          expect({ voice: e.voiceId, clip: e.clip, law: e.law, stopAtEnd: e.stopAtEnd }, `${role}: the named voice and law`).toEqual({ voice: last!.ids[role], clip: want.clip, law: want.law, stopAtEnd: want.stop });
          expect(e.at, `${role}: stamped ahead of the audio clock`).toBeGreaterThan(0);
        }
        expect(await splitOf(), "no quantum split by the stamped records").toBe(splitBefore);
      });
    }

    // The effects, checked while an item runs: a fresh run of key 2 (the stop) and the meter before and after.
    await test.step("the stamped stop ends its voice and silences its bus; the crowd plays on", async () => {
      const { done, last: prev } = await lab(page);
      const before = done["2"] ?? 0;
      const prevAt = prev?.at ?? 0;
      if (LISTEN) process.stdout.write("\n[listen] M4-0: press 2 once more (the stop again; the test watches its bus fall silent).\n");
      else await page.keyboard.press("2");
      await page.waitForFunction((t) => { const l = (globalThis as unknown as { __m40: Lab }).__m40.last; return l?.key === "2" && l.at > (t as number); }, prevAt, { timeout: LISTEN ? 3_600_000 : 20_000 });
      const l = (await lab(page)).last!;
      await expect.poll(async () => (await peakOver(page, "Tape")), { timeout: 10_000, message: "audible before the stamp" }).toBeGreaterThan(0.01);
      await page.waitForFunction((end) => (globalThis as unknown as { __myco: { Audio: { time: number } } }).__myco.Audio.time > (end as number) + 0.3, l.endsAt, { timeout: 15_000 });
      const d = (await audioDebug(page))!;
      expect(d.voices.find((v) => v.id === l.ids.target), "the stopped voice left the table").toBeUndefined();
      expect(d.voices.length, "the 64 crowd voices play on").toBeGreaterThanOrEqual(60);
      await expect.poll(() => peakOver(page, "Tape", 200), { timeout: 8_000, message: "its bus falls silent (the meter holds a peak for a moment)" }).toBeLessThan(0.002);
      await page.waitForFunction(([k, n]) => ((globalThis as unknown as { __m40: Lab }).__m40.done[k as string] ?? 0) > (n as number), ["2", before] as const, { timeout: 20_000 });
      expect(await splitOf(), "still no split").toBe(splitBefore);
    });

    info.annotations.push({ type: "splitQuanta", description: `${await splitOf()} (before: ${splitBefore})` });
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// M4a: segments, stems and playlists (E1). The music events are built in the spec from the Sound Lab's stems (`audioMusic.ts`), on
// the Tape bus with the Music, Ambience, SFX and Engine buses muted so only the item is heard. The keys (the owner presses them,
// the headless run presses them itself):
//   1  eight stems start together on a cue (pad, pulse, lead, melody, each twice; the two melodies stream): they sound as one
//      band, entering on the same instant, no flam, no phasing between the doubled stems
//   2  the same, with a slow ring: the melody file is held back 1.5 s, so the music starts late, and every stem starts late together
//   3  a held group: while the eight stems play, the decoder worker is paused until the core holds the group, then resumed at
//      once (well under a second; a hold over 1 s is given up on by design). The streamed stems run dry, the whole group dips
//      together over about 5 ms and comes back together, aligned (the worker is paused through the DevTools protocol, Chromium only)
//   4  a playlist of three 4 s items (A, B, C) plays for 30 s: each change lands on the beat with no gap and no click
//   5  the flappy sample's town music (a streamed segment) for 20 s
// The 10-minute playlist is the exit check of M4a (audio-music-a.spec.ts, `@slow`, `E2E_PLAYLIST_SECONDS`); item 4 is its ear's
// sample.
type M4aState = { keys: Record<string, number> };
const m4aKeys = (page: Page) => page.evaluate(() => (globalThis as unknown as { __m4a: M4aState }).__m4a.keys);

/** The page's card of keys and a counter of the keys pressed. Installed on every page the case opens (the Flappy page too). */
async function installM4aCard(page: Page, listen: boolean, text: string): Promise<void> {
  await page.evaluate(
    ([showCard, lines]) => {
      const g = globalThis as unknown as { __m4a?: M4aState };
      g.__m4a ??= { keys: {} };
      const state = g.__m4a;
      window.addEventListener("keydown", (e) => (state.keys[e.key] = (state.keys[e.key] ?? 0) + 1));
      if (showCard) {
        const card = document.createElement("pre");
        card.style.cssText = "position:fixed;z-index:99999;left:12px;top:12px;margin:0;padding:10px 14px;background:#000d;color:#fff;font:14px/1.45 monospace;border-radius:6px;pointer-events:none;max-width:70vw;white-space:pre-wrap";
        card.textContent = lines as string;
        document.body.append(card);
      }
    },
    [listen, text] as const,
  );
}

/** The owner's key (waited for) or the spec's own press (headless): resolves once the key has been pressed. */
async function m4aKey(page: Page, key: string, what: string): Promise<void> {
  const before = (await m4aKeys(page))[key] ?? 0;
  if (LISTEN) process.stdout.write(`\n[listen] M4a: press ${key} in the page (${what}), listen, then the spec checks it.\n`);
  else await page.keyboard.press(key);
  await page.waitForFunction(([k, n]) => ((globalThis as unknown as { __m4a: M4aState }).__m4a.keys[k as string] ?? 0) > (n as number), [key, before] as const, { timeout: LISTEN ? 3_600_000 : 20_000 });
}

/** How long the owner listens to an item in a headed run, and the headless run's wait (shorter: nothing to hear). */
const hear = (page: Page, ms: number) => page.waitForTimeout(LISTEN ? ms : Math.min(ms, 6_000));

type M4aRow = { id: number; asset: string; state: string; segment: string | null; tempo: number; stems: { streamed: boolean; ring: number | null }[]; groups: { state: string; primed: number; of: number }[]; groupsHeld: number; lateGroups: number };
const m4aRow = async (page: Page, asset: string): Promise<M4aRow | undefined> => ((await fullDebug(page)) as unknown as { music?: M4aRow[] }).music?.find((r) => r.asset.includes(asset));
const stopItem = (page: Page, name: string) => page.evaluate((n) => (globalThis as unknown as { __e1?: Record<string, { stop(s?: number): void }> }).__e1?.[n as string]?.stop(0.2), name);
/** A stopped music event is over: none of its voices is left and its rings are back (its row may linger as "ending", F-17). */
const stopped = (page: Page, asset: string) =>
  expect
    .poll(
      async () => {
        const d = (await fullDebug(page))!;
        const row = d.music?.find((r) => r.asset.includes(asset));
        return (!row || (row.state === "ending" && d.voices.every((v) => v.event !== row.id))) && d.musicTotals!.poolUsed === 0;
      },
      { timeout: 15_000, message: `${asset} stopped` },
    )
    .toBe(true);
/** The counters since the last `holdBase` (the held-group key moves the cumulative ones on purpose): nothing late, held or abandoned, no new slip, no split. */
let holdBase: Awaited<ReturnType<typeof readLate>> = null;
const cleanCounters = async (page: Page, what: string) => {
  const now = (await readLate(page))!;
  const b = holdBase ?? { groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, maxSlipFrames: 0, splitQuanta: 0 };
  expect(now, `${what}: groupsLate, groupsHeld, groupsAbandoned, slip and splits`).toEqual(b);
};

test.describe("listening M4a: segments, stems and playlists", () => {
  test("M4a: eight stems, a slow ring, a held group, a playlist and the flappy streamed segment", { tag: "@slow" }, async ({ page, context }, info) => {
    info.setTimeout(LISTEN ? 3_600_000 : 240_000);
    const seen = watchConsole(page);
    await bootSample(page, LAB);
    await installM4aCard(page, LISTEN, "M4a: segments, stems, playlists (Tape bus alone)\n1 eight stems   2 slow ring   3 held group (worker paused)   4 playlist   5 flappy town music\nPress a key, listen. The test then reads the music rows and the counters.");
    await page.evaluate(() => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { buses: readonly string[]; bus(n: string): { volume: number } } } }).__myco;
      for (const n of Audio.buses) if (!["UI", "Tape", "Master"].includes(n)) Audio.bus(n).volume = 0;
    });
    // The slow ring's file: the melody under another URL (so nothing is cached for it), held back when asked.
    let slowHits = 0;
    let slowMs = 0;
    await context.route("**/melody-loop.wav?slow=1", async (route) => {
      slowHits++;
      await new Promise((r) => setTimeout(r, slowMs));
      await route.continue();
    });
    const slowUrl = await page.evaluate(() => `${(globalThis as unknown as { __myco: { Assets: { url(p: string): string } } }).__myco.Assets.url("audio/melody-loop.wav")}?slow=1`);
    await page.evaluate(
      ([url]) => {
        const { Assets } = (globalThis as unknown as { __myco: { Assets: { addSource(s: unknown): void; fromObject(m: Record<string, unknown>): unknown } } }).__myco;
        Assets.addSource(Assets.fromObject({ "e1/slow-melody.wav": url, "e1/slow-melody.wav.meta.json": { format: "myco.import@1", stream: true } }));
      },
      [slowUrl] as const,
    );
    const slow8 = JSON.parse(JSON.stringify(stems8())) as { root: { tracks: { clip: string }[] } };
    for (const t of slow8.root.tracks) if (t.clip === "audio/melody-loop.wav") t.clip = "e1/slow-melody.wav";
    await addAssets(page, { "e1/stems8.audioevent.json": stems8(), "e1/slow8.audioevent.json": slow8, "e1/list.audioevent.json": playlist3(0) });

    /** The eight-stem item once it plays: the group is one, the six decoded stems share a playhead, it is audible. */
    const checkEight = async (asset: string, what: string) => {
      await expect.poll(async () => (await m4aRow(page, asset))?.state, { timeout: 30_000, message: `${what}: playing` }).toBe("playing");
      const row = (await m4aRow(page, asset))!;
      expect(row.groups.map((g) => ({ primed: g.primed, of: g.of })), `${what}: one group of eight`).toEqual([{ primed: 8, of: 8 }]);
      await expect.poll(async () => (await fullDebug(page))!.voices.filter((v) => v.event === row.id && v.state === "playing" && v.playheadSeconds !== null).length, { timeout: 15_000, message: `${what}: all eight stems play` }).toBe(8);
      const heads = (await fullDebug(page))!.voices.filter((v) => v.event === row.id && v.playheadSeconds !== null && !v.clip.includes("melody")).map((v) => v.playheadSeconds!);
      expect(Math.max(...heads) - Math.min(...heads), `${what}: the decoded stems share a playhead`).toBe(0);
      expect(await peakOverFull(page, "Tape", 600), `${what}: audible`).toBeGreaterThan(0.01);
    };
    const audioTime = () => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { time: number } } }).__myco.Audio.time);

    await test.step("key 1: eight stems start together", async () => {
      await m4aKey(page, "1", "eight stems, 10 s");
      await startEvent(page, "eight", "e1/stems8.audioevent.json", { at: (await audioTime()) + 1 });
      await checkEight("stems8", "eight stems");
      await hear(page, 10_000);
      await cleanCounters(page, "eight stems");
      await stopItem(page, "eight");
      await stopped(page, "stems8");
    });

    await test.step("key 2: a slow ring starts the music late, every stem together", async () => {
      slowMs = 1_500;
      await m4aKey(page, "2", "eight stems with a slow ring, 10 s");
      const t0 = Date.now();
      await startEvent(page, "slow", "e1/slow8.audioevent.json");
      await checkEight("slow8", "slow ring");
      const took = Date.now() - t0;
      expect(slowHits, "the held-back file was asked for").toBeGreaterThan(0);
      expect(took, "the music began after the held-back file arrived").toBeGreaterThan(slowMs - 200);
      info.annotations.push({ type: "slow ring", description: `${took} ms from play to playing with the file held back ${slowMs} ms` });
      await hear(page, 10_000);
      await stopItem(page, "slow");
      await stopped(page, "slow8");
      slowMs = 0;
    });

    await test.step("key 3: a held group (the decoder worker paused)", async () => {
      await m4aKey(page, "3", "eight stems; the decoder worker is paused until the group is held, then resumed at once");
      await startEvent(page, "held", "e1/stems8.audioevent.json");
      await checkEight("stems8", "held group");
      const paused = await pauseWorkers(page, true, null);
      expect(paused.ids.length, "the decoder worker was reached").toBeGreaterThan(0);
      // The rings drain, a streamed stem runs dry and the core holds the whole group: silence, position pinned. Resumed at once: a hold over 1 s is given up on.
      await expect.poll(async () => (await readLate(page))?.groupsHeld, { timeout: 45_000, intervals: [50], message: "the group was held" }).toBeGreaterThanOrEqual(1);
      await pauseWorkers(page, false, paused);
      await paused.cdp.detach();
      // It resumes together: the six decoded stems are back on one playhead, the group was not given up on.
      const playheads = async () => (await fullDebug(page))!.voices.filter((v) => v.playheadSeconds !== null && v.state === "playing" && !v.clip.includes("melody")).map((v) => v.playheadSeconds!);
      await expect.poll(async () => (await playheads()).length, { timeout: 30_000, message: "the music plays on after the worker resumes" }).toBe(6);
      const heads = await playheads();
      expect(Math.max(...heads) - Math.min(...heads), "resumed on one playhead").toBe(0);
      const late = (await readLate(page))!;
      expect(late.groupsHeld, "held").toBeGreaterThanOrEqual(1);
      expect({ abandoned: late.groupsAbandoned, split: late.splitQuanta }, "resumed, not abandoned").toEqual({ abandoned: 0, split: 0 });
      info.annotations.push({ type: "held group", description: `groupsHeld ${late.groupsHeld}, largest slip ${late.maxSlipFrames} frames` });
      await stopItem(page, "held");
      await stopped(page, "stems8");
      holdBase = (await readLate(page))!;
    });

    await test.step("key 4: a playlist of three items, 30 s", async () => {
      await m4aKey(page, "4", "playlist A, B, C forever, 30 s");
      await startEvent(page, "list", "e1/list.audioevent.json");
      await expect.poll(async () => (await m4aRow(page, "list"))?.state, { timeout: 30_000 }).toBe("playing");
      const order: string[] = [];
      const until = Date.now() + (LISTEN ? 30_000 : 17_000);
      while (Date.now() < until) {
        const seg = (await m4aRow(page, "list"))?.segment;
        if (seg && order[order.length - 1] !== seg) order.push(seg);
        await page.waitForTimeout(100);
      }
      expect(order.length, "the playlist advanced").toBeGreaterThanOrEqual(3);
      const next: Record<string, string> = { A: "B", B: "C", C: "A" };
      for (let i = 1; i < order.length; i++) expect(order[i], `item ${i} follows ${order[i - 1]}`).toBe(next[order[i - 1]!]);
      expect((await m4aRow(page, "list"))!.lateGroups, "no late group").toBe(0);
      await cleanCounters(page, "playlist");
      await stopItem(page, "list");
      await stopped(page, "list");
    });

    await test.step("key 5: the flappy sample's streamed segment, 20 s", async () => {
      await m4aKey(page, "5", "opens the Flappy sample: its town music, 20 s");
      await bootSample(page, FLAPPY);
      holdBase = null; // a new page: its counters start at 0
      await installM4aCard(page, LISTEN, "M4a: the flappy sample's town music, a streamed segment (105 bpm). Listen for 20 s: steady, no gap at the loop.");
      await expect.poll(async () => (await m4aRow(page, "town"))?.state, { timeout: 60_000 }).toBe("playing");
      const row = (await m4aRow(page, "town"))!;
      expect(row.stems[0]!.streamed).toBe(true);
      expect(row.stems[0]!.ring).not.toBeNull();
      expect(row.tempo).toBe(105);
      await hear(page, 20_000);
      expect((await m4aRow(page, "town"))!.state).toBe("playing");
      await cleanCounters(page, "flappy");
    });

    for (const a of info.annotations) console.log(`[music-listen] ${a.type}: ${a.description}`);
    expect(seen.errors).toEqual([]);
    // The slow ring (key 2) and the paused worker (key 3) raise the engine's estimate of the prime time, and it says so once per
    // event ("the prime lead is longer than one beat"): that is the right warning there. Nothing else may be warned.
    expect(seen.warnings.filter((w) => !/prime lead \(\d+ ms\) is longer than one beat/.test(w))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// M4b: transitions, stingers and loop exits (E2), on SM2's scene: the Sound Lab's music page (key M on the tour; its own keys are
// the item keys, so the owner presses the page's keys and the walker presses the same ones). The music plays on the Music bus; the
// Ambience, SFX, Engine and Tape buses are muted. The page starts the world switch in explore (120 bpm, every change lands on a bar
// line). The keys the owner presses, in this order (the card lists them; the spec waits for each):
//   2  explore to combat: a cut on the next bar line
//   1  combat to explore: a 2-beat equal-power crossfade on the next bar line
//   3  explore to calm: a 4-beat linear crossfade
//   1  calm to explore: a 4-beat S-curve crossfade
//   3  explore to calm again (the way to the bridge: the same linear crossfade)
//   2  calm to combat: a bridge, a one-bar noise riser between the two
//   3  combat to calm: no rule of its own, the default rule (a 1-beat equal-power crossfade)
//   L  the loop: the 2-bar body with its 1-bar tail loops; then L again leaves it at the end of the pass, and the tail rings out
//   1  back to the world (explore)
//   T  a stinger on the next beat; Y a stinger on the next bar
//   3, then 2 within a second: a switch that changes its mind before it lands
//   O  stops
// The clips are decoded first by silent one-shots (the first play of a looping segment whose clips were never decoded ends at its
// first loop end: audio-music-b.spec.ts, the fixme). Headless, the walker presses the keys itself and waits out each change.
type M4bState = { keys: Record<string, number> };
const m4bCard =
  "M4b: transitions, stingers, loop exits (the Sound Lab's music page; Music bus)\n" +
  "2 cut to combat   1 crossfade to explore   3 crossfade to calm   (1 and 3 again for the other curves)\n" +
  "3 then 2: calm to combat through the bridge   3: combat to calm (default rule)\n" +
  "L loop with a tail, L again to leave it   1 back to explore   T stinger on the beat   Y stinger on the bar\n" +
  "3 then 2 at once: change your mind before it lands   O stops. Press a key when asked, listen, then the test reads the rows.";

async function installM4bCard(page: Page, listen: boolean): Promise<void> {
  await page.evaluate(
    ([showCard, text]) => {
      const g = globalThis as unknown as { __m4b?: M4bState };
      g.__m4b ??= { keys: {} };
      const state = g.__m4b;
      window.addEventListener("keydown", (e) => (state.keys[e.key.toLowerCase()] = (state.keys[e.key.toLowerCase()] ?? 0) + 1));
      if (showCard) {
        const card = document.createElement("pre");
        card.style.cssText = "position:fixed;z-index:99999;left:12px;bottom:12px;margin:0;padding:10px 14px;background:#000d;color:#fff;font:14px/1.45 monospace;border-radius:6px;pointer-events:none;max-width:90vw;white-space:pre-wrap";
        card.textContent = text as string;
        document.body.append(card);
      }
    },
    [listen, m4bCard] as const,
  );
}

/** The owner's key (waited for) or the spec's own press (headless): resolves once the key has been pressed. `what` is what the key does and what to listen for. */
async function m4bKey(page: Page, key: string, what: string): Promise<void> {
  const k = key.toLowerCase();
  const before = await page.evaluate((x) => (globalThis as unknown as { __m4b: M4bState }).__m4b.keys[x] ?? 0, k);
  if (LISTEN) process.stdout.write(`\n[listen] M4b: press ${key.toUpperCase()} in the page: ${what}\n`);
  else await page.keyboard.press(key);
  await page.waitForFunction(([x, n]) => ((globalThis as unknown as { __m4b: M4bState }).__m4b.keys[x as string] ?? 0) > (n as number), [k, before] as const, { timeout: LISTEN ? 3_600_000 : 20_000 });
}

type M4bPending = { to: string; ruleKey: string; rule: number; tier: number; parent: string };
type M4bRow = M4aRow & { pending: M4bPending | null; stingers: { played: number; late: number; skipped: number; dropped: number } };
const m4bRows = async (page: Page): Promise<M4bRow[]> => (((await fullDebug(page)) as unknown as { music?: M4bRow[] }).music ?? []);

test.describe("listening M4b: transitions, stingers and loop exits", () => {
  test("M4b: every seam, a loop exit with a tail, a stinger on the beat and the bar, and a switch that changes its mind", { tag: "@slow" }, async ({ page }, info) => {
    info.setTimeout(LISTEN ? 3_600_000 : 300_000);
    const seen = watchConsole(page);
    holdBase = null; // a new page: its counters start at 0
    await bootSample(page, LAB);
    await page.evaluate((clips) => {
      const { Audio } = (globalThis as unknown as { __myco: { Audio: { buses: readonly string[]; bus(n: string): { volume: number }; playOneShot(c: string, o?: object): unknown } } }).__myco;
      for (const n of Audio.buses) if (!["UI", "Music", "Master"].includes(n)) Audio.bus(n).volume = 0;
      for (const c of clips) Audio.playOneShot(`audio/music/${c}.wav`, { volume: 0.0001, bus: "UI" });
    }, ["bridge-riser", "calm-bells", "calm-pad", "combat-bass", "combat-drums", "explore-arp", "explore-pad", "loop-body", "stinger-hit"]);
    await page.waitForTimeout(2_500);
    await page.keyboard.press("m"); // the music page; the spec opens it, the owner presses the page's keys from here
    await installM4bCard(page, LISTEN);
    const world = async () => (await m4bRows(page)).find((r) => r.asset.includes("music-world"));
    await expect.poll(async () => (await world())?.state, { timeout: 30_000, message: "the world switch plays" }).toBe("playing");
    expect((await world())!.segment).toBe("explore");
    await hear(page, 4_000);

    /** After the key: the row's pending change names `want`'s rule, the change lands (through `via`, a bridge's segment, first), and settles. */
    const change = async (to: string, want: { ruleKey: string; rule: number; tier: number }, via?: string) => {
      let pend: M4bPending | null = null;
      const segments: string[] = [];
      await expect
        .poll(
          async () => {
            const r = await world();
            if (r?.pending) pend = r.pending;
            if (r?.segment && segments.at(-1) !== r.segment) segments.push(r.segment);
            return r?.segment;
          },
          { timeout: LISTEN ? 60_000 : 25_000, intervals: [50], message: `the change to ${to} lands` },
        )
        .toBe(to);
      expect(pend, "the row named the pending change").toBeTruthy();
      expect({ to: pend!.to, ruleKey: pend!.ruleKey, rule: pend!.rule, tier: pend!.tier, parent: pend!.parent }, "the rule row").toEqual({ to, parent: "world", ...want });
      if (via) expect(segments, "through the bridge").toContain(via);
      else expect(segments, "no bridge").not.toContain("riser");
      await expect.poll(async () => (await world())?.pending ?? null, { timeout: 20_000, message: "the change is done" }).toBeNull();
      expect(await peakOverFull(page, "Music", 600), `${to} is audible`).toBeGreaterThan(0.01);
      await cleanCounters(page, `to ${to}`);
    };

    const seams: { key: string; what: string; to: string; rule: { ruleKey: string; rule: number; tier: number }; via?: string; hearMs: number }[] = [
      { key: "2", what: "explore to combat, a cut. It lands on the next bar line (within 2 s): the old music stops and combat starts on the same instant; no gap, no click, no overlap.", to: "combat", rule: { ruleKey: "explore>combat", rule: 0, tier: 1 }, hearMs: 5_000 },
      { key: "1", what: "combat to explore, a 2-beat (1 s) equal-power crossfade on the next bar line: the level stays steady through the hand-over, no dip, no jump.", to: "explore", rule: { ruleKey: "combat>explore", rule: 1, tier: 1 }, hearMs: 5_000 },
      { key: "3", what: "explore to calm, a 4-beat (2 s) LINEAR crossfade on the next bar line: a slight dip in the middle of the hand-over, no jump at either end.", to: "calm", rule: { ruleKey: "explore>calm", rule: 2, tier: 1 }, hearMs: 6_000 },
      { key: "1", what: "calm to explore, a 4-beat (2 s) S-CURVE crossfade on the next bar line: slow at both ends, quick in the middle, no jump at either end.", to: "explore", rule: { ruleKey: "calm>explore", rule: 3, tier: 1 }, hearMs: 6_000 },
      { key: "3", what: "explore to calm again (the same linear crossfade): this is the way to the bridge; wait for calm to settle.", to: "calm", rule: { ruleKey: "explore>calm", rule: 2, tier: 1 }, hearMs: 4_000 },
      { key: "2", what: "calm to combat through the BRIDGE: on the next bar line calm crossfades (1 beat) into a one-bar noise riser, and combat starts at full level on the riser's last sample (2 s later): no gap, no click, no doubled beat.", to: "combat", rule: { ruleKey: "calm>combat", rule: 4, tier: 1 }, via: "riser", hearMs: 6_000 },
      { key: "3", what: "combat to calm: no rule of its own, so the default rule, a 1-beat (0.5 s) equal-power crossfade on the next bar line.", to: "calm", rule: { ruleKey: "*>*", rule: 5, tier: 4 }, hearMs: 5_000 },
    ];
    for (const s of seams) {
      await test.step(`key ${s.key}: ${s.rule.ruleKey}`, async () => {
        await m4bKey(page, s.key, s.what);
        await change(s.to, s.rule, s.via);
        await hear(page, s.hearMs);
      });
    }

    await test.step("key L: the loop with a tail; L again leaves it", async () => {
      await m4bKey(page, "l", "the loop: a 2-bar body (4 s) with a 1-bar tail (a crash and a chord) that rings over the start of the next pass. Listen for two or more passes: a steady loop, the tail never cut.");
      const loop = async () => (await m4bRows(page)).find((r) => r.asset.includes("music-loop"));
      await expect.poll(async () => (await loop())?.state, { timeout: 30_000, message: "the loop plays" }).toBe("playing");
      expect((await loop())!.segment).toBe("loopexit");
      // Headless waits two passes and a bit; the owner presses L when ready (after at least two passes, 8 s).
      if (!LISTEN) await page.waitForTimeout(9_500);
      let maxHead = 0;
      const sampling = setInterval(() => {
        void fullDebug(page).then((d) => {
          const v = d?.voices.find((x) => x.clip.includes("loop-body"));
          if (v?.playheadSeconds != null) maxHead = Math.max(maxHead, v.playheadSeconds);
        });
      }, 60);
      const before = Date.now();
      try {
        await m4bKey(page, "l", "L again releases the loop: the pass playing finishes (the tail rings over the end), then the music plays on to its end. Listen: the tail rings out whole, the music ends without a click.");
        await expect.poll(async () => { const r = await loop(); return !r || r.state === "ending"; }, { timeout: 30_000, message: "the loop ends after the release" }).toBe(true);
      } finally {
        clearInterval(sampling);
      }
      info.annotations.push({ type: "loop exit", description: `the body played to ${maxHead.toFixed(2)} s of its clip, ended ${((Date.now() - before) / 1000).toFixed(1)} s after the release key` });
      expect(maxHead, "after the release the body plays on past its 4 s loop end: the tail rings out").toBeGreaterThan(4.3);
      await cleanCounters(page, "loop exit");
    });

    await test.step("key 1: back to the world, then a stinger on the beat (T) and on the bar (Y)", async () => {
      await m4bKey(page, "1", "back to the world switch in explore (the loop is over, so this starts it again).");
      await expect.poll(async () => { const r = await world(); return r?.state === "playing" && r.segment === "explore"; }, { timeout: 30_000, message: "the world plays explore again" }).toBe(true);
      await hear(page, 3_000);
      for (const [key, what] of [
        ["t", "a stinger (a short hit) on the next BEAT, over the music: the music carries on unchanged, the hit lands on the beat."],
        ["y", "a stinger on the next BAR line, over the music: the music carries on unchanged, the hit lands on the bar line."],
      ] as const) {
        const before = (await world())!.stingers.played;
        await m4bKey(page, key, what);
        await expect.poll(async () => (await world())?.stingers.played, { timeout: 10_000, message: `${key}: the stinger is played` }).toBe(before + 1);
        await hear(page, 3_000);
        expect((await world())!.segment, "the music carries on in explore").toBe("explore");
      }
      await cleanCounters(page, "stingers");
    });

    await test.step("keys 3 then 2: a switch that changes its mind before it lands", async () => {
      const segments: string[] = [];
      const watch = setInterval(() => void world().then((r) => r?.segment && segments.at(-1) !== r.segment && segments.push(r.segment)), 50);
      try {
        await m4bKey(page, "3", "a change to calm is asked...");
        if (!LISTEN) await page.waitForTimeout(250);
        await m4bKey(page, "2", "...and within a second, combat instead (press it before the bar line: the music goes to combat and calm is never heard).");
        await expect.poll(async () => { const r = await world(); return r?.segment === "combat" && r.pending === null; }, { timeout: 30_000, message: "the music ends up in combat" }).toBe(true);
      } finally {
        clearInterval(watch);
      }
      // Headless presses 250 ms apart, so calm is never entered. The owner may have been slower than the bar line: noted, not failed.
      if (LISTEN) info.annotations.push({ type: "switch", description: segments.includes("calm") ? "calm was entered before the second key (pressed too late)" : "calm was never entered" });
      else expect(segments, "calm is never entered").not.toContain("calm");
      await hear(page, 4_000);
      await cleanCounters(page, "switch");
    });

    await test.step("key O: stops", async () => {
      await m4bKey(page, "o", "stops the music.");
      await expect.poll(async () => (await m4bRows(page)).filter((r) => r.state !== "ending").length, { timeout: 15_000, message: "the music stops" }).toBe(0);
    });

    for (const a of info.annotations) console.log(`[music-listen] ${a.type}: ${a.description}`);
    expect(seen.errors).toEqual([]);
    expect(seen.warnings).toEqual([]);
  });
});
