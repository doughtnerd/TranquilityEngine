// ADR 0171 amended by 0172 (M5b, task Rc3, leaf L-Rc3a): the real `ProfileSink` (`capture/events.ts`). A spec table, one row
// per §5.6 kind x reason, drives a sink over a real recorder and decodes the ring back through Rc1's reader; then the
// interned names, EPOCH, GAP, MARKER, the deferred stamp, and the no-allocation structure (by construction: the args arrays,
// the payload and the NAMES writes are counted through spies on `format.ts`'s encoders).
import { describe, expect, it, vi } from "vitest";
import * as format from "./format";
import { assembleCapture } from "./format";
import { CAPTURE_MARKER_MAX_BYTES, CAPTURE_NAME_MAX_BYTES, EpochReason, EventKind, GapReason, RECORD_FLAG_DEFERRED, RecordType, type EventPayload, type NameTable } from "./format";
import { EventSink, NO_NAME, createEventSink, type EventSinkOptions } from "./events";
import type { ProfileEpochReason, ProfileGapReason } from "../mix/profileSink";
import { decodeRecordAt, openLiveCapture, type CaptureContents, type DecodedRecord } from "./reader";
import { Recorder, createRecorder, type EpochContext } from "./recorder";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeCodecForTests, statusBytes } from "./testSupport";

vi.mock("./format", async (importOriginal) => {
  const real = await importOriginal<typeof import("./format")>();
  return { ...real, encodeEvent: vi.fn(real.encodeEvent), encodeNames: vi.fn(real.encodeNames), namesBytes: vi.fn(real.namesBytes) };
});

const MiB = 1024 * 1024;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };

interface Rig { r: Recorder; sink: EventSink; feed(frame: number): void; decode(): CaptureContents }

function rig(opts: EventSinkOptions & { begin?: boolean } = {}): Rig {
  let t = 1000;
  const now = () => (t += 1);
  const r = createRecorder({ ringBytes: 4 * MiB, codec: keyframeCodecForTests(), now });
  if (opts.begin !== false) r.begin(0, CONTEXT);
  const sink = createEventSink(r, { now, ...opts });
  return {
    r, sink,
    feed(frame) {
      const block = statusBytes(frame);
      const data = block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength) as ArrayBuffer;
      r.tap(data, block.byteLength, new DataView(data));
    },
    decode() {
      const d = openLiveCapture(assembleCapture(SAMPLE_HEADER, { ...SAMPLE_META, names: { clips: {}, buses: {}, events: {}, parameters: {}, snapshots: {}, targets: {} } }, []));
      d.appendRecords(r.takeSpan().bytes);
      return d.contents;
    },
  };
}

function all(c: CaptureContents): DecodedRecord[] {
  return Array.from({ length: c.records.count }, (_, i) => decodeRecordAt(c, i));
}
function events(c: CaptureContents): Array<DecodedRecord & { kind: "event" }> {
  return all(c).filter((d): d is DecodedRecord & { kind: "event" } => d.kind === "event");
}

/** An expected arg that is a name: resolved through the decoded NAMES tables (and META's). */
const N = (table: NameTable, name: string) => ({ table, name });
type Arg = number | ReturnType<typeof N>;
function idOf(c: CaptureContents, table: NameTable, name: string): number {
  for (const [id, n] of c.names[table]) if (n === name) return id;
  throw new Error(`no ${table} name "${name}"`);
}
function expected(c: CaptureContents, args: readonly Arg[]): number[] {
  return args.map((a) => (typeof a === "number" ? a : idOf(c, a.table, a.name)));
}
const f32 = (x: number) => Math.fround(x);

interface Row {
  /** The sink call. */
  name: string;
  call(s: EventSink): void;
  kind: number;
  reason: number;
  args: readonly Arg[];
  f32?: number;
  /** The record head frame when not "now" (768). */
  frame?: number;
}

