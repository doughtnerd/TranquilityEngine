// ADR 0171/0172 (Pf2; api-and-models §7 `cursorModel.ts`): every cursor state and transition over a recorded scene whose
// STATUS counters rise at known blocks: live, paused, scrubbing (a live cursor pauses on scrub), step by one STATUS,
// previous and next underrun, late command, ladder step and marker, and the ends of each. Times are on the audio clock
// (frames of the recorded blocks), never wall time.
import { describe, expect, it } from "vitest";
import { SAMPLE_RATE } from "../../runtime/capture/testSupport";
import { CURSOR_COLUMNS, CursorModel, cursorTargets, seekAtCursor, type CursorTargets } from "./cursorModel";
import { statusColumns, type ProfileSource } from "./profilerSource";
import { FRAMES, openScene, truthAt } from "./voiceSceneSupport";
import { nameLookup, reconstructVoices } from "./voiceTableModel";

/** Counters by block (1-based): underruns rise at blocks 40 and 90 (by 2), late commands at 60, the ladder at 80 (up), 100 (up), 150 (down). */
const status = (i: number) => ({
  underruns: i >= 90 ? 3 : i >= 40 ? 1 : 0,
  lateCommands: i >= 60 ? 1 : 0,
  m3Shed: i >= 150 ? 0 : i >= 80 ? 1 : 0,
  loudShed: i >= 100 ? 1 : 0,
});

async function scene(): Promise<{ source: ProfileSource; targets: CursorTargets; at: (block: number) => number }> {
  const source = await openScene((i) => status(i));
  const targets = cursorTargets(await statusColumns(source, CURSOR_COLUMNS), source.markers, source.startSeconds);
  // The viewport time of STATUS block `i` (1-based): its frame on the axis, less the capture's first record.
  const at = (i: number) => (i * FRAMES) / SAMPLE_RATE - source.startSeconds;
  return { source, targets, at };
}

describe("cursorTargets", () => {
  it("reads the status times, the counters' rises, the ladder's steps and the markers, all sorted on the viewport axis", async () => {
    const { source, targets, at } = await scene();
    expect(targets.status.length).toBe(250);
    expect(targets.status[0]).toBeCloseTo(at(1), 9);
    expect(targets.underrun.length).toBe(2);
    expect(targets.underrun[0]).toBeCloseTo(at(40), 9);
    expect(targets.underrun[1]).toBeCloseTo(at(90), 9);
    expect(targets.lateCommand.length).toBe(1);
    expect(targets.lateCommand[0]).toBeCloseTo(at(60), 9);
    expect(Array.from(targets.ladder, (x) => Math.round(x * SAMPLE_RATE))).toEqual([80, 100, 150].map((i) => Math.round(at(i) * SAMPLE_RATE)));
    expect(Array.from(targets.marker, (x) => Math.round((x + source.startSeconds) * SAMPLE_RATE))).toEqual([20_000, 100_000]);
    for (const k of ["status", "underrun", "lateCommand", "ladder", "marker"] as const) {
      const a = targets[k];
      for (let i = 1; i < a.length; i++) expect(a[i]!).toBeGreaterThan(a[i - 1]!);
    }
    source.close();
  });
});

