// ADR 0171/0172 (Pf5; api-and-models §7): the profiler's tables. Cases: the window (1,024 voices render at most 64 rows at
// every scroll position; scrolling moves the window), reasons and the thief on a real recorded scene, the filter, the bus
// table's factors and products, event and music rows, every empty state, keyboard focus through the rows, the filter
// input, and theme tokens only. The views are pure functions of their props (no hooks in the parts under test), so the
// tests call them and walk the VNode tree, as `MixerStrip.test.ts` does. No wall clock anywhere.
import { readFileSync } from "node:fs";
import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import { EventKind, type KeyframeBus, type KeyframePayload, type KeyframeVoice } from "../../runtime/capture/format";
import type { CaptureSeekState } from "../../runtime/capture/reader";
import { SAMPLE_RATE } from "../../runtime/capture/testSupport";
import { BusTableView, busCells, busTableData } from "./BusTable";
import { type ProfilerSlots, profilerSlots } from "./ProfilerPanel";
import { VoiceTableView, voiceTableData } from "./VoiceTable";
import { WindowedGridView, type WindowedGridProps } from "./WindowedGrid";
import {
  EVENT_COLUMNS, MUSIC_COLUMNS, ProfilerTables, ProfilerTablesView, RowsTableView, eventCells, musicCells, profilerTablesData,
} from "./profilerTables";
import {
  MAX_RENDERED_ROWS, OVERSCAN_ROWS, ROW_HEIGHT, TABLE_EMPTY, VIEWPORT_HEIGHT, VIEWPORT_ROWS, busParents, busTableRows, moveFocus,
  musicRows, navigate, scrollToIndex, tableEmptyText, thiefText, voiceCells, windowRows,
} from "./profilerTablesModel";
import { nameLookup, reconstructVoices, type VoiceRow } from "./voiceTableModel";
import { openScene } from "./voiceSceneSupport";

// ---- walking a rendered tree ----

type Node = VNode<Record<string, unknown>>;
function find(node: unknown, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) { node.forEach((c) => find(c, pred, out)); return out; }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const v = node as Node;
  if (typeof v.type === "function") return find((v.type as (p: unknown) => unknown)(v.props), pred, out); // render components in place
  if (pred(v)) out.push(v);
  return find(v.props.children, pred, out);
}
/** As `find`, but function components are not called (the stateful tables use hooks). */
function findShallow(node: unknown, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) { node.forEach((c) => findShallow(c, pred, out)); return out; }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const v = node as Node;
  if (pred(v)) out.push(v);
  return findShallow(v.props.children, pred, out);
}
const byClass = (cls: string) => (n: Node): boolean => typeof n.props.class === "string" && n.props.class.split(" ").includes(cls);
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const v = node as Node;
  if (typeof v.type === "function") return text((v.type as (p: unknown) => unknown)(v.props));
  return text(v.props.children);
}
const rowsOf = (tree: unknown): Node[] => find(tree, byClass("pgrid-row"));
const indices = (tree: unknown): number[] => rowsOf(tree).map((r) => r.props["data-index"] as number);
const cellTexts = (row: Node): string[] => find(row, byClass("pgrid-cell")).map((c) => text(c));

// ---- synthetic seek states ----

const EMPTY_MIX = { slotTableVersion: 1, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 };
function keyframe(over: Partial<KeyframePayload> = {}): KeyframePayload {
  return { voices: [], buses: [], metered: [], events: [], music: [], mix: EMPTY_MIX, ...over };
}
function seekState(kf: KeyframePayload | null, records: unknown[] = []): CaptureSeekState {
  return { seconds: 0, keyframeSeq: kf ? 1 : -1, keyframe: kf, status: null, records, recordsScanned: 0 } as unknown as CaptureSeekState;
}
const voice = (id: number, over: Partial<KeyframeVoice> = {}): KeyframeVoice => ({
  id, clip: 1 + (id % 3), slot: id % 3, state: 0, priority: id % 5, reason: 0, gain: 0.5, pitch: 4096, audibility: 65535 - id * 8, playheadFrames: id * 10, ...over,
});
const thousand = (): CaptureSeekState => seekState(keyframe({ voices: Array.from({ length: 1024 }, (_, i) => voice(i + 1)) }));
const NAMES_LOOKUP = nameLookup({ clips: new Map([[1, "jump.ogg"], [2, "Land.ogg"], [3, "footstep.ogg"]]), buses: new Map([[0, "Master"], [1, "Music"], [2, "SFX"]]), events: new Map(), parameters: new Map(), snapshots: new Map(), targets: new Map() } as never);
const CTX = { playing: false, truncated: false };