// §5.6, one row per kind x reason. The args follow `events.ts`' header: ids from NAMES tables for strings.
const rows: Row[] = [
  { name: "voiceStart", call: (s) => s.voiceStart(7, "hop.ogg", "Bgm", 3, 800, 0.5), kind: EventKind.voiceStart, reason: 0, args: [7, N("clips", "hop.ogg"), N("buses", "Bgm"), 3, 800], f32: 0.5, frame: 800 },
  ...(["ended", "stopped", "faded", "worldReleased", "failed"] as const).map((reason, i): Row => ({ name: `voiceStop ${reason}`, call: (s) => s.voiceStop(9, reason), kind: EventKind.voiceStop, reason: i + 1, args: [9] })),
  ...(["busMaxVoices", "globalLimit", "priority"] as const).map((reason, i): Row => ({ name: `voiceSteal ${reason}`, call: (s) => s.voiceSteal(4, 5, reason), kind: EventKind.voiceSteal, reason: i + 1, args: [4, 5] })),
  ...(["capDemoted", "belowAudibility", "paused", "worldInaudible"] as const).map((reason, i): Row => ({ name: `voiceVirtual ${reason}`, call: (s) => s.voiceVirtual(11, reason), kind: EventKind.voiceVirtual, reason: i + 1, args: [11] })),
  ...(["promoted", "capRaised"] as const).map((reason, i): Row => ({ name: `voiceReal ${reason}`, call: (s) => s.voiceReal(12, reason), kind: EventKind.voiceReal, reason: i + 1, args: [12] })),
  ...(["busFull", "poolFull", "neverFits", "loadFailed", "capRefused"] as const).map((reason, i): Row => ({ name: `voiceRefused ${reason}`, call: (s) => s.voiceRefused("land.ogg", "Sfx", reason), kind: EventKind.voiceRefused, reason: i + 1, args: [N("clips", "land.ogg"), N("buses", "Sfx")] })),
  ...(["clipLoading", "streamPriming"] as const).map((reason, i): Row => ({ name: `voiceQueued ${reason}`, call: (s) => s.voiceQueued("theme.ogg", "Bgm", reason), kind: EventKind.voiceQueued, reason: i + 1, args: [N("clips", "theme.ogg"), N("buses", "Bgm")] })),
  { name: "eventStart", call: (s) => s.eventStart(21, "footsteps"), kind: EventKind.eventStart, reason: 0, args: [21, N("events", "footsteps")] },
  { name: "eventStop", call: (s) => s.eventStop(21), kind: EventKind.eventStop, reason: 0, args: [21] },
  { name: "snapshot", call: (s) => s.snapshot("Underwater", 1.5), kind: EventKind.snapshot, reason: 0, args: [N("snapshots", "Underwater")], f32: 1.5 },
  { name: "stateChange", call: (s) => s.stateChange("Surface", "Water"), kind: EventKind.stateChange, reason: 0, args: [N("parameters", "Surface"), N("parameters", "Water")] },
  { name: "musicTransition from a segment", call: (s) => s.musicTransition(2, "Intro", "Loop"), kind: EventKind.musicTransition, reason: 0, args: [2, N("events", "Intro"), N("events", "Loop")] },
  { name: "musicTransition from nothing", call: (s) => s.musicTransition(2, null, "Intro"), kind: EventKind.musicTransition, reason: 0, args: [2, NO_NAME, N("events", "Intro")] },
  ...(["authored", "runtime", "snapshot", "monitor", "dip"] as const).map((lane, i): Row => ({ name: `busRamp ${lane}`, call: (s) => s.busRamp("Sfx", lane, 480, 0.25), kind: EventKind.busRamp, reason: 0, args: [N("buses", "Sfx"), i, 480], f32: 0.25 })),
  { name: "busRamp unknown lane", call: (s) => s.busRamp("Sfx", "future", 96, 1), kind: EventKind.busRamp, reason: 0, args: [N("buses", "Sfx"), NO_NAME, 96], f32: 1 },
  { name: "monitor", call: (s) => s.monitor(0b1010), kind: EventKind.monitor, reason: 0, args: [0b1010] },
  ...(["reset", "pause", "resume", "target"] as const).map((control, i): Row => ({ name: `loudnessControl ${control} on a bus`, call: (s) => s.loudnessControl(control, "Bgm"), kind: EventKind.loudnessControl, reason: i + 1, args: [N("buses", "Bgm")] })),
  ...(["reset", "pause", "resume", "target"] as const).map((control, i): Row => ({ name: `loudnessControl ${control} on no bus`, call: (s) => s.loudnessControl(control, null), kind: EventKind.loudnessControl, reason: i + 1, args: [NO_NAME] })),
  { name: "ladder shed", call: (s) => s.ladder(3, true), kind: EventKind.ladder, reason: 2, args: [3] },
  { name: "ladder restored", call: (s) => s.ladder(3, false), kind: EventKind.ladder, reason: 3, args: [3] },
  { name: "masterChange muted", call: (s) => s.masterChange(0.75, true), kind: EventKind.masterChange, reason: 0, args: [1], f32: 0.75 },
  { name: "masterChange live", call: (s) => s.masterChange(1, false), kind: EventKind.masterChange, reason: 0, args: [0], f32: 1 },
  { name: "hiddenTab hidden", call: (s) => s.hiddenTab(true), kind: EventKind.hiddenTab, reason: 0, args: [1] },
  { name: "hiddenTab shown", call: (s) => s.hiddenTab(false), kind: EventKind.hiddenTab, reason: 0, args: [0] },
];

