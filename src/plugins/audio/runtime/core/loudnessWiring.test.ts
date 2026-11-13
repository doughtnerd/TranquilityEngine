// Ld2 (ADR 0171 amended by 0172, M5; api-and-models §3.2, §4.2; the stubs file's Ld2 row): the core backend wires the
// page's loudness hub: `configure` and `LOUD_CONFIG` at configure, on a settings edit and in a rebuild's replay; `feed`
// in the STATUS handler; `epoch` on an EPOCH; `play` at each Engine's audio configure; `attach` once; the gate sink.
// A real `CoreLink` on a recording port, a fake clip registry, no wasm.
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings, type LoudnessTarget } from "../../../../engine/audio/settings";
import { notifyAudioConfigured } from "../../../../engine/core/audioConfigure";
import { Kind, LOUD_OUTPUT_TAP, Op, readBatchHeader, readEnvelope, readLoudConfig, readRecordHead, STATUS_BUFFER_BYTES, writeStatus, type LoudConfig, type StatusLoudBusesItem } from "../wire.generated";
import type { AudioHost, HostLifecycleListener } from "./context";
import { CoreLink, type LinkPort } from "./context";
import type { ClipInfo, ClipRegistry, ClipState } from "./clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { makeStatusBlock } from "./mirror";
import type { ReplayBuilder } from "./replay";
import { loudnessHub, setLoudnessTarget } from "../mix/loudnessHub";

function fakeClips(): ClipRegistry {
  const states = new Map<number, ClipState>();
  return {
    acquire: () => 1,
    release: () => {},
    state: (id: number) => states.get(id) ?? "ready",
    info: (id: number): ClipInfo => ({ id, path: "", state: "ready", refs: 0, frames: 0, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null }),
    onResident: () => () => {},
    releaseWorld: () => {},
    applyClipEvent: () => {},
    residentIds: () => [],
    acquireReserved: () => {},
  } as unknown as ClipRegistry;
}

function fakeClock() {
  let raf = 1000;
  let ctx = 0;
  let date = 1_000_000;
  return {
    rafTime: () => raf,
    outputTimestamp: () => ({ contextTime: ctx, performanceTime: raf }),
    currentTime: () => ctx,
    dateNow: () => date,
    fake: true as const,
    advance(ms: number) {
      raf += ms;
      date += ms;
      ctx += ms / 1000;
    },
  };
}

/** Master, Music, SFX, UI, Voice (the defaults, slots 0-4) with `meter: "loudness"` on the names given. */
function settings(metered: string[], extra: Partial<AudioSettings> = {}): AudioSettings {
  const s = defaultAudioSettings();
  return { ...s, buses: s.buses.map((b) => (metered.includes(b.name) ? { ...b, meter: "loudness" as const } : b)), ...extra };
}

const backends: CoreBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});

function rig(start: AudioSettings) {
  const sent: ArrayBuffer[] = [];
  const port: LinkPort = { onmessage: null, postMessage: (m) => sent.push(m as ArrayBuffer) };
  const link = new CoreLink(port);
  const listeners: HostLifecycleListener[] = [];
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => {
      listeners.push(l);
      return () => void listeners.splice(listeners.indexOf(l), 1);
    }) as AudioHost["addLifecycleListener"],
  };
  const clock = fakeClock();
  const mixer = new Mixer(start);
  const backend = new CoreBackend(host, { clips: fakeClips(), clock, mixer });
  backends.push(backend);
  /** LOUD_CONFIG records posted since the last call, in order (other records' opcodes in `ops`). */
  const posted = () => {
    const ops: number[] = [];
    const loud: LoudConfig[] = [];
    for (const m of sent.splice(0)) {
      const view = new DataView(m);
      if (readEnvelope(view, 0).kind !== Kind.BATCH) continue;
      const header = readBatchHeader(view, 0);
      let off = 32;
      for (let i = 0; i < header.count; i++) {
        const head = readRecordHead(view, off);
        ops.push(head.opcode);
        if (head.opcode === Op.LOUD_CONFIG) loud.push(readLoudConfig(view, off));
        off += head.words * 4;
      }
    }
    return { ops, loud };
  };
  const frame = () => {
    clock.advance(16);
    backend.update(0.016);
  };
  const status = (loudBuses: StatusLoudBusesItem[], loudEnergies: number[]) => {
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
    writeStatus(new DataView(buffer), 0, makeStatusBlock({ loudBuses, loudEnergies }), 1);
    link.handleMessage(buffer);
  };
  return { backend, mixer, listeners, posted, frame, status };
}