/** A fixed grid state for the stateless views. */
const gridAt = (scrollTop: number, focus = 0) => ({ scrollTop, focus, onScroll: () => {}, onKey: () => {}, onFocusRow: () => {} });

const voiceData = (state: CaptureSeekState, filter = "") => voiceTableData(reconstructVoices(state, NAMES_LOOKUP), filter, CTX);

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

  it("renders at most 64 rows at several scroll positions, and the window moves with the scroll", () => {
    const firsts: number[] = [];
    for (const scrollTop of [0, 150, 1_000, 5_000, 10_000, 15_000, 20_000, 20_480, 99_999]) {
      const tree = VoiceTableView({ data, grid: gridAt(scrollTop) });
      const idx = indices(tree);
      expect(idx.length, `scroll ${scrollTop}`).toBeGreaterThan(0);
      expect(idx.length, `scroll ${scrollTop}`).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
      expect(idx, `scroll ${scrollTop}`).toEqual(idx.map((_, i) => idx[0]! + i)); // contiguous
      const shown = windowRows({ total: 1024, scrollTop });
      const first = Math.floor(shown.scrollTop / ROW_HEIGHT);
      expect(idx).toContain(first); // the top visible row is rendered
      expect(idx).toContain(first + VIEWPORT_ROWS - 1); // and the bottom visible one
      firsts.push(idx[0]!);
    }
    expect(new Set(firsts).size).toBe(firsts.length - 1); // 20_480 and 99_999 both clamp to the end
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  });

  it("positions each row at its index and sizes the spacer for the whole list", () => {
    const tree = VoiceTableView({ data, grid: gridAt(10_000) });
    const spacer = find(tree, byClass("pgrid-spacer"))[0]!;
    expect((spacer.props.style as { height: string }).height).toBe(`${1024 * ROW_HEIGHT}px`);
    for (const r of rowsOf(tree)) expect((r.props.style as { top: string }).top).toBe(`${(r.props["data-index"] as number) * ROW_HEIGHT}px`);
    expect(find(tree, (n) => n.props.role === "grid")[0]!.props["aria-rowcount"]).toBe(1025);
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
    const names = nameLookup(s.summary.names);
    const replay = reconstructVoices(state, names);
    const byId = new Map(replay.rows.map((r) => [r.id, r]));
    const victim = byId.get(1)!;
    expect(victim.stateName).toBe("stolen");
    expect(thiefText(victim, byId)).toBe("voice 3 (jump.ogg)");
    expect(voiceCells(victim, byId)).toMatchObject({ state: "stolen", reason: "priority, by voice 3 (jump.ogg)", clip: "jump.ogg", bus: "Music" });

    const table = VoiceTableView({ data: voiceTableData(replay, "", CTX), grid: gridAt(0) });
    const row = rowsOf(table).find((r) => cellTexts(r)[0] === "1")!;
    expect(cellTexts(row)[4]).toBe("priority, by voice 3 (jump.ogg)");
    expect(row.props["data-state"]).toBe("stolen");
    s.close();
  });

  it("shows the reasons of virtual and promoted voices, and no thief for them", async () => {
    const { s, state } = await seekAtFrame(48_000); // voice 2 virtual (below audibility) since 47,000
    const names = nameLookup(s.summary.names);
    const byId = new Map(reconstructVoices(state, names).rows.map((r) => [r.id, r]));
    expect(voiceCells(byId.get(2)!, byId)).toMatchObject({ state: "virtual", reason: "below audibility" });
    expect(thiefText(byId.get(2)!, byId)).toBe("");
    const { state: later } = await seekAtFrame(65_000); // promoted at 60,000
    const byIdLater = new Map(reconstructVoices(later, names).rows.map((r) => [r.id, r]));
    expect(voiceCells(byIdLater.get(2)!, byIdLater).reason).toBe("promoted");
    s.close();
  });

  it("names the thief by id when it isn't in the table, and prints '-' for fields a later voice doesn't have", () => {
    const row = { thief: 99, reasonText: "", clipName: "x", busName: "y", stateName: "stolen", priority: null, pitch: null, audibility: null, gain: 1, playheadFrames: 0, id: 1 } as unknown as VoiceRow;
    expect(thiefText(row, new Map())).toBe("voice 99");
    expect(voiceCells(row, new Map())).toMatchObject({ reason: "by voice 99", priority: "-", pitch: "-", audibility: "-", gain: "0.0 dB" });
  });
});

