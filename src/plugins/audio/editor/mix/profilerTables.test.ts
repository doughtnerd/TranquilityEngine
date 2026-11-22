// ADR 0171/0172 (Pf5; api-and-models §7) and 0326: the profiler's tables, their models. Cases: the window (at most 64 rows
// at every scroll position; the window moves with the scroll), keyboard focus moves, reasons and the thief on a real
// recorded scene, the bus table's factors and products, music rows, and the table kit: given a seek state and a filter,
// what each table shows (its rows, summary and empty state); and theme tokens only.
// The rendered tables (rows, scrolling, keys, clicks, typing in the filter) are VoiceTable.stories.tsx,
// BusTable.stories.tsx and profilerTables.stories.tsx. No wall clock anywhere.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CaptureKeyframe, CaptureKeyframeBus, CaptureKeyframeMusic, CaptureKeyframeVoice, CaptureSeekState } from "../../runtime/capture/reader";
import { SAMPLE_RATE } from "../../runtime/capture/testSupport";
import { type ProfilerSlots, profilerSlots } from "./ProfilerPanel";
import { ProfilerTables } from "./profilerTables";
import { busParents, busTableRows, musicRows, profilerTables, tableEmptyText, voiceCells, type TableKind } from "./profilerTablesModel";
import type { ProfileSource } from "./profilerSource";
import { MAX_RENDERED_ROWS, OVERSCAN_ROWS, ROW_HEIGHT, VIEWPORT_HEIGHT, VIEWPORT_ROWS, moveFocus, navigate, scrollToIndex, windowRows } from "./gridWindow";
import { captureNames } from "../../runtime/capture/reader";
import { namesFromStart } from "../../runtime/capture/testSupport";
import { reconstructVoices, type VoiceRow } from "./voiceTableModel";
import { EMPTY_STATES } from "./emptyStates";
import { openScene } from "./voiceSceneSupport";

// ---- synthetic seek states ----