describe("EventSink: every §5.6 kind and reason encodes and decodes back (a spec table)", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    const g = rig();
    g.feed(768);
    row.call(g.sink);
    const c = g.decode();
    const e = events(c);
    expect(e).toHaveLength(1);
    const ev = e[0]!;
    expect(ev.payload.kind).toBe(row.kind);
    expect(ev.payload.reason).toBe(row.reason);
    expect(ev.payload.args).toEqual(expected(c, row.args));
    if (row.f32 === undefined) expect(ev.payload.f32).toBeUndefined();
    else expect(ev.payload.f32).toBe(f32(row.f32));
    expect(ev.epoch).toBe(0);
    expect(ev.frame).toBe(row.frame ?? 768);
    expect(ev.flags).toBe(0);
    expect(ev.payload.perfMs).toBeGreaterThan(1000);
  });

  it("the table covers all 19 kinds and every reason code §5.6 gives", () => {
    const kinds = new Set(rows.map((r) => r.kind));
    expect(Array.from(kinds).sort((a, b) => a - b)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1).filter((k) => k !== EventKind.parameter));
    for (const [kind, max] of format.EVENT_REASON_MAX) {
      const reasons = new Set(rows.filter((r) => r.kind === kind).map((r) => r.reason));
      for (let reason = kind === EventKind.ladder ? 2 : 1; reason <= max; reason++) expect(reasons.has(reason), `kind ${kind} reason ${reason}`).toBe(true);
    }
  });

  it("parameter: name id, instance (or NO_NAME for a global one) and the value's f32 bits", () => {
    const g = rig();
    g.feed(768);
    g.sink.parameter("Speed", 0.375, 5);
    g.sink.parameter("Speed", -2, null);
    const c = g.decode();
    const e = events(c);
    const bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;
    const id = idOf(c, "parameters", "Speed");
    expect(e.map((x) => [x.payload.kind, x.payload.reason, x.payload.args])).toEqual([
      [EventKind.parameter, 0, [id, 5, bits(0.375)]],
      [EventKind.parameter, 0, [id, NO_NAME, bits(-2)]],
    ]);
    expect(e[0]!.payload.f32).toBeUndefined();
  });

});