describe("the filter", () => {
  const state = seekState(keyframe({ voices: [voice(1, { clip: 1, slot: 1 }), voice(2, { clip: 2, slot: 2 }), voice(3, { clip: 1, slot: 2 }), voice(4, { clip: 3, slot: 1 })] }));

  it("narrows the voice rows by clip or bus name, case-insensitively", () => {
    expect(voiceData(state, "JUMP").rows.map((r) => r.id).sort()).toEqual([1, 3]);
    expect(voiceData(state, "sfx").rows.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(voiceData(state, "  land ").rows.map((r) => r.id)).toEqual([2]);
    expect(voiceData(state, "").rows).toHaveLength(4);
  });

  it("says how many matched, and renders only the matching rows", () => {
    const d = voiceData(state, "jump");
    expect(d.summary).toBe("2 of 4 voices");
    expect(rowsOf(VoiceTableView({ data: d, grid: gridAt(0) }))).toHaveLength(2);
  });

  it("filters the other tables by their names and says when nothing matches", () => {
    const names = { audio: { buses: [{ name: "Master" }] }, names: { clips: new Map(), buses: new Map([[0, "Master"], [1, "Music"]]), events: new Map([[5, "PlayerJump"], [6, "Ambience"]]) } };
    const source = { summary: { names: names.names, meta: { audio: names.audio } }, truncated: false } as never;
    const seek = seekState(keyframe({ buses: [bus(0), bus(1)], events: [{ id: 1, asset: 5, voices: 2, state: 1, paramsHash: 0 }, { id: 2, asset: 6, voices: 1, state: 1, paramsHash: 0 }] }));
    const all = profilerTablesData(source, seek, "");
    expect(all.buses.rows).toHaveLength(2);
    expect(all.events.rows).toHaveLength(2);
    const some = profilerTablesData(source, seek, "mus");
    expect(some.buses.rows.map((r) => r.name)).toEqual(["Music"]);
    expect(some.events.rows).toHaveLength(0);
    expect(some.events.empty).toBe(TABLE_EMPTY.noMatch);
    expect(some.buses.summary).toBe("1 of 2 buses");
    expect(profilerTablesData(source, seek, "jump").events.rows.map((r) => r.name)).toEqual(["PlayerJump"]);
    expect(profilerTablesData(source, seek, "zzz").voices.empty).toBe(TABLE_EMPTY.none.voices); // no voices at all: not "no match"
  });
});

// ---- the bus table ----

const bus = (slot: number, over: Partial<KeyframeBus> = {}): KeyframeBus => ({
  slot, gen: 1, flags: 0, lanes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], duck: 1, automation: 1, ...over,
});

