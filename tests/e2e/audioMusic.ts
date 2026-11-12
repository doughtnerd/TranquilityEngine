import type { CDPSession } from "@playwright/test";
import { expect, type Page, play } from "./fixtures";

// Shared helpers of the interactive-music e2e specs (ADR 0166/0167, M4a): `audio-music-a.spec.ts` and the M4a case of
// `audio-music-listening.spec.ts`. The music events are built here, in the spec, from the Sound Lab's clips and added to the
// page's asset sources (`Assets.addSource`, in front of the project's), so no sample is edited and a spec can make the
// scene an item needs (8 stems, a switch with rules, a stinger, a 3-item playlist).

export const LAB = "/editor.html?sample=sound-lab";
export const FLAPPY = "/editor.html?sample=flappy";

/** The Sound Lab's 4 s, 24 kHz mono stems (the same length, as a segment needs): pad, pulse and lead decode, the melody streams (its sidecar). */
export const STEM = {
  pad: "audio/events/music-pad.wav",
  pulse: "audio/events/music-pulse.wav",
  lead: "audio/events/music-lead.wav",
  melody: "audio/melody-loop.wav",
} as const;

/** The music event of the sound-lab sample: three decoded stems on a 120 bpm grid, Intensity quantised to the beat. */
export const INTENSITY_EVENT = "audio/events/music-intensity.audioevent.json";

export type Voice = { id: number; clip: string; bus: string; state: string; gain: number; playheadSeconds: number | null; event?: number | null };
export type Row = {
  id: number;
  asset: string;
  state: string;
  segment: string | null;
  pass: number;
  bar: number;
  beat: number;
  tick: number;
  tempo: number;
  time: number;
  pending: { to: string; time: string; rule: number; ruleKey: string; tier: number; parent: string; exit: string; enter: string } | null;
  groups: { id: number; state: string; primed: number; of: number }[];
  stems: { name: string; primed: boolean; streamed: boolean; ring: number | null }[];
  replans: Record<string, number>;
  refusals: Record<string, number>;
  lateGroups: number;
  groupsHeld: number;
  groupTimeouts: number;
  lastSlipFrames: number;
  recoveries: Record<string, number>;
  missedBeats: number;
  stingers: { played: number; late: number; skipped: number; dropped: number };
};
export type Totals = { poolUsed: number; poolSize: number; poolHighWater: number; musicRingRefused: number; streamStartsLate: number; maxSlipFrames: number; splitQuanta: number; voiceSplits: number; curvePoolFull: number; groupTableFull: number };
export type Debug = {
  status: string;
  counters: { underruns: number };
  voices: Voice[];
  core: Record<string, number | string | boolean>;
  music?: Row[];
  musicTotals?: Totals;
};
/** The core's cumulative group counters (the STATUS mirror; `Audio.debug().musicTotals` carries `maxSlipFrames` and `splitQuanta`). */
export type Late = { groupsLate: number; groupsHeld: number; groupsAbandoned: number; maxSlipFrames: number; splitQuanta: number };
/** What a page's handle says about its music, read in one go. */
export type Snap = {
  now: number;
  segment: string | null;
  bar: number;
  beat: number;
  beatFraction: number;
  time: number;
  tempo: number;
  transition: { to: string; time: number } | null;
  nextBar: number | null;
  nextBeat: number | null;
};

type Api = {
  Audio: {
    debug(): unknown;
    time: number;
    bus(n: string): { peak: number; volume: number };
    buses: readonly string[];
    play(path: string, o?: object): { music?: unknown; stop(s?: number): void };
    playOneShot(clip: string, o?: object): { voice?: { backend?: unknown; inner?: { backend?: unknown } } };
  };
  Assets: { addSource(s: unknown): void; fromObject(m: Record<string, unknown>): unknown; has(path: string): boolean };
};

export const audioDebug = (page: Page) => page.evaluate(() => ((globalThis as unknown as { __myco?: Api }).__myco?.Audio.debug() as Debug | undefined) ?? null);
export const musicRows = async (page: Page): Promise<Row[]> => (await audioDebug(page))?.music ?? [];

