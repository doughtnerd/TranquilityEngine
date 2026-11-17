// Ld2 (ADR 0171 amended by 0172, M5; api-and-models §3.2, §4.2; the stubs file's Ld2 row): the core backend wires the
// page's loudness hub: `configure` and `LOUD_CONFIG` at configure, on a settings edit and in a rebuild's replay; `feed`
// in the STATUS handler; `epoch` on an EPOCH; `play` at each Engine's audio configure; `attach` once; the gate sink.
// The recording host (`recordingAudio`, ADR 0234): the production assembly, a fake clip registry, no wasm.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAudioSettings, type AudioSettings, type LoudnessTarget } from "../../../../engine/audio/settings";
import { notifyAudioConfigured } from "../../../../engine/core/audioConfigure";
import { LOUD_OUTPUT_TAP, Op, readLoudConfig, readRecordHead, type LoudConfig, type StatusLoudBusesItem } from "../wire.generated";
import { closeRecordingAudio, recordingAudio } from "../testing";
import type { ReplayBuilder } from "./replay";
import { loudnessHub, setLoudnessTarget } from "../mix/loudnessHub";

/** Master, Music, SFX, UI, Voice (the defaults, slots 0-4) with `meter: "loudness"` on the names given. */
function settings(metered: string[], extra: Partial<AudioSettings> = {}): AudioSettings {
  const s = defaultAudioSettings();
  return { ...s, buses: s.buses.map((b) => (metered.includes(b.name) ? { ...b, meter: "loudness" as const } : b)), ...extra };
}

afterEach(closeRecordingAudio);

/** The core backend on the recording host (ADR 0234), over its own mixer. */
function rig(start: AudioSettings) {
  const r = recordingAudio({ mixer: "own", settings: start, preset: { maxLogical: 16 } });
  /** LOUD_CONFIG records posted since the last call, in order (other records' opcodes in `ops`). */
  const posted = () => {
    const records = r.posted.takeRecords();
    return { ops: records.map((x) => x.opcode), loud: records.filter((x) => x.opcode === Op.LOUD_CONFIG).map((x) => readLoudConfig(x.view, x.off)) };
  };
  const status = (loudBuses: StatusLoudBusesItem[], loudEnergies: number[]) => r.status({ loudBuses, loudEnergies });
  return { backend: r.backend, mixer: r.mixer, host: r.host, posted, frame: () => r.frame(), status, rebuild: () => r.rebuild("trap") };
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
    // Another Engine's tree (UI renamed): the mixer takes it, then the host remaps, as `Engine.create` does.
    const next = settings(["Voice"]);
    next.buses = next.buses.map((b) => (b.name === "UI" ? { ...b, name: "Menu" } : b));
    r.mixer.configure(next);
    r.host.reconfigure(next);
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

  it("an EPOCH (the rebuild's new core answered) reseeds the feeds and marks them incomplete", async () => {
    const r = rig(settings([]));
    r.frame();
    const e = 10 ** ((-20 + 0.691) / 10);
    r.status([item(LOUD_OUTPUT_TAP, 0, 4)], [e, e, e, e]);
    r.mixer.bus("Master").loudness.reset("all");
    expect(r.mixer.bus("Master").loudness.incomplete).toBe(false);
    expect(await r.rebuild()).toBe("rebuilt");
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
    // ADR 0178: the session's header phase (RESET, BUS_CONFIG, then these, then the lanes up to MASTER).
    r.backend.session.replayHeader(builder);
    expect(ops.slice(0, 2)).toEqual([Op.RESET, Op.BUS_CONFIG]);
    const lanes = ops.slice(2, ops.indexOf(Op.MASTER));
    expect(lanes.slice(0, 3)).toEqual([Op.BUS_DUCK, Op.BUS_PRESENCE, Op.LOUD_CONFIG]);
    expect(lanes.slice(3).length).toBeGreaterThan(0);
    expect(lanes.slice(3).every((o) => o === Op.BUS_RAMP)).toBe(true);
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