describe("modes", () => {
  it("a file opens paused at 0 and cannot go live", async () => {
    const { targets } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(10);
    c.setTargets(targets);
    expect(c.snapshot()).toMatchObject({ mode: "paused", time: 0 });
    expect(c.goLive()).toBe(false);
    expect(c.mode).toBe("paused");
  });

  it("a live view starts live at the newest STATUS and follows it as targets grow", async () => {
    const { targets } = await scene();
    const c = new CursorModel({ live: true });
    c.setDuration(5);
    expect(c.mode).toBe("live");
    expect(c.time).toBe(5); // no STATUS yet: the duration
    c.setTargets(targets);
    const r0 = c.revision;
    expect(c.time).toBe(targets.status[249]);
    c.setTargets({ ...targets, status: targets.status.subarray(0, 100) });
    expect(c.time).toBe(targets.status[99]);
    expect(c.revision).toBeGreaterThan(r0); // a table read at the old edge is stale
    expect(c.mode).toBe("live");
  });

  it("scrubbing a live cursor pauses it: scrubbing while the drag lasts, paused where it was dropped", async () => {
    const { targets, at } = await scene();
    const c = new CursorModel({ live: true });
    c.setDuration(at(250));
    c.setTargets(targets);
    c.scrub(at(100));
    expect(c.snapshot()).toMatchObject({ mode: "scrubbing", time: at(100) });
    c.scrub(at(50));
    expect(c.snapshot()).toMatchObject({ mode: "scrubbing", time: at(50) });
    c.endScrub();
    expect(c.snapshot()).toMatchObject({ mode: "paused", time: at(50) });
    // A paused cursor stays put while the capture grows.
    c.setDuration(at(250) + 5);
    expect(c.time).toBe(at(50));
    expect(c.goLive()).toBe(true);
    expect(c.mode).toBe("live");
    expect(c.time).toBe(targets.status[249]);
  });

  it("pause holds a live cursor at its newest STATUS; seekTo clamps and pauses; scrubbing clamps to the capture", async () => {
    const { targets, at } = await scene();
    const c = new CursorModel({ live: true });
    c.setDuration(at(250));
    c.setTargets(targets);
    c.pause();
    expect(c.snapshot()).toMatchObject({ mode: "paused", time: targets.status[249] });
    c.seekTo(-3);
    expect(c.time).toBe(0);
    c.seekTo(1e9);
    expect(c.time).toBe(c.duration);
    c.seekTo(NaN);
    expect(c.time).toBe(0);
    c.scrub(1e9);
    expect(c.time).toBe(c.duration);
    c.scrub(-1);
    expect(c.time).toBe(0);
  });

  it("endScrub outside a scrub changes nothing; an unchanged move leaves the revision alone; a changed one bumps it", async () => {
    const { targets, at } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(at(250));
    c.setTargets(targets);
    c.seekTo(at(10));
    const r = c.revision;
    c.endScrub();
    c.seekTo(at(10));
    c.pause();
    expect(c.revision).toBe(r);
    c.seekTo(at(11));
    expect(c.revision).toBe(r + 1);
    c.scrub(at(12));
    expect(c.revision).toBe(r + 2);
    c.endScrub();
    expect(c.revision).toBe(r + 3);
    expect(c.axisTime(2)).toBe(at(12) + 2);
  });

  it("a held cursor past a shorter duration moves to the end", async () => {
    const { targets, at } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(at(250));
    c.setTargets(targets);
    c.seekTo(at(200));
    c.setDuration(at(100));
    expect(c.time).toBe(at(100));
    c.setDuration(NaN);
    expect(c.duration).toBe(0);
    expect(c.time).toBe(0);
  });
});