/** The highest peak of a bus's meter over `ms` in the page (one reading can land in a quiet part of the clip). */
export const peakOver = (page: Page, bus: string, ms = 300) =>
  page.evaluate(
    async ([name, span]) => {
      const { Audio } = (globalThis as unknown as { __myco: Api }).__myco;
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

/** The core's group counters: `groupsLate`, `groupsHeld` and `groupsAbandoned` from the STATUS mirror, the slip and splits from `musicTotals`. */
export const readLate = (page: Page): Promise<Late | null> =>
  page.evaluate(() => {
    const g = globalThis as unknown as { __myco: Api; __e1Backend?: { mirror?: Record<string, number> } };
    if (!g.__e1Backend) {
      // Any voice reaches its backend (TypeScript-private, a plain property at run time); a silent one-shot is the cheapest.
      const clip = g.__myco.Assets.has("audio/beep.wav") ? "audio/beep.wav" : "music/foo.mp3";
      const v = g.__myco.Audio.playOneShot(clip, { volume: 0.0001, bus: "UI" }).voice;
      g.__e1Backend = (v?.backend ?? v?.inner?.backend) as typeof g.__e1Backend;
    }
    const m = g.__e1Backend?.mirror;
    if (!m) return null;
    return { groupsLate: m.groupsLate!, groupsHeld: m.groupsHeld!, groupsAbandoned: m.groupsAbandoned!, maxSlipFrames: m.maxSlipFrames!, splitQuanta: m.splitQuanta! };
  });

/** Collects what a page logs that matters to music: errors, uncaught exceptions, and warnings from the engine or about audio. */
export function watchConsole(page: Page): { errors: string[]; warnings: string[] } {
  const seen = { errors: [] as string[], warnings: [] as string[] };
  page.on("pageerror", (err) => seen.errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") seen.errors.push(msg.text());
    else if (msg.type() === "warning" && /music|audio|stream|stinger|segment|stem|\bring|group/i.test(msg.text()) && !/shader|Emitter/i.test(msg.text())) seen.warnings.push(msg.text());
  });
  return seen;
}

/** Opens a sample in Play mode and unlocks the audio context with a click; waits for the running core (or Babylon) backend. */
export async function bootSample(page: Page, url: string, backend: "core" | "babylon" = "core"): Promise<void> {
  if (backend === "babylon") {
    const project = url.includes("flappy") ? "flappy" : "sound-lab";
    await page.route(`**/samples/${project}/project.json`, async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.audio = { ...(json.audio ?? {}), backend: "babylon" };
      await route.fulfill({ response: res, json });
    });
  }
  await page.goto(url);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await play(page);
  await page.mouse.click(480, 250); // the user gesture that unlocks the context
  await expect.poll(async () => (await audioDebug(page))?.status, { timeout: 30_000 }).toBe("running");
  expect((await audioDebug(page))!.core.backend).toBe(backend);
}

/** Adds audio events (path -> the JSON object) and generated clips (path -> a sine, see `Sine`) to the page's asset sources. */
export type Sine = { hz: number; amp: number; seconds?: number; rate?: number };
export async function addAssets(page: Page, events: Record<string, unknown>, sines: Record<string, Sine> = {}): Promise<void> {
  await page.evaluate(
    ([evs, sn]) => {
      const { Assets } = (globalThis as unknown as { __myco: Api }).__myco;
      const map: Record<string, unknown> = { ...(evs as Record<string, unknown>) };
      for (const [path, s] of Object.entries(sn as Record<string, Sine>)) {
        const rate = s.rate ?? 24_000;
        const n = Math.round((s.seconds ?? 4) * rate);
        const bytes = new Uint8Array(44 + n * 2);
        const dv = new DataView(bytes.buffer);
        const tag = (o: number, t: string) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
        tag(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); tag(8, "WAVE"); tag(12, "fmt ");
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        tag(36, "data"); dv.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * s.hz * i) / rate) * s.amp * 32767), true);
        map[path] = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      }
      Assets.addSource(Assets.fromObject(map));
    },
    [events, sines] as const,
  );
}

/** Starts an event and keeps its handle in the page under `name`. */
export const startEvent = (page: Page, name: string, path: string, options: object = {}) =>
  page.evaluate(
    ([n, p, o]) => {
      const g = globalThis as unknown as { __myco: Api; __e1?: Record<string, unknown> };
      (g.__e1 ??= {})[n as string] = g.__myco.Audio.play(p as string, o as object);
    },
    [name, path, options] as const,
  );

