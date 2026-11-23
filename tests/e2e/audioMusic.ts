import { type Page, readAudioDebug } from "./fixtures";

// Reads of the music playlists' rows for `sound-lab-touch.spec.ts`: `Audio.debug().music` (the playlist runtime's music
// rows, ADR 0343) and `musicTotals`, through the public `myco` API. (The builders of retired music events that the deleted
// M4 specs added to the page went with them: the playlist runtime is unit- and loopback-tested beside it.)

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
export type Totals = { poolUsed: number; poolSize: number; poolHighWater: number; musicRingRefused: number; streamStartsLate: number; groupsLate: number; groupsHeld: number; groupsAbandoned: number; maxSlipFrames: number; splitQuanta: number; voiceSplits: number; curvePoolFull: number; groupTableFull: number };
export type Debug = {
  status: string;
  counters: { underruns: number };
  voices: Voice[];
  core: Record<string, number | string | boolean>;
  music?: Row[];
  musicTotals?: Totals;
};
/** The core's cumulative group counters, slip and splits, as `Audio.debug().musicTotals` reports them (the STATUS header). */
export type Late = { groupsLate: number; groupsHeld: number; groupsAbandoned: number; maxSlipFrames: number; splitQuanta: number };

type Api = { Audio: { debug(): unknown } };

export const audioDebug = (page: Page) => readAudioDebug<Debug>(page);
export const musicRows = async (page: Page): Promise<Row[]> => (await audioDebug(page))?.music ?? [];

/** The group counters (`Late`) from `Audio.debug()`; null while it reports no music totals (not the core). */
export const readLate = (page: Page): Promise<Late | null> =>
  page.evaluate(() => {
    const t = ((globalThis as unknown as { __myco: Api }).__myco.Audio.debug() as Debug).musicTotals;
    if (!t) return null;
    return { groupsLate: t.groupsLate, groupsHeld: t.groupsHeld, groupsAbandoned: t.groupsAbandoned, maxSlipFrames: t.maxSlipFrames, splitQuanta: t.splitQuanta };
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