describe("step by one STATUS", () => {
  async function paused(): Promise<{ c: CursorModel; targets: CursorTargets; at: (i: number) => number }> {
    const { targets, at } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(at(250));
    c.setTargets(targets);
    return { c, targets, at };
  }

  it("forward and back visit each block in turn", async () => {
    const { c, targets } = await paused();
    c.seekTo(targets.status[10]!);
    expect(c.stepForward()).toBe(true);
    expect(c.time).toBe(targets.status[11]);
    expect(c.stepBack()).toBe(true);
    expect(c.stepBack()).toBe(true);
    expect(c.time).toBe(targets.status[9]);
    expect(c.mode).toBe("paused");
  });

  it("from between two blocks, forward goes to the next and back to the previous", async () => {
    const { c, targets } = await paused();
    const mid = (targets.status[20]! + targets.status[21]!) / 2;
    c.seekTo(mid);
    expect(c.stepBack()).toBe(true);
    expect(c.time).toBe(targets.status[20]);
    c.seekTo(mid);
    expect(c.stepForward()).toBe(true);
    expect(c.time).toBe(targets.status[21]);
  });

  it("stops at the ends: false and nothing changes", async () => {
    const { c, targets } = await paused();
    c.seekTo(targets.status[0]!);
    const r = c.revision;
    expect(c.stepBack()).toBe(false);
    expect(c.revision).toBe(r);
    c.seekTo(targets.status[249]!);
    const r2 = c.revision;
    expect(c.stepForward()).toBe(false);
    expect(c.revision).toBe(r2);
    expect(c.time).toBe(targets.status[249]);
  });

  it("walking back from the last block to the first visits all 250", async () => {
    const { c, targets } = await paused();
    c.seekTo(targets.status[249]!);
    let n = 1;
    while (c.stepBack()) n++;
    expect(n).toBe(250);
    expect(c.time).toBe(targets.status[0]);
    while (c.stepForward()) n--;
    expect(n).toBe(1);
  });

  it("stepping ends a scrub; from live, back pauses one block before the newest and forward does nothing", async () => {
    const { c, targets } = await paused();
    c.scrub(targets.status[30]! + 0.001);
    expect(c.stepForward()).toBe(true);
    expect(c.snapshot()).toMatchObject({ mode: "paused", time: targets.status[31] });
    const live = new CursorModel({ live: true });
    live.setDuration(5);
    live.setTargets(targets);
    expect(live.stepForward()).toBe(false);
    expect(live.mode).toBe("live");
    expect(live.stepBack()).toBe(true);
    expect(live.snapshot()).toMatchObject({ mode: "paused", time: targets.status[248] });
  });

  it("with no STATUS at all there is nothing to step to", () => {
    const c = new CursorModel({ live: false });
    c.setDuration(3);
    expect(c.stepForward()).toBe(false);
    expect(c.stepBack()).toBe(false);
  });
});