const EMPTY_MIX = { slotTableVersion: 1, monitorActive: false, targetIndex: 0, snapshot: null, masterVolume: 1, hiddenMute: false };
function keyframe(over: Partial<CaptureKeyframe> = {}): CaptureKeyframe {
  return { voices: [], buses: [], metered: [], events: [], music: [], mix: EMPTY_MIX, ...over };
}
function seekState(kf: CaptureKeyframe | null, records: unknown[] = []): CaptureSeekState {
  return { seconds: 0, keyframeSeq: kf ? 1 : -1, keyframe: kf, status: null, records, recordsScanned: 0 } as unknown as CaptureSeekState;
}
const voice = (id: number, over: Partial<CaptureKeyframeVoice> = {}): CaptureKeyframeVoice => ({
  id, clip: 1 + (id % 3), slot: id % 3, state: "playing", priority: id % 5, reason: null, gain: 0.5, pitch: 1, audibility: 1 - id / 8192, playheadFrames: id * 10, ...over,
});
const thousand = (): CaptureSeekState => seekState(keyframe({ voices: Array.from({ length: 1024 }, (_, i) => voice(i + 1)) }));
const NAME_TABLES = { clips: [[1, "jump.ogg"], [2, "Land.ogg"], [3, "footstep.ogg"]], buses: [[0, "Master"], [1, "Music"], [2, "SFX"]], events: [[5, "PlayerJump"], [6, "Ambience"], [1, "Intro"], [2, "Loop"], [3, "Outro"]] } as const;
const NAMES_LOOKUP = namesFromStart(NAME_TABLES);
/** A source with these names (as the summary's log: each held from the start) and the META audio section's buses. */
const source = (truncated = false): Pick<ProfileSource, "summary" | "truncated"> => {
  const log = (t: readonly (readonly [number, string])[] = []) => t.map(([id, name]) => [id, name, -Infinity] as const);
  const names = { clips: log(NAME_TABLES.clips), buses: log(NAME_TABLES.buses), events: log(NAME_TABLES.events), parameters: [], snapshots: [], targets: [] };
  const audio = { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Music" }] };
  return { summary: { names, meta: { audio } }, truncated } as unknown as Pick<ProfileSource, "summary" | "truncated">;
};
const KINDS: readonly TableKind[] = ["voices", "buses", "events", "music"];

/** The voice table at a seek, through the kit. */
const voiceData = (state: CaptureSeekState, filter = "") => profilerTables(source(), state, filter).voices;

// ---- the window ----

describe("windowRows", () => {
  it("renders the visible rows plus an overscan, from the top", () => {
    const w = windowRows({ total: 1024, scrollTop: 0 });
    expect(w).toMatchObject({ start: 0, height: 1024 * ROW_HEIGHT, scrollTop: 0 });
    expect(w.end).toBe(VIEWPORT_ROWS + OVERSCAN_ROWS);
  });

  it("never renders more than 64 rows, even for a viewport that would show more", () => {
    for (const viewportHeight of [VIEWPORT_HEIGHT, 2000, 5000, 100_000]) {
      for (const scrollTop of [0, 777, 10_000, 20_000]) {
        const w = windowRows({ total: 1024, scrollTop, viewportHeight });
        expect(w.end - w.start, `viewport ${viewportHeight} scroll ${scrollTop}`).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
      }
    }
    expect(windowRows({ total: 1024, scrollTop: 0, viewportHeight: 100_000 })).toMatchObject({ start: 0, end: MAX_RENDERED_ROWS });
  });

  it("moves with the scroll offset and covers every row the viewport shows", () => {
    for (const scrollTop of [0, 1, 19, 20, 300, 5_001, 10_000, 20_000]) {
      const w = windowRows({ total: 1024, scrollTop });
      const first = Math.floor(w.scrollTop / ROW_HEIGHT);
      const last = Math.ceil((w.scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) - 1;
      expect(w.start).toBeLessThanOrEqual(first);
      expect(w.end).toBeGreaterThan(last);
    }
    expect(windowRows({ total: 1024, scrollTop: 10_000 }).start).toBe(500 - OVERSCAN_ROWS);
  });

  it("clamps a scroll offset past the end (and negative or NaN) and handles short tables", () => {
    const last = windowRows({ total: 1024, scrollTop: 1e9 });
    expect(last.end).toBe(1024);
    expect(last.scrollTop).toBe(1024 * ROW_HEIGHT - VIEWPORT_HEIGHT);
    expect(windowRows({ total: 1024, scrollTop: -50 }).scrollTop).toBe(0);
    expect(windowRows({ total: 1024, scrollTop: NaN }).scrollTop).toBe(0);
    expect(windowRows({ total: 0, scrollTop: 500 })).toEqual({ start: 0, end: 0, height: 0, scrollTop: 0 });
    expect(windowRows({ total: 5, scrollTop: 100 })).toMatchObject({ start: 0, end: 5 });
  });
});

describe("scrollToIndex and keyboard focus", () => {
  it("scrolls the least that shows the row", () => {
    expect(scrollToIndex(3, 0)).toBe(0);
    expect(scrollToIndex(VIEWPORT_ROWS, 0)).toBe(ROW_HEIGHT); // one row past the bottom edge
    expect(scrollToIndex(2, 200)).toBe(2 * ROW_HEIGHT);
    expect(scrollToIndex(20, 200)).toBe(200);
  });

  it("moves the focus for each key, clamped to the table, and ignores other keys", () => {
    expect(moveFocus(5, "ArrowDown", 10)).toBe(6);
    expect(moveFocus(9, "ArrowDown", 10)).toBe(9);
    expect(moveFocus(5, "ArrowUp", 10)).toBe(4);
    expect(moveFocus(0, "ArrowUp", 10)).toBe(0);
    expect(moveFocus(5, "PageDown", 100)).toBe(5 + VIEWPORT_ROWS);
    expect(moveFocus(95, "PageDown", 100)).toBe(99);
    expect(moveFocus(30, "PageUp", 100)).toBe(30 - VIEWPORT_ROWS);
    expect(moveFocus(3, "PageUp", 100)).toBe(0);
    expect(moveFocus(40, "Home", 100)).toBe(0);
    expect(moveFocus(40, "End", 100)).toBe(99);
    expect(moveFocus(0, "a", 100)).toBeNull();
    expect(moveFocus(0, "Tab", 100)).toBeNull();
    expect(moveFocus(0, "ArrowDown", 0)).toBeNull();
    expect(moveFocus(500, "ArrowUp", 10)).toBe(8); // a stale focus is clamped first
  });

  it("navigate moves the focus and the scroll together", () => {
    expect(navigate({ focus: 0, scrollTop: 0 }, "End", 1024)).toEqual({ focus: 1023, scrollTop: 1024 * ROW_HEIGHT - VIEWPORT_HEIGHT });
    expect(navigate({ focus: 1023, scrollTop: 20_000 }, "Home", 1024)).toEqual({ focus: 0, scrollTop: 0 });
    expect(navigate({ focus: 0, scrollTop: 0 }, "x", 1024)).toBeNull();
  });
});

// ---- the voice table ----

describe("the voice table: 1,024 voices, at most 64 rows rendered", () => {
  const data = voiceData(thousand());

  it("has every voice, windowed by the grid and not by the model", () => {
    expect(data.rows).toHaveLength(1024);
    expect(data.summary).toBe("1024 voices");
    expect(data.empty).toBeNull();
  });

  it("orders rows most audible first", () => {
    const first = data.rows[0]!;
    expect(first.id).toBe(1); // the highest audibility in `voice()`
    expect(data.rows.map((r) => r.audibility)).toEqual([...data.rows.map((r) => r.audibility)].sort((a, b) => b! - a!));
  });
});

describe("the voice table on a recorded scene: reasons and the thief", () => {
  const seekAtFrame = async (frame: number) => {
    const s = await openScene();
    const state = await s.seek(frame / SAMPLE_RATE);
    return { s, state };
  };

  it("shows a stolen voice's reason and the voice that stole it, by clip name", async () => {
    const { s, state } = await seekAtFrame(45_000); // voice 1 stolen by 3 at frame 40,000 (reason 3, priority)
    const names = captureNames(s.summary);
    const replay = reconstructVoices(state, names);
    const byId = new Map(replay.rows.map((r) => [r.id, r]));
    const victim = byId.get(1)!;
    expect(victim.state).toBe("stolen");
    expect(voiceCells(victim, byId)).toMatchObject({ state: "stolen", reason: "priority, by voice 3 (jump.ogg)", clip: "jump.ogg", bus: "Music" });

    s.close();
  });

  it("shows the reasons of virtual and promoted voices, and no thief for them", async () => {
    const { s, state } = await seekAtFrame(48_000); // voice 2 virtual (below audibility) since 47,000
    const names = captureNames(s.summary);
    const byId = new Map(reconstructVoices(state, names).rows.map((r) => [r.id, r]));
    expect(voiceCells(byId.get(2)!, byId)).toMatchObject({ state: "virtual", reason: "below audibility" });
    expect(voiceCells(byId.get(2)!, byId).reason).not.toContain("by voice");
    const { state: later } = await seekAtFrame(65_000); // promoted at 60,000
    const byIdLater = new Map(reconstructVoices(later, names).rows.map((r) => [r.id, r]));
    expect(voiceCells(byIdLater.get(2)!, byIdLater).reason).toBe("promoted");
    s.close();
  });

  it("names the thief by id when it isn't in the table, and prints '-' for fields a later voice doesn't have", () => {
    const row = { thief: 99, reasonText: "", clipName: "x", busName: "y", state: "stolen", priority: null, pitch: null, audibility: null, gain: 1, playheadFrames: 0, id: 1 } as unknown as VoiceRow;
    expect(voiceCells(row, new Map())).toMatchObject({ reason: "by voice 99", priority: "-", pitch: "-", audibility: "-", gain: "0.0 dB" });
  });
});

// ---- the bus table ----

/** A bus row whose lanes sit at the given gains (value and target alike; unity when absent), with the given flags. */
type BusOver = Partial<Record<"authored" | "runtime" | "snapshot" | "monitor" | "dip" | "duck" | "automation", number>> &
  Partial<Pick<CaptureKeyframeBus, "authoredMute" | "runtimeMute" | "tombstone">>;
const bus = (slot: number, o: BusOver = {}): CaptureKeyframeBus => {
  const at = (g = 1) => ({ value: g, target: g });
  return {
    slot, gen: 1, lanes: { authored: at(o.authored), runtime: at(o.runtime), snapshot: at(o.snapshot), monitor: at(o.monitor), dip: at(o.dip) },
    duck: o.duck ?? 1, automation: o.automation ?? 1, authoredMute: o.authoredMute ?? false, runtimeMute: o.runtimeMute ?? false,
    monitorMute: false, monitorSolo: false, tombstone: o.tombstone ?? false, metered: false,
  };
};

describe("the bus table", () => {
  const parents = busParents({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Music" }] }, NAMES_LOOKUP, 0);

  it("reads the parents from the META audio section by name", () => {
    expect([...parents]).toEqual([[0, null], [1, 0], [2, 1]]);
    expect([...busParents(undefined, namesFromStart({ buses: [[0, "Master"]] }), 0)]).toEqual([[0, null]]); // no section reads as the defaults: Master alone
    expect([...busParents({ buses: [{ name: "Master" }, { name: "Gone", parent: "Master" }] }, namesFromStart({ buses: [[0, "Master"]] }), 0)]).toEqual([[0, null]]); // a bus the capture never named
  });

  it("shows each bus's seven factors in dB, their product and the product up the tree", () => {
    const kf = keyframe({
      buses: [
        bus(0),
        bus(1, { authored: 0.5, duck: 0.5 }), // authored 0.5 and duck 0.5: product 0.25
        bus(2, { monitor: 0.5, automation: 0.5 }),
      ],
    });
    const rows = busTableRows(kf, NAMES_LOOKUP, 0, parents);
    expect(rows.map((r) => r.name)).toEqual(["Master", "Music", "SFX"]);
    const music = rows[1]!;
    expect(music.factors.map((f) => f.lane)).toEqual(["authored", "runtime", "snapshot", "monitor", "dip", "duck", "automation"]);
    expect(music.product).toBeCloseTo(0.25, 12);
    expect(music.nonUnity).toEqual(["authored", "duck"]);
    expect(music.productText).toBe("-12.0 dB");
    expect(rows[2]!.product).toBeCloseTo(0.25, 12); // monitor 0.5 x automation 0.5
    expect(rows[2]!.tree).toBeCloseTo(0.25 * 0.25, 12); // SFX under Music under Master
    expect(rows[2]!.treeText).toBe("-24.1 dB");
    expect(rows[0]!.tree).toBe(1);
  });

  it("shows a mute as silence, a tombstone as removed, and a missing name by slot", () => {
    const kf = keyframe({ buses: [bus(1, { authoredMute: true }), bus(2, { tombstone: true }), bus(7)] });
    const rows = busTableRows(kf, NAMES_LOOKUP, 0, parents);
    expect(rows[0]!.productText).toBe("-inf dB");
    expect(rows[2]!.name).toBe("bus 7");
  });
});

// ---- music ----

describe("music rows", () => {
  const eventName = namesFromStart({ events: [[1, "Intro"], [2, "Loop"], [3, "Outro"]] });
  const music: CaptureKeyframeMusic[] = [
    { id: 7, segment: 1, state: "playing", pass: 2, bar: 4, beat: 3, tick: 120, tempo: 120, pending: { to: 2, seconds: 12.5 } },
    { id: 8, segment: 3, state: "ending", pass: 1, bar: 1, beat: 1, tick: 0, tempo: 90, pending: null },
  ];
  const transition = (instance: number, from: number | null, to: number) => ({ kind: "event", event: { type: "musicTransition", perfMs: 0, instance, from, to } });

  it("reads the keyframe's music rows: segment, state, position, tempo and the pending transition", () => {
    const rows = musicRows(seekState(keyframe({ music })), eventName);
    expect(rows).toEqual([
      { id: 7, segment: "Intro", state: "playing", pass: 2, position: "4:3.120", tempo: 120, pendingTo: "Loop", pendingTimeSec: 12.5 },
      { id: 8, segment: "Outro", state: "ending", pass: 1, position: "1:1.0", tempo: 90, pendingTo: null, pendingTimeSec: null },
    ]);
  });

  it("applies a musicTransition after the keyframe (the instance moves, its pending transition clears) and starts new instances", () => {
    const rows = musicRows(seekState(keyframe({ music }), [transition(7, 1, 2), transition(9, null, 3)]), eventName);
    expect(rows.find((r) => r.id === 7)).toMatchObject({ segment: "Loop", pendingTo: null, position: "4:3.120" });
    expect(rows.find((r) => r.id === 9)).toMatchObject({ segment: "Outro", position: null, tempo: null });
    expect(rows).toHaveLength(3);
  });
});

// ---- the table kit: what each table shows at a seek state and filter ----

describe("the table kit", () => {
  const ev = (id: number, asset: number, voices = 1) => ({ id, asset, voices, paramsHash: 0 });
  const music: CaptureKeyframeMusic[] = [{ id: 7, segment: 1, state: "playing", pass: 1, bar: 1, beat: 1, tick: 0, tempo: 120, pending: null }];
  const full = seekState(keyframe({
    voices: [voice(1, { clip: 1, slot: 1 }), voice(2, { clip: 2, slot: 2 }), voice(3, { clip: 1, slot: 2 }), voice(4, { clip: 3, slot: 1 })],
    buses: [bus(0), bus(1), bus(2)],
    events: [ev(1, 5), ev(2, 6)],
    music,
  }));

  it("before a seek answered, every table is empty, asks for a cursor and has no summary", () => {
    const t = profilerTables(source(), null, "jump");
    for (const k of KINDS) expect([t[k].rows.length, t[k].summary, t[k].empty], k).toEqual([0, "", "noCursor"]);
  });

  it("with no filter, each table has every row at the cursor and counts them", () => {
    const t = profilerTables(source(), full, "");
    expect(t.voices.rows.map((r) => r.id)).toEqual([1, 2, 3, 4]); // most audible first
    expect(t.buses.rows.map((r) => r.name)).toEqual(["Master", "Music", "SFX"]);
    expect(t.events.rows.map((r) => r.name)).toEqual(["PlayerJump", "Ambience"]);
    expect(t.music.rows.map((r) => r.segment)).toEqual(["Intro"]);
    expect([t.voices.summary, t.buses.summary, t.events.summary, t.music.summary]).toEqual(["4 voices", "3 buses", "2 event instances", "1 music instance"]);
    for (const k of KINDS) expect(t[k].empty, k).toBeNull();
  });

  it("filters every table by its own names, case-insensitively and trimmed, and says how many matched", () => {
    expect(voiceData(full, "JUMP").rows.map((r) => r.id).sort()).toEqual([1, 3]); // clip name
    expect(voiceData(full, "sfx").rows.map((r) => r.id).sort()).toEqual([2, 3]); // bus name
    expect(voiceData(full, "  land ").rows.map((r) => r.id)).toEqual([2]);
    const t = profilerTables(source(), full, "mus");
    expect(t.buses.rows.map((r) => r.name)).toEqual(["Music"]);
    expect(t.voices.rows.map((r) => r.busName)).toEqual(["Music", "Music"]);
    expect([t.voices.summary, t.buses.summary, t.events.summary, t.music.summary]).toEqual(["2 of 4 voices", "1 of 3 buses", "0 of 2 event instances", "0 of 1 music instance"]);
    expect(profilerTables(source(), full, "jump").events.rows.map((r) => r.name)).toEqual(["PlayerJump"]); // event name
    expect(profilerTables(source(), full, "intro").music.rows.map((r) => r.segment)).toEqual(["Intro"]); // segment name
  });

  it("says nothing matched when the filter removed every row, and nothing is there when there was none", () => {
    const t = profilerTables(source(), full, "zzz");
    for (const k of KINDS) expect(t[k].empty, k).toBe("noMatch");
    const empty = profilerTables(source(), seekState(keyframe()), "zzz");
    for (const k of KINDS) expect(empty[k].empty, k).toBe("none");
    expect(profilerTables(source(), seekState(keyframe()), "").voices.summary).toBe("0 voices");
  });

  it("keeps every voice for naming a thief, filtered or not", () => {
    const t = profilerTables(source(), full, "land");
    expect(t.voices.rows).toHaveLength(1);
    expect(t.voices.all).toHaveLength(4);
  });

  it("before the first keyframe, the voices say they are only the last second's starts, and a truncated capture's tables say it wrapped", () => {
    const start = { kind: "event", event: { type: "voiceStart", perfMs: 0, voice: 9, clip: 1, slot: 1, gain: 1 } };
    const noKf = seekState(null, [start]);
    const t = profilerTables(source(), noKf, "");
    expect(t.voices.rows.map((r) => r.id)).toEqual([9]);
    expect(t.voices.summary).toContain("no keyframe at or before the cursor");
    expect(t.buses.summary).toBe("0 buses"); // the caveat is the voices'
    for (const k of KINDS) expect(profilerTables(source(), seekState(null), "")[k].empty, k).toBe("none");
    const truncated = profilerTables(source(true), seekState(null), "");
    for (const k of KINDS) expect(truncated[k].empty, k).toBe("truncated");
    expect(profilerTables(source(true), seekState(keyframe()), "").voices.empty).toBe("none"); // after a keyframe: nothing at the cursor
  });

  it("words each empty state: one text for no cursor and no match, one per table for nothing there, the design's for its states", () => {
    for (const e of ["noCursor", "noMatch"] as const) expect(new Set(KINDS.map((k) => tableEmptyText(k, e))).size, e).toBe(1);
    expect(new Set(KINDS.map((k) => tableEmptyText(k, "none"))).size).toBe(4);
    expect(tableEmptyText("voices", "none")).toBe("No voices at the cursor");
    for (const k of KINDS) expect(tableEmptyText(k, "truncated")).toBe(EMPTY_STATES.truncated);
  });
});

// ---- the slot ----

describe("the slot", () => {
  it("fits the profiler's `tables` slot", () => {
    const slot: ProfilerSlots["tables"] = ProfilerTables;
    expect(typeof slot).toBe("function");
    expect(typeof profilerSlots.tables).toBe("function");
  });
});

// ---- theme tokens only ----

describe("theme tokens only", () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklch\(|\boklab\(|\bcolor\(/;
  const NAMED = /:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey|cyan|magenta|purple|pink|brown)\b/i;
  for (const file of ["profilerTables.css", "WindowedGrid.tsx", "ProfilerTableSection.tsx", "VoiceTable.tsx", "BusTable.tsx", "profilerTables.tsx"]) {
    it(`${file} holds no colour literal and every var() is a theme token`, () => {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(LITERAL);
      expect(code).not.toMatch(NAMED);
      const css = readFileSync(new URL("../../../../editor/ui/editor.css", import.meta.url), "utf8");
      const tokens = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
      for (const m of src.matchAll(/var\((--[\w-]+)/g)) expect(tokens.has(m[1]!), m[1]).toBe(true);
    });
  }
});