/**
 * Watches a music row's `state` from inside the page every 20 ms and keeps each change in order (F-28, F-29). A playlist's
 * row reads `playing` only between an advance landing and its successor's stamp, 100-200 ms of each item (architecture
 * §2.1: Pending, then Transitioning from the stamp, a whole item ahead), so `expect.poll`'s reads, 1 s apart, can miss
 * every window in step with the items. Install it before the event starts; `musicStates` reads the history back.
 * `asset` is a substring of the row's asset path; installing again for the same `asset` restarts its history.
 */
export const sampleMusicState = (page: Page, asset: string) =>
  page.evaluate((a) => {
    const g = globalThis as unknown as { __myco: Api; __musicStates?: Record<string, { states: string[]; timer: ReturnType<typeof setInterval> }> };
    const all = (g.__musicStates ??= {});
    if (all[a]) clearInterval(all[a]!.timer);
    const states: string[] = [];
    const timer = setInterval(() => {
      const s = (g.__myco.Audio.debug() as Debug | undefined)?.music?.find((m) => m.asset.includes(a))?.state;
      if (s && s !== states[states.length - 1]) states.push(s);
    }, 20);
    all[a] = { states, timer };
  }, asset);

/** The states `sampleMusicState` has seen for `asset`, each change once, in order (empty before it is installed). */
export const musicStates = (page: Page, asset: string): Promise<string[]> =>
  page.evaluate((a) => (globalThis as unknown as { __musicStates?: Record<string, { states: string[] }> }).__musicStates?.[a]?.states.slice() ?? [], asset);

/** How many times the sampled row has entered `playing` (a playlist enters it once per item). */
export const playingEntries = async (page: Page, asset: string): Promise<number> => (await musicStates(page, asset)).filter((s) => s === "playing").length;

/** Reads the named handle's music state: position, pending change and the next bar and beat. */
export const snap = (page: Page, name: string): Promise<Snap | null> =>
  page.evaluate((n) => {
    const g = globalThis as unknown as { __myco: Api; __e1?: Record<string, { music?: Record<string, unknown> & { nextGrid(s: string): { time: number } | null } }> };
    const m = g.__e1?.[n as string]?.music;
    if (!m) return null;
    const tr = m.transition as { to: string; time: number } | null;
    return {
      now: g.__myco.Audio.time,
      segment: m.segment as string | null,
      bar: m.bar as number,
      beat: m.beat as number,
      beatFraction: m.beatFraction as number,
      time: m.time as number,
      tempo: m.tempo as number,
      transition: tr ? { to: tr.to, time: tr.time } : null,
      nextBar: m.nextGrid("bar")?.time ?? null,
      nextBeat: m.nextGrid("beat")?.time ?? null,
    };
  }, name);

/** `x` modulo `period`, folded to its distance from the nearest multiple: 0 when `x` is on the grid. */
export const offGrid = (x: number, period: number): number => {
  const r = ((x % period) + period) % period;
  return Math.min(r, period - r);
};

// ---------------------------------------------------------------------------------------------------------------------
// The events. Every segment is 4 s long (the stems' length), 120 bpm 4/4: a bar is 2 s, a beat 0.5 s.

const TEMPO = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const LOOP = [{ id: "loop", from: "1:1:0", to: "end", count: 0 }];
const track = (name: string, clip: string, volume = 0.3) => ({ name, clip, volume });
/** A segment of the given stems; looping forever or playing once (a playlist advances only past one that ends). */
export const segment = (id: string, tracks: object[], loop: boolean, extra: Record<string, unknown> = {}) => ({
  type: "segment",
  id,
  tempo: TEMPO,
  ...(loop ? { regions: LOOP } : {}),
  tracks,
  ...extra,
});
export const event = (root: unknown, extra: Record<string, unknown> = {}) => ({ format: "myco.audioevent@1", bus: "Tape", priority: 200, limit: { maxInstances: 4, steal: "oldest" }, root, ...extra });

/** Eight stems, four distinct clips twice (two of them stream, two decode), one segment, looping. */
export const stems8 = () =>
  event(
    segment(
      "eight",
      [
        track("pad-a", STEM.pad, 0.12), track("pulse-a", STEM.pulse, 0.12), track("lead-a", STEM.lead, 0.12), track("melody-a", STEM.melody, 0.12),
        track("pad-b", STEM.pad, 0.12), track("pulse-b", STEM.pulse, 0.12), track("lead-b", STEM.lead, 0.12), track("melody-b", STEM.melody, 0.12),
      ],
      true,
    ),
  );