const slots = (c: LoudConfig) => c.meters.map((m) => m.slot);
/** Four sub-blocks of `e` for `slot` from `firstSeq`. */
const item = (slot: number, firstSeq: number, n: number, flags = 0): StatusLoudBusesItem => ({ slot, flags: n | flags, firstSeq, truePeak: 0.5, gatedQuanta: 0 });

describe("the loudness hub's wiring in the core backend (Ld2)", () => {
  it("configure sends LOUD_CONFIG after BUS_CONFIG: the metered slots (master implicit) and the target's ceiling - 6 dB", () => {
    const r = rig(settings(["SFX", "Voice"]));
    r.frame();
    const { ops, loud } = r.posted();
    expect(loud).toHaveLength(1);
    expect(ops.indexOf(Op.LOUD_CONFIG)).toBeGreaterThan(ops.indexOf(Op.BUS_CONFIG));
    expect(slots(loud[0]!)).toEqual([2, 4]);
    expect(loud[0]!.tpGateDbfs).toBe(-7); // the default target's -1 dBTP
    expect(r.mixer.bus("Master").loudness.metered).toBe(true);
    expect(r.mixer.bus("Voice").loudness.metered).toBe(true);
    expect(r.mixer.bus("Music").loudness.metered).toBe(false);
  });

  it("with no bus metered, LOUD_CONFIG still goes (it starts master's meter in the core)", () => {
    const r = rig(settings([]));
    r.frame();
    const { loud } = r.posted();
    expect(loud.map(slots)).toEqual([[]]);
  });

  it("a settings edit of the metered set sends LOUD_CONFIG once; one that leaves the set and the gate alone sends none", () => {
    const r = rig(settings(["SFX"]));
    r.frame();
    r.posted();
    r.mixer.configure(settings(["SFX", "UI"]));
    r.mixer.update(0.016); // the change notification
    r.frame();
    expect(r.posted().loud.map(slots)).toEqual([[2, 3]]);
    r.mixer.configure(settings(["SFX", "UI"], { loudnessResetOnPlay: false }));
    r.mixer.update(0.016);
    r.frame();
    expect(r.posted().loud).toHaveLength(0);
  });

  it("a bus remap restarts the bus meters (an empty LOUD_CONFIG, then the full one)", () => {
    const r = rig(settings(["Voice"]));
    r.frame();
    r.posted();
    for (const l of r.listeners) l.onBusRemap?.({ epoch: 2, from: [], to: [], map: new Int32Array(0) } as never);
    r.frame();
    expect(r.posted().loud.map(slots)).toEqual([[], [4]]);
  });

  it("a target change re-sends the gate (not a reset); an unchanged target sends nothing", () => {
    const targets: LoudnessTarget[] = [
      { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
      { name: "strict", integrated: -24, tolerance: 2, truePeak: -3 },
    ];
    const r = rig(settings(["Voice"], { loudnessTargets: targets }));
    r.frame();
    r.posted();
    setLoudnessTarget("strict");
    r.frame();
    const { loud } = r.posted();
    expect(loud.map((c) => [c.tpGateDbfs, slots(c)])).toEqual([[-9, [4]]]);
    setLoudnessTarget("strict");
    r.frame();
    expect(r.posted().loud).toHaveLength(0);
    setLoudnessTarget(null);
  });

  it("STATUS feeds the hub: master reads the final output's sub-blocks", () => {
    const r = rig(settings(["Voice"]));
    r.frame();
    const e = 10 ** ((-20 + 0.691) / 10); // -20 LUFS
    r.status([item(LOUD_OUTPUT_TAP, 0, 4), item(4, 0, 0)], [e, e, e, e]);
    expect(r.mixer.bus("Master").loudness.momentary).toBeCloseTo(-20, 3);
    expect(r.mixer.bus("Voice").loudness.momentary).toBe(Number.NEGATIVE_INFINITY);
  });

  it("an EPOCH (the rebuild's new core answered) reseeds the feeds and marks them incomplete", () => {
    const r = rig(settings([]));
    r.frame();
    const e = 10 ** ((-20 + 0.691) / 10);
    r.status([item(LOUD_OUTPUT_TAP, 0, 4)], [e, e, e, e]);
    r.mixer.bus("Master").loudness.reset("all");
    expect(r.mixer.bus("Master").loudness.incomplete).toBe(false);
    for (const l of r.listeners) l.onRebuildStart?.("trap");
    for (const l of r.listeners) l.onRebuilt?.();
    expect(r.mixer.bus("Master").loudness.incomplete).toBe(true);
  });

  it("the rebuild's replay carries LOUD_CONFIG after BUS_DUCK and BUS_PRESENCE, before the lanes", () => {
    const r = rig(settings(["SFX", "Voice"]));
    const ops: number[] = [];
    const loud: LoudConfig[] = [];
    const builder = {
      record(bytes: number, write: (view: DataView, off: number) => number) {
        const view = new DataView(new ArrayBuffer(bytes));
        write(view, 0);
        const op = readRecordHead(view, 0).opcode;
        ops.push(op);
        if (op === Op.LOUD_CONFIG) loud.push(readLoudConfig(view, 0));
      },
    } as unknown as ReplayBuilder;
    r.backend.lanes.replayLanes(builder);
    expect(ops.slice(0, 3)).toEqual([Op.BUS_DUCK, Op.BUS_PRESENCE, Op.LOUD_CONFIG]);
    expect(ops.slice(3).every((o) => o === Op.BUS_RAMP)).toBe(true);
    expect(loud.map((c) => [c.tpGateDbfs, slots(c)])).toEqual([[-7, [2, 4]]]);
  });

  for (const resetOnPlay of [true, false]) {
    it(`each Engine's audio configure is a Play: loudnessResetOnPlay ${resetOnPlay} ${resetOnPlay ? "resets" : "keeps"} the meters`, () => {
      const r = rig(settings([], { loudnessResetOnPlay: resetOnPlay }));
      r.frame();
      const e = 10 ** ((-20 + 0.691) / 10);
      r.status([item(LOUD_OUTPUT_TAP, 0, 4)], [e, e, e, e]);
      expect(r.mixer.bus("Master").loudness.momentary).toBeCloseTo(-20, 3);
      notifyAudioConfigured(r.mixer.audioSettings);
      const m = r.mixer.bus("Master").loudness.momentary;
      if (resetOnPlay) expect(m).toBe(Number.NEGATIVE_INFINITY);
      else expect(m).toBeCloseTo(-20, 3);
    });
  }

  it("dispose detaches the hub from the mixer and the gate sink", () => {
    const r = rig(settings(["Voice"]));
    r.frame();
    expect(r.mixer.bus("Voice").loudness.metered).toBe(true);
    r.backend.dispose();
    expect(r.mixer.bus("Voice").loudness.metered).toBe(false);
    r.posted();
    setLoudnessTarget(null);
    expect(r.posted().loud).toHaveLength(0);
    expect(loudnessHub.busLoudness("Voice")).not.toBeNull(); // the page's hub keeps its configuration
  });
});