describe("the bus table", () => {
  const parents = busParents({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Music" }] }, [[0, "Master"], [1, "Music"], [2, "SFX"]]);

  it("reads the parents from the META audio section by name", () => {
    expect([...parents]).toEqual([[0, null], [1, 0], [2, 1]]);
    expect([...busParents(undefined, [[0, "Master"]])]).toEqual([[0, null]]); // no section reads as the defaults: Master alone
    expect([...busParents({ buses: [{ name: "Master" }, { name: "Gone", parent: "Master" }] }, [[0, "Master"]])]).toEqual([[0, null]]); // a bus the capture never named
  });

  it("shows each bus's seven factors in dB, their product and the product up the tree", () => {
    const kf = keyframe({
      buses: [
        bus(0, { lanes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }),
        bus(1, { lanes: [0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 1], duck: 0.5 }), // authored 0.5 and duck 0.5: product 0.25
        bus(2, { lanes: [1, 1, 1, 1, 1, 1, 0.5, 0.5, 1, 1], automation: 0.5 }), // snapshot... lane 3 (monitor) 0.5, automation 0.5
      ],
    });
    const rows = busTableRows(kf, NAMES_LOOKUP, parents);
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

  it("renders one row per bus with a cell per lane, flagged unity or active, plus the product and tree", () => {
    const kf = keyframe({ buses: [bus(1, { lanes: [0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 1] })] });
    const data = busTableData(busTableRows(kf, NAMES_LOOKUP, parents), 1, "", { ...CTX, beforeFirstKeyframe: false });
    const tree = BusTableView({ data, grid: gridAt(0) });
    const rows = rowsOf(tree);
    expect(rows).toHaveLength(1);
    const cells = find(rows[0], byClass("pgrid-cell"));
    expect(cells).toHaveLength(1 + 7 + 2);
    expect(cells.map((c) => c.props["data-flag"])).toEqual([undefined, "active", "unity", "unity", "unity", "unity", "unity", "unity", "active", "active"]);
    expect(cellTexts(rows[0]!)[0]).toBe("Music");
    expect(cellTexts(rows[0]!)[1]).toBe("-6.0 dB");
    expect(cellTexts(rows[0]!)[8]).toBe("-6.0 dB");
    expect(find(tree, (n) => n.props.role === "columnheader").map((n) => text(n))).toEqual(
      ["Bus", "Authored", "Runtime", "Snapshot", "Monitor", "Dip", "Duck", "Automation", "Product", "To output"],
    );
  });

  it("shows a mute as silence, a tombstone as removed, and a missing name by slot", () => {
    const kf = keyframe({ buses: [bus(1, { flags: 1 }), bus(2, { flags: 1 << 4 }), bus(7)] });
    const rows = busTableRows(kf, NAMES_LOOKUP, parents);
    expect(rows[0]!.productText).toBe("-inf dB");
    expect(busCells(rows[1]!)[0]).toEqual("SFX (removed)");
    expect(rows[2]!.name).toBe("bus 7");
    const view = BusTableView({ data: busTableData(rows, 3, "", { ...CTX, beforeFirstKeyframe: false }), grid: gridAt(0) });
    expect(rowsOf(view).map((r) => r.props["data-state"])).toEqual(["active", "removed", "unity"]);
  });
});

// ---- events and music ----

describe("event and music rows", () => {
  it("lists the event instances at the cursor of a recorded scene, with their voices", async () => {
    const s = await openScene();
    const state = await s.seek(5_000 / SAMPLE_RATE); // event 10 (PlayerJump) started at 2,000
    const data = profilerTablesData(s, state, "");
    expect(data.events.rows.map((r) => [r.id, r.name])).toEqual([[10, "PlayerJump"]]);
    expect(data.events.summary).toBe("1 event instance");
    const view = RowsTableView({ title: "Event instances", label: "events", columns: EVENT_COLUMNS, data: data.events, rowKey: (r) => r.id, cells: eventCells, grid: gridAt(0) });
    expect(cellTexts(rowsOf(view)[0]!)).toEqual(["10", "PlayerJump", "0"]); // started after the keyframe: the stream carries no voice count (voiceTableModel)
    s.close();
  });

  const eventName = (id: number): string | undefined => ({ 1: "Intro", 2: "Loop", 3: "Outro" } as Record<number, string>)[id];
  const music = [
    { id: 7, segment: 1, state: 1, pass: 2, bar: 4, beat: 3, tick: 120, tempo: 120, pendingTo: 2, pendingTimeSec: 12.5 },
    { id: 8, segment: 3, state: 4, pass: 1, bar: 1, beat: 1, tick: 0, tempo: 90, pendingTo: 0xffffffff, pendingTimeSec: 0 },
  ];
  const transition = (instance: number, from: number, to: number) => ({ kind: "event", payload: { kind: EventKind.musicTransition, reason: 0, args: [instance, from, to], perfMs: 0 } });

  it("reads the keyframe's music rows: segment, state, position, tempo and the pending transition", () => {
    const rows = musicRows(seekState(keyframe({ music })), eventName);
    expect(rows).toEqual([
      { id: 7, segment: "Intro", state: "playing", pass: 2, position: "4:3.120", tempo: 120, pendingTo: "Loop", pendingTimeSec: 12.5 },
      { id: 8, segment: "Outro", state: "ending", pass: 1, position: "1:1.0", tempo: 90, pendingTo: null, pendingTimeSec: null },
    ]);
    expect(musicCells(rows[0]!)).toEqual(["7", "Intro", "playing", "2", "4:3.120", "120", "to Loop at 12.50 s"]);
    expect(musicCells(rows[1]!)).toEqual(["8", "Outro", "ending", "1", "1:1.0", "90", ""]);
  });

  it("applies a musicTransition after the keyframe (the instance moves, its pending transition clears) and starts new instances", () => {
    const rows = musicRows(seekState(keyframe({ music }), [transition(7, 1, 2), transition(9, 0xffffffff, 3)]), eventName);
    expect(rows.find((r) => r.id === 7)).toMatchObject({ segment: "Loop", pendingTo: null, position: "4:3.120" });
    expect(rows.find((r) => r.id === 9)).toMatchObject({ segment: "Outro", position: null, tempo: null });
    expect(rows).toHaveLength(3);
  });

  it("filters music rows by segment name", () => {
    expect(musicRows(seekState(keyframe({ music })), eventName, "out").map((r) => r.id)).toEqual([8]);
    expect(MUSIC_COLUMNS.length).toBe(7);
  });
});

// ---- empty states ----

describe("every empty state", () => {
  const base = { playing: false, truncated: false, beforeFirstKeyframe: false, rows: 0, unfiltered: 0, filter: "", ready: true };

  it("asks for a cursor position before any seek answered, in every table", () => {
    for (const kind of ["voices", "buses", "events", "music"] as const) {
      expect(tableEmptyText(kind, { ...base, ready: false })).toBe(TABLE_EMPTY.noCursor);
    }
    const data = profilerTablesData({ summary: { names: { clips: new Map(), buses: new Map(), events: new Map() }, meta: {} }, truncated: false } as never, null, "");
    expect([data.voices.empty, data.buses.empty, data.events.empty, data.music.empty]).toEqual([TABLE_EMPTY.noCursor, TABLE_EMPTY.noCursor, TABLE_EMPTY.noCursor, TABLE_EMPTY.noCursor]);
  });

  it("has a text for each table with no rows", () => {
    expect(tableEmptyText("voices", base)).toBe("No voices at the cursor");
    expect(tableEmptyText("buses", base)).toBe("No bus data at the cursor");
    expect(tableEmptyText("events", base)).toBe("No event instances at the cursor");
    expect(tableEmptyText("music", base)).toBe("No music playing at the cursor");
  });

  it("says nothing matched when the filter removed every row, and nothing when there are rows", () => {
    expect(tableEmptyText("voices", { ...base, filter: "zz", unfiltered: 5 })).toBe(TABLE_EMPTY.noMatch);
    expect(tableEmptyText("voices", { ...base, rows: 3, unfiltered: 5 })).toBeNull();
  });

  it("uses the design's Truncated text before a truncated capture's first keyframe", () => {
    expect(tableEmptyText("voices", { ...base, truncated: true, beforeFirstKeyframe: true })).toBe("Truncated: the ring wrapped");
    expect(tableEmptyText("buses", { ...base, truncated: true, beforeFirstKeyframe: true })).toBe("Truncated: the ring wrapped");
    expect(tableEmptyText("voices", { ...base, truncated: true, beforeFirstKeyframe: false })).toBe(TABLE_EMPTY.none.voices);
  });

  it("draws the empty text instead of a grid", () => {
    const empty = VoiceTableView({ data: voiceData(seekState(keyframe())), grid: gridAt(0) });
    expect(find(empty, byClass("ptable-empty")).map(text)).toEqual(["No voices at the cursor"]);
    expect(rowsOf(empty)).toHaveLength(0);
    expect(find(empty, (n) => n.props.role === "grid")).toHaveLength(0);
  });

  it("says a seek with no keyframe lists only the last second's starts", () => {
    const d = voiceTableData(reconstructVoices(seekState(null), NAMES_LOOKUP), "", CTX);
    expect(d.empty).toBe(TABLE_EMPTY.none.voices);
    const noKf = voiceTableData({ rows: reconstructVoices(seekState(keyframe({ voices: [voice(1)] })), NAMES_LOOKUP).rows, fromKeyframe: false }, "", CTX);
    expect(noKf.summary).toContain("no keyframe at or before the cursor");
  });
});

// ---- keyboard focus ----

describe("keyboard focus moves through the rows", () => {
  const data = voiceData(thousand());

  /** A tiny host: the grid state the stateful table keeps, driven by the view's own `onKey`. */
  function host() {
    const st = { scrollTop: 0, focus: 0 };
    const grid = {
      get scrollTop() { return st.scrollTop; },
      get focus() { return st.focus; },
      onScroll: (top: number) => { st.scrollTop = top; },
      onKey: (key: string, prevent: () => void) => {
        const next = navigate({ focus: st.focus, scrollTop: st.scrollTop }, key, data.rows.length);
        if (!next) return;
        prevent();
        Object.assign(st, next);
      },
      onFocusRow: (i: number) => { st.focus = i; },
    };
    const render = () => VoiceTableView({ data, grid });
    const press = (key: string): boolean => {
      let prevented = false;
      const grids = find(render(), (n) => n.props.role === "grid");
      (grids[0]!.props.onKeyDown as (e: { key: string; preventDefault(): void }) => void)({ key, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    const focused = (): Node[] => rowsOf(render()).filter((r) => r.props.tabIndex === 0);
    return { st, render, press, focused };
  }

  it("has one tab stop, the focused row, and moves it down and up one row per arrow key", () => {
    const h = host();
    expect(h.focused().map((r) => r.props["data-index"])).toEqual([0]);
    expect(h.press("ArrowDown")).toBe(true);
    expect(h.focused().map((r) => r.props["data-index"])).toEqual([1]);
    for (let i = 0; i < 29; i++) h.press("ArrowDown");
    expect(h.st.focus).toBe(30);
    expect(h.focused().map((r) => r.props["data-index"])).toEqual([30]); // rendered: the window followed the focus
    expect(indices(h.render()).length).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
    h.press("ArrowUp");
    expect(h.focused().map((r) => r.props["data-index"])).toEqual([29]);
  });

  it("pages, and jumps to the first and last row, keeping the focused row rendered", () => {
    const h = host();
    h.press("PageDown");
    expect(h.st.focus).toBe(VIEWPORT_ROWS);
    h.press("End");
    expect(h.focused().map((r) => r.props["data-index"])).toEqual([1023]);
    expect(indices(h.render()).at(-1)).toBe(1023);
    h.press("PageUp");
    expect(h.st.focus).toBe(1023 - VIEWPORT_ROWS);
    expect(h.focused()).toHaveLength(1);
    h.press("Home");
    expect(h.focused().map((r) => r.props["data-index"])).toEqual([0]);
    expect(h.st.scrollTop).toBe(0);
  });

  it("leaves other keys to the browser", () => {
    const h = host();
    expect(h.press("a")).toBe(false);
    expect(h.press("Tab")).toBe(false);
    expect(h.st.focus).toBe(0);
  });

  it("makes the scroll region the tab stop while the focused row is scrolled out of the window", () => {
    const grid = (scrollTop: number): WindowedGridProps<VoiceRow>["scrollTop"] => scrollTop;
    const region = (scrollTop: number) => find(VoiceTableView({ data, grid: gridAt(grid(scrollTop), 0) }), (n) => n.props["data-scroll"] === true)[0]!;
    expect(region(0).props.tabIndex).toBe(-1); // row 0 is rendered and is the tab stop
    expect(region(15_000).props.tabIndex).toBe(0); // row 0 is far above the window
  });

  it("focuses a row on click", () => {
    let focused = -1;
    const tree = WindowedGridView({ label: "t", columns: [{ key: "a", title: "A" }], rows: ["x", "y", "z"], rowKey: (r) => r, cells: (r) => [r], scrollTop: 0, focus: 0, onScroll: () => {}, onKey: () => {}, onFocusRow: (i) => { focused = i; } });
    const second = find(tree, byClass("pgrid-row"))[1]!;
    (second.props.onClick as () => void)();
    expect(focused).toBe(1);
  });
});

// ---- the filter input and the slot ----

describe("the filter input and the slot", () => {
  const source = { summary: { names: { clips: new Map(), buses: new Map(), events: new Map() }, meta: {} }, truncated: false } as never;
  const data = profilerTablesData(source, seekState(keyframe()), "");

  it("has a search input that reports what is typed", () => {
    const typed: string[] = [];
    const tree = ProfilerTablesView({ data, filter: "abc", onFilter: (t) => typed.push(t) });
    const input = findShallow(tree, (n) => n.type === "input")[0]!;
    expect(input.props.value).toBe("abc");
    expect(input.props["aria-label"]).toBe("Filter tables by name");
    (input.props.onInput as (e: unknown) => void)({ currentTarget: { value: "jump" } });
    expect(typed).toEqual(["jump"]);
  });

  it("composes the voice, bus, event and music tables under the filter, in that order", () => {
    const tree = ProfilerTablesView({ data, filter: "", onFilter: () => {} });
    const kids = (tree.props.children as unknown[]).filter(Boolean) as Node[];
    expect(kids.map((k) => (typeof k.type === "string" ? k.type : (k.type as { name: string }).name))).toEqual(["label", "VoiceTable", "BusTable", "RowsTable", "RowsTable"]);
    expect(kids.slice(3).map((k) => k.props.label)).toEqual(["events", "music"]);
  });

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
  for (const file of ["profilerTables.css", "WindowedGrid.tsx", "VoiceTable.tsx", "BusTable.tsx", "profilerTables.tsx"]) {
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