/** Three one-pass segments, A (pad, pulse), B (lead, pulse), C (streamed melody, pad): a playlist that runs `rounds` times (0 forever). */
export const playlist3 = (rounds: number) =>
  event({
    type: "playlist",
    id: "list",
    mode: "sequence",
    rounds,
    children: [
      segment("A", [track("pad", STEM.pad), track("pulse", STEM.pulse)], false),
      segment("B", [track("lead", STEM.lead), track("pulse", STEM.pulse)], false),
      segment("C", [track("melody", STEM.melody), track("pad", STEM.pad)], false),
    ],
  });

/** A switch of two looping segments on the label State: A to B is a one-beat equal-power crossfade on the next bar, B to A a cut on the next bar. */
export const switchAB = () =>
  event(
    {
      type: "musicSwitch",
      id: "world",
      parameter: "State",
      default: "A",
      children: [
        { ...segment("A", [track("pad", STEM.pad), track("pulse", STEM.pulse, 0.2)], true), value: "A" },
        { ...segment("B", [track("lead", STEM.lead), track("melody", STEM.melody, 0.2)], true), value: "B" },
      ],
      transitions: [
        { from: "A", to: "B", exit: "bar", enter: "entryCue", fadeOut: { beats: 1, curve: "equalPower" }, fadeIn: { beats: 1, curve: "equalPower" } },
        { from: "B", to: "A", exit: "bar", enter: "entryCue", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } },
      ],
    },
    { parameters: [{ name: "State", labels: ["A", "B"], default: "A" }] },
  );

/** A looping quiet sine under a switch with one stinger, "hit" (a louder 1 s sine), on the next bar; needs `SINES`. */
export const withStinger = () =>
  event(
    {
      type: "musicSwitch",
      id: "world",
      parameter: "State",
      children: [{ ...segment("A", [{ name: "base", clip: "e1/base.wav", volume: 1 }], true), value: "A" }],
      stingers: [{ trigger: "hit", segment: "hit", at: "bar", ifTooLate: "nextGrid", volume: 1 }],
      library: [{ type: "segment", id: "hit", tracks: [{ name: "hit", clip: "e1/hit.wav", volume: 1 }] }],
    },
    { parameters: [{ name: "State", labels: ["A", "B"], default: "A" }] },
  );

/** Two generated sine stems; "layer" follows the local parameter Layer (0..1) on the beat, "base" always sounds. */
export const SINES: Record<string, Sine> = {
  "e1/base.wav": { hz: 220, amp: 0.2 },
  "e1/layer.wav": { hz: 330, amp: 0.2 },
  "e1/hit.wav": { hz: 660, amp: 0.4, seconds: 1 },
};
export const layered = () =>
  event(
    segment(
      "layered",
      [
        { name: "base", clip: "e1/base.wav", volume: 1 },
        { name: "layer", clip: "e1/layer.wav", volume: 1, automation: [{ parameter: "Layer", target: "volume", curve: [[0, 0], [1, 1]], quantize: "beat" }] },
      ],
      true,
    ),
    { parameters: [{ name: "Layer", min: 0, max: 1, default: 0, seekSpeed: 0 }] },
  );

/**
 * Pauses (`paused` true) or resumes every dedicated worker of the page through the DevTools protocol (Chromium): the decoder
 * worker stops refilling the music rings, so a streamed stem runs dry once its ring has drained. Pass the result of the pausing
 * call to resume; `ids` is the workers reached.
 */
export async function pauseWorkers(page: Page, paused: boolean, held: { cdp: CDPSession; ids: string[] } | null): Promise<{ cdp: CDPSession; ids: string[] }> {
  const cdp = held?.cdp ?? (await page.context().newCDPSession(page));
  const ids = held?.ids ?? [];
  if (!held) {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string }[] };
    for (const t of targetInfos.filter((x) => x.type === "worker")) {
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: false })) as { sessionId: string };
      ids.push(sessionId);
    }
  }
  for (const sessionId of ids) {
    const send = (id: number, method: string) => cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method }) });
    if (paused) await send(1, "Debugger.enable");
    await send(paused ? 2 : 3, paused ? "Debugger.pause" : "Debugger.resume");
  }
  return { cdp, ids };
}