describe("jump to the previous and next underrun, late command, ladder step and marker", () => {
  async function paused() {
    const { targets, at, source } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(at(250));
    c.setTargets(targets);
    return { c, targets, at, source };
  }

  it("underruns: next, next, then the end; previous back down; the ends leave the cursor alone", async () => {
    const { c, targets, at } = await paused();
    expect(c.has("underrun", "previous")).toBe(false);
    expect(c.jump("underrun", "previous")).toBe(false);
    expect(c.time).toBe(0);
    expect(c.jump("underrun", "next")).toBe(true);
    expect(c.time).toBe(targets.underrun[0]);
    expect(c.time).toBeCloseTo(at(40), 9);
    expect(c.jump("underrun", "next")).toBe(true);
    expect(c.time).toBeCloseTo(at(90), 9); // one tick though the counter rose by 2
    const r = c.revision;
    expect(c.jump("underrun", "next")).toBe(false);
    expect(c.revision).toBe(r);
    expect(c.has("underrun", "next")).toBe(false);
    expect(c.jump("underrun", "previous")).toBe(true);
    expect(c.time).toBeCloseTo(at(40), 9);
    expect(c.jump("underrun", "previous")).toBe(false);
    expect(c.mode).toBe("paused");
  });

  it("late commands", async () => {
    const { c, at } = await paused();
    expect(c.jump("lateCommand", "next")).toBe(true);
    expect(c.time).toBeCloseTo(at(60), 9);
    expect(c.jump("lateCommand", "next")).toBe(false);
    expect(c.jump("lateCommand", "previous")).toBe(false); // standing on the only one
    c.seekTo(at(200));
    expect(c.jump("lateCommand", "previous")).toBe(true);
    expect(c.time).toBeCloseTo(at(60), 9);
  });

  it("ladder steps: a shed (up) and a restore (down) are both steps, in time order", async () => {
    const { c, at } = await paused();
    const seen: number[] = [];
    while (c.jump("ladder", "next")) seen.push(Math.round((c.time + 0) * SAMPLE_RATE));
    expect(seen).toEqual([80, 100, 150].map((i) => Math.round(at(i) * SAMPLE_RATE)));
    while (c.jump("ladder", "previous")) seen.push(-1);
    expect(seen.filter((x) => x === -1)).toHaveLength(2); // from the last to the first
    expect(c.time).toBeCloseTo(at(80), 9);
  });

  it("markers: the cursor lands on a marker's own time, which is no STATUS block's", async () => {
    const { c, targets, source } = await paused();
    expect(c.jump("marker", "next")).toBe(true);
    expect(c.time + source.startSeconds).toBeCloseTo(20_000 / SAMPLE_RATE, 9);
    expect(Array.from(targets.status)).not.toContain(c.time);
    expect(c.jump("marker", "next")).toBe(true);
    expect(c.time + source.startSeconds).toBeCloseTo(100_000 / SAMPLE_RATE, 9);
    expect(c.jump("marker", "next")).toBe(false);
    expect(source.markers.map((m) => m.text)).toEqual(["wave one", "Boss Door"]);
    expect(c.jump("marker", "previous")).toBe(true);
    expect(c.time + source.startSeconds).toBeCloseTo(20_000 / SAMPLE_RATE, 9);
    expect(c.jump("marker", "previous")).toBe(false);
  });

  it("each kind searches only its own ticks", async () => {
    const { c, at } = await paused();
    c.seekTo(at(50));
    expect(c.find("underrun", "next")).toBeCloseTo(at(90), 9);
    expect(c.find("lateCommand", "next")).toBeCloseTo(at(60), 9);
    expect(c.find("ladder", "next")).toBeCloseTo(at(80), 9);
    expect(c.find("underrun", "previous")).toBeCloseTo(at(40), 9);
    expect(c.find("ladder", "previous")).toBeNull();
  });

  it("jumping from live pauses at the target; with no target behind a live cursor it stays live", async () => {
    const { targets, at } = await scene();
    const c = new CursorModel({ live: true });
    c.setDuration(at(250));
    c.setTargets(targets);
    expect(c.jump("underrun", "next")).toBe(false);
    expect(c.mode).toBe("live");
    expect(c.jump("ladder", "previous")).toBe(true); // the restore at block 150, behind the newest STATUS
    expect(c.snapshot()).toMatchObject({ mode: "paused" });
    expect(c.time).toBeCloseTo(at(150), 9);
    // A capture with no late commands has nothing to jump to.
    const empty = new CursorModel({ live: false });
    empty.setDuration(1);
    expect(empty.jump("lateCommand", "next")).toBe(false);
    expect(empty.jump("marker", "previous")).toBe(false);
  });
});

describe("the table at the cursor", () => {
  it("seekAtCursor reads the state at the cursor's axis time, and the table matches the scene's truth", async () => {
    const { source, targets } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(source.duration);
    c.setTargets(targets);
    c.seekTo(targets.status[80]!); // block 81: frame 81 * 768
    const got = await seekAtCursor(source, c);
    expect(got).not.toBeNull();
    expect(got!.state.status!.currentFrame).toBe(81 * FRAMES);
    const rows = reconstructVoices(got!.state, nameLookup(source.summary.names)).rows.map((r) => r.id).sort();
    expect(rows).toEqual(truthAt(81 * FRAMES).map((v) => v.id));
    source.close();
  });

  it("an answer that arrives after the cursor moved is dropped; one that arrives with it unmoved is kept", async () => {
    const { source, targets } = await scene();
    const c = new CursorModel({ live: false });
    c.setDuration(source.duration);
    c.setTargets(targets);
    c.scrub(targets.status[10]!);
    const stale = seekAtCursor(source, c);
    c.scrub(targets.status[20]!); // the drag moved on while the Worker answered
    expect(await stale).toBeNull();
    const fresh = seekAtCursor(source, c);
    expect((await fresh)?.revision).toBe(c.revision);
    source.close();
  });
});