describe("EventSink: names are interned once", () => {
  it("two events on one clip and bus write one NAMES record each, before the first event that uses them", () => {
    const g = rig();
    g.feed(768);
    g.sink.voiceStart(1, "hop.ogg", "Sfx", 0, 0, 1);
    g.sink.voiceStart(2, "hop.ogg", "Sfx", 0, 0, 1);
    g.sink.voiceRefused("hop.ogg", "Sfx", "busFull");
    const c = g.decode();
    const rec = all(c);
    const names = rec.filter((d) => d.kind === "names");
    expect(names.map((d) => d.kind === "names" && [d.payload.table, d.payload.id, d.payload.name])).toEqual([[0, 0, "hop.ogg"], [1, 0, "Sfx"]]);
    expect(g.sink.namesWritten).toBe(2);
    const firstEvent = rec.findIndex((d) => d.kind === "event");
    expect(rec.findIndex((d) => d.kind === "names")).toBeLessThan(firstEvent);
    const ev = events(c);
    expect(ev.map((x) => (x.payload.kind === EventKind.voiceStart ? x.payload.args.slice(1, 3) : x.payload.args))).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it("the same string in two tables is two names; ids count up per table", () => {
    const g = rig();
    g.sink.voiceStart(1, "Water", "Water", 0, 0, 1);
    g.sink.parameter("Water", 1, null);
    g.sink.eventStart(1, "Water");
    g.sink.voiceStart(2, "Rain", "Sfx", 0, 0, 1);
    const c = g.decode();
    expect(Object.fromEntries((["clips", "buses", "events", "parameters"] as const).map((t) => [t, [...c.names[t]]]))).toEqual({
      clips: [[0, "Water"], [1, "Rain"]], buses: [[0, "Water"], [1, "Sfx"]], events: [[0, "Water"]], parameters: [[0, "Water"]],
    });
  });

  it("seed reuses META's ids and continues after the largest", () => {
    const g = rig();
    g.sink.seed("clips", 4, "hop.ogg");
    g.sink.seed("buses", 1, "Bgm");
    g.sink.voiceStart(1, "hop.ogg", "Bgm", 0, 0, 1);
    g.sink.voiceStart(2, "land.ogg", "Bgm", 0, 0, 1);
    const c = g.decode();
    expect(events(c).map((e) => e.payload.args.slice(1, 3))).toEqual([[4, 1], [5, 1]]);
    expect(all(c).filter((d) => d.kind === "names").map((d) => d.kind === "names" && d.payload.name)).toEqual(["land.ogg"]);
  });

  it("a name past 256 B is cut at a character boundary", () => {
    const g = rig();
    const long = "é".repeat(200);
    g.sink.eventStart(1, long);
    g.sink.eventStart(2, long);
    const c = g.decode();
    const names = [...c.names.events.values()];
    expect(names).toHaveLength(1);
    expect(new TextEncoder().encode(names[0]!).byteLength).toBeLessThanOrEqual(CAPTURE_NAME_MAX_BYTES);
    expect(long.startsWith(names[0]!)).toBe(true);
  });

  it("a name the ring couldn't take (before begin) is retried, not lost: it is interned at its next use", () => {
    const g = rig({ begin: false });
    g.sink.voiceStart(1, "hop.ogg", "Sfx", 0, 0, 1);
    expect(g.sink.namesWritten).toBe(0);
    expect(g.sink.eventsDropped).toBe(1);
    expect(g.sink.eventsWritten).toBe(0);
    g.r.begin(0, CONTEXT);
    g.sink.voiceStart(2, "hop.ogg", "Sfx", 0, 0, 1);
    const c = g.decode();
    expect([...c.names.clips]).toEqual([[0, "hop.ogg"]]);
    expect(events(c).map((e) => e.payload.args.slice(0, 3))).toEqual([[2, 0, 0]]);
  });

  it("reset starts the tables over", () => {
    const g = rig();
    g.sink.eventStart(1, "a");
    g.sink.reset();
    g.sink.eventStart(2, "b");
    expect(g.sink.namesWritten).toBe(1);
    expect(g.sink.interned[2]!.get("b")).toBe(0);
    expect(g.sink.interned[2]!.has("a")).toBe(false);
  });
});

describe("EventSink: frames and the deferred stamp (§5.3)", () => {
  it("a tap is recorded at the newest STATUS frame", () => {
    const g = rig();
    g.feed(768);
    g.sink.monitor(1);
    g.feed(1536);
    g.sink.monitor(2);
    expect(events(g.decode()).map((e) => e.frame)).toEqual([768, 1536]);
  });

  it("voiceStart: asap (0) and past frames are recorded at now; a start up to 1 s ahead at its own frame", () => {
    const g = rig();
    g.feed(768);
    g.sink.voiceStart(1, "a", "b", 0, 0, 1);
    g.sink.voiceStart(2, "a", "b", 0, 100, 1);
    g.sink.voiceStart(3, "a", "b", 0, 768 + SAMPLE_RATE, 1);
    const e = events(g.decode());
    expect(e.map((x) => [x.frame, x.flags, x.stamp])).toEqual([[768, 0, undefined], [768, 0, undefined], [768 + SAMPLE_RATE, 0, undefined]]);
  });

  it("voiceStart more than 1 s ahead is recorded at now with the deferred flag and its stamp leading the payload", () => {
    const g = rig();
    g.feed(768);
    const at = 768 + 2 * SAMPLE_RATE + 5;
    g.sink.voiceStart(1, "a", "b", 6, at, 0.5);
    const c = g.decode();
    const [e] = events(c);
    expect(e!.flags).toBe(RECORD_FLAG_DEFERRED);
    expect(e!.frame).toBe(768);
    expect(e!.stamp).toBe(at);
    expect(e!.payload.args).toEqual([1, 0, 0, 6, at]);
    expect(e!.payload.f32).toBe(0.5);
    // The raw record: the stamp is the first 8 payload bytes, and the head's len covers it.
    const t = c.records;
    const i = Array.from({ length: t.count }, (_, k) => k).find((k) => t.type[k] === RecordType.EVENT)!;
    expect(t.flags[i]).toBe(RECORD_FLAG_DEFERRED);
  });

  it("atFrame's low 32 bits go into the arg", () => {
    const g = rig();
    const at = 2 ** 32 + 77;
    g.sink.voiceStart(1, "a", "b", 0, at, 1);
    expect(events(g.decode())[0]!.payload.args[4]).toBe(77);
  });
});

describe("EventSink: epoch, gap, marker", () => {
  const epochs: ProfileEpochReason[] = ["trap", "stall", "device", "rate", "latency", "mode"];

  it("epoch('start') begins a recording that wasn't begun: EPOCH 0 then a KEYFRAME", () => {
    const g = rig({ begin: false, epochContext: () => ({ ...CONTEXT, timeOffset: 1.5, frame: 96 }) });
    g.sink.epoch("start");
    const rec = all(g.decode());
    expect(rec.map((d) => d.kind)).toEqual(["epoch", "keyframe"]);
    const e = rec[0]!;
    expect(e.kind === "epoch" && e.payload).toMatchObject({ reason: EpochReason.start, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 1.5 });
    expect(e.frame).toBe(96);
  });

  it.each(epochs.map((r) => [r] as const))("epoch(%s) opens a new epoch with its reason code and context", (reason) => {
    const g = rig({ epochContext: () => ({ ...CONTEXT, sampleRate: 44_100, outputLatencyFrames: 441, timeOffset: 3.25 }) });
    g.feed(768);
    g.sink.epoch(reason);
    g.sink.monitor(1);
    const rec = all(g.decode());
    const ep = rec.filter((d) => d.kind === "epoch");
    expect(ep).toHaveLength(2);
    const second = ep[1]!;
    expect(second.kind === "epoch" && second.payload).toMatchObject({ reason: EpochReason[reason], sampleRate: 44_100, outputLatencyFrames: 441, timeOffset: 3.25 });
    expect(second.epoch).toBe(1);
    expect(second.frame).toBe(0);
    expect(rec.filter((d) => d.kind === "event").map((d) => d.epoch)).toEqual([1]);
  });

  it("a new epoch's events are recorded from its own frames", () => {
    const g = rig();
    g.feed(48_000);
    g.sink.epoch("trap");
    g.sink.monitor(1);
    const e = events(g.decode());
    expect(e[0]!.frame).toBe(0);
  });

  it("epoch with no context option names the recorder's rate and zeros", () => {
    const g = rig();
    g.sink.epoch("device");
    const ep = all(g.decode()).filter((d) => d.kind === "epoch");
    expect(ep[1]!.kind === "epoch" && ep[1]!.payload).toMatchObject({ reason: EpochReason.device, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0 });
  });

  it("epoch before begin (other than start) writes nothing", () => {
    const g = rig({ begin: false });
    g.sink.epoch("trap");
    expect(g.r.epochNumber).toBe(-1);
  });

  const gaps: ProfileGapReason[] = ["paused", "rebuild", "held", "dropped", "recordTooLarge"];
  it.each(gaps.map((r) => [r] as const))("gap(%s) writes a GAP with its reason code at the newest frame", (reason) => {
    const g = rig();
    g.feed(768);
    g.sink.gap(reason);
    const gap = all(g.decode()).find((d) => d.kind === "gap")!;
    expect(gap.kind === "gap" && gap.payload).toMatchObject({ reason: GapReason[reason], firstSeq: 0, lastSeq: 0 });
    expect(gap.kind === "gap" && gap.payload.perfTo).toBeGreaterThanOrEqual(gap.kind === "gap" ? gap.payload.perfFrom : 0);
    expect(gap.frame).toBe(768);
  });

  it("gap before begin writes nothing", () => {
    const g = rig({ begin: false });
    g.sink.gap("rebuild");
    g.sink.marker("x");
    expect(g.r.epochNumber).toBe(-1);
    expect(g.r.ring.usedBytes).toBe(0);
  });

  it("marker writes a MARKER cut to 120 UTF-8 bytes", () => {
    const g = rig();
    g.feed(768);
    g.sink.marker("owner joined ✓");
    g.sink.marker("é".repeat(100));
    const m = all(g.decode()).filter((d) => d.kind === "marker");
    expect(m.map((d) => d.kind === "marker" && d.payload.text.slice(0, 6))).toEqual(["owner ", "éééééé"]);
    const second = m[1]!;
    expect(second.kind === "marker" && new TextEncoder().encode(second.payload.text).byteLength).toBeLessThanOrEqual(CAPTURE_MARKER_MAX_BYTES);
    expect(m[0]!.frame).toBe(768);
  });
});

describe("EventSink: nothing allocates per event (by construction)", () => {
  const encodeEvent = vi.mocked(format.encodeEvent);
  const encodeNames = vi.mocked(format.encodeNames);

  it("repeat events reuse one payload object and one args array per length; a repeat name writes no NAMES", () => {
    const g = rig();
    g.feed(768);
    // Prime: every name used below is interned here.
    const play = () => {
      g.sink.voiceStart(1, "hop.ogg", "Sfx", 0, 0, 1);
      g.sink.voiceStop(1, "ended");
      g.sink.voiceSteal(1, 2, "priority");
      g.sink.voiceRefused("hop.ogg", "Sfx", "busFull");
      g.sink.eventStart(3, "footsteps");
      g.sink.parameter("Speed", 0.5, 3);
      g.sink.snapshot("Underwater", 1);
      g.sink.stateChange("Surface", "Water");
      g.sink.musicTransition(1, "Intro", "Loop");
      g.sink.busRamp("Sfx", "runtime", 480, 0.5);
      g.sink.loudnessControl("pause", "Sfx");
      g.sink.masterChange(0.5, false);
      g.sink.ladder(1, true);
      g.sink.hiddenTab(false);
      g.sink.monitor(1);
    };
    play();
    const namesAfterPrime = encodeNames.mock.calls.length;
    const primeCalls = encodeEvent.mock.calls.length;
    for (let i = 0; i < 100; i++) play();
    expect(encodeNames.mock.calls.length).toBe(namesAfterPrime);
    const calls = encodeEvent.mock.calls.slice(primeCalls);
    expect(calls).toHaveLength(1500);
    const payloads = new Set<EventPayload>(calls.map((c) => c[2]));
    expect(payloads.size).toBe(1);
    // At most one args array per length (0..5), whatever the number of events.
    const argArrays = new Set<readonly number[]>(calls.map((c) => c[2].args));
    expect(argArrays.size).toBeLessThanOrEqual(6);
    for (const a of argArrays) expect(a.length).toBeLessThanOrEqual(5);
  });

  it("the sink writes into the ring in place: its own view, no copy of the event leaves the sink", () => {
    const g = rig();
    g.feed(768);
    encodeEvent.mockClear();
    g.sink.monitor(1);
    expect(encodeEvent).toHaveBeenCalledTimes(1);
    expect(encodeEvent.mock.calls[0]![0]).toBe(g.r.ring.view);
  });

  it("the ring holds the events: 100 repeat plays grow it by exactly the bytes of their records", () => {
    const g = rig();
    g.feed(768);
    g.sink.voiceStart(1, "hop.ogg", "Sfx", 0, 0, 1);
    const before = g.r.ring.usedBytes;
    for (let i = 0; i < 100; i++) g.sink.voiceStart(1, "hop.ogg", "Sfx", 0, 0, 1);
    const perEvent = 20 + 12 + 4 * 5 + 4;
    expect(g.r.ring.usedBytes - before).toBe(100 * perEvent);
  });
});

describe("EventSink: ring pressure", () => {
  it("an event the ring refuses is counted, never thrown", () => {
    const g = rig();
    g.feed(768);
    const before = g.sink.eventsDropped;
    const spy = vi.spyOn(g.r, "record").mockReturnValue(-1);
    g.sink.voiceStop(1, "ended");
    g.sink.voiceStart(1, "a", "b", 0, 0, 1);
    spy.mockRestore();
    expect(g.sink.eventsDropped).toBe(before + 2);
    expect(g.sink.namesWritten).toBe(0);
  });
});
