// UI pass wave 3 (Sequence view): the models behind the readout, the overlays over the tracks (loop names, crossfade
// zones, the Async voice cursor), the Amp envelope's handles, the spectrogram's bands, the Parameters panel's uses and
// the Snap split button, through each module's own interface.
import { describe, expect, it } from "vitest";
import { adsrHandleSpots, adsrShape, adsrTip, clipAdsr, dragAdsr, ADSR_HANDLE_GAP } from "./adsrModel";
import { clipPlan, drawnLoopBand } from "./clipGeometry";
import { pasteCurves, setDrivenBy } from "./automationEdits";
import { moveEffectToTrack, sharedClipEffect } from "./sequenceEdits";
import { sequenceReadout } from "./readoutModel";
import { fixtureSequence, fixtureSource } from "./sequenceFixture";
import { keepTaps, snapLabel, snapPresets, tapTempo, toggleSnap, DEFAULT_SNAP } from "./sequenceGrid";
import { findClip } from "./sequenceModel";
import { parameterUses, useChip } from "./parameterUses";
import { spectrogramBands } from "./spectrogramModel";
import { activeText, crossfadeZones, loopName, voicePosition } from "./timelineOverlays";

const seq = fixtureSequence();
const c = (id: string) => findClip(seq, id)!.clip;
const idle = { playing: false, released: false, writing: false, values: {} };

describe("the readout", () => {
  it("parks at a held hold point and reads each track's clip: loop pass with its condition, pickup, the tail", () => {
    const r = sequenceReadout(seq, fixtureSource, 1.6, 6, "oneShot", { ...idle, playing: true, values: { brake: 0.6 } });
    expect(r.run).toBe("Holding at Hold 1");
    expect(r.tracks).toEqual([
      { name: "Skid", state: "loop pass 3 · brake > 0.10 ✓", tone: "text" },
      { name: "Music", state: "loop pass 1", tone: "text" },
    ]);
    expect(sequenceReadout(seq, fixtureSource, 0.2, 6, "oneShot", idle).tracks[0]).toEqual({ name: "Skid", state: "pickup", tone: "text" });
    expect(sequenceReadout(seq, fixtureSource, 2.2, 6, "oneShot", idle).tracks[0]).toEqual({ name: "Skid", state: "tail", tone: "text" });
    // The condition fails: the loop leaves.
    expect(sequenceReadout(seq, fixtureSource, 1.0, 6, "oneShot", { ...idle, values: { brake: 0 } }).tracks[0]).toEqual({ name: "Skid", state: "loop pass 2 · brake > 0.10 ✗ → leaves", tone: "warning" });
  });

  it("says past the end, a released hold, disabled clips and tracks, and finished tracks", () => {
    const playing = { ...idle, playing: true };
    expect(sequenceReadout(seq, fixtureSource, 6, 6, "oneShot", playing).run).toBe("Sequence end · voices still playing");
    expect(sequenceReadout(seq, fixtureSource, 6, 6, "untilStopped", playing).run).toBe("Sequence end · until stopped");
    expect(sequenceReadout(seq, fixtureSource, 1.6, 6, "oneShot", { ...playing, released: true }).run).toBeNull();
    const off = { ...seq, tracks: [{ ...seq.tracks[0]!, enabled: false }, { ...seq.tracks[1]!, clips: [{ ...c("c2"), enabled: false }] }] };
    expect(sequenceReadout(off, fixtureSource, 1, 6, "oneShot", idle).tracks.map((t) => t.state)).toEqual(["track disabled", "clip disabled"]);
    expect(sequenceReadout(seq, fixtureSource, 5, 6, "oneShot", playing).tracks.find((t) => t.name === "Skid")).toEqual({ name: "Skid", state: "ended", tone: "muted" });
    expect(sequenceReadout(seq, fixtureSource, 1, 6, "oneShot", { ...playing, writing: true }).writing).toBe(true);
  });
});

describe("overlays", () => {
  it("names loops and hold points in time order, each kind on its own", () => {
    const s = { loops: [{ ...seq.loops[0]!, id: "a", start: 3, end: 4 }, { ...seq.loops[0]!, id: "h" }, { ...seq.loops[0]!, id: "b", start: 1, end: 2 }] };
    expect(["b", "a", "h"].map((id) => loopName(s, id))).toEqual(["Loop 1", "Loop 2", "Hold 1"]);
    expect(activeText({ active: "parameter", binding: { parameter: "rpm", op: ">", value: 4000 } })).toBe("Parameter (rpm > 4000)");
  });

  it("finds where clips on one track overlap (the crossfade), skipping disabled clips", () => {
    const t = { clips: [{ ...c("c2"), id: "x", at: 0, length: 2 }, { ...c("c2"), id: "y", at: 1.5, length: 2 }, { ...c("c2"), id: "z", at: 3, length: 1, enabled: false }] };
    expect(crossfadeZones(t, fixtureSource)).toEqual([{ from: 1.5, to: 2, a: "x", b: "y" }]);
    expect(crossfadeZones(seq.tracks[1]!, fixtureSource)).toEqual([]);
  });

  it("places an Async voice on its own clock, cycling its last pass while the loop stays active", () => {
    const music = { ...c("c2"), sync: false };
    expect(voicePosition(music, fixtureSource(music), 2, true)).toBe(2);
    expect(voicePosition(music, fixtureSource(music), 3.5, true)).toBeCloseTo(1.5);
    expect(voicePosition(music, fixtureSource(music), 3.5, false)).toBe(3.5);
    expect(voicePosition(music, fixtureSource(music), 4.2, false)).toBeNull();
  });

  it("ADR 0362: places a reversed Async voice from the clip's start through the mirrored tail, cycling the pass after it", () => {
    // brake_skid: a 3 s clip, its loop 0.4–0.9 s filling 0.4–1.9 (passes of 0.5 s), the tail 1.9–3; reversed, the tail
    // is drawn over 0–1.1 and the band over 1.1–2.6, the voice reading down from the sample's end.
    const skid = { ...c("c1"), sync: false, reverse: true };
    const src = fixtureSource(skid);
    expect(drawnLoopBand(clipPlan(skid, src), true)).toMatchObject({ start: 1.1, end: 2.6 });
    // Through the tail (drawn first), the voice is where the playhead is.
    expect(voicePosition(skid, src, 0.25, true)).toBe(0.25);
    // Past the first pass after the tail (1.1–1.6), it cycles that pass while the loop is active.
    expect(voicePosition(skid, src, 1.7, true)).toBeCloseTo(1.2);
    expect(voicePosition(skid, src, 1.7, false)).toBeCloseTo(1.7);
    expect(voicePosition(skid, src, 3.1, false)).toBeNull();
  });
});

describe("the Amp envelope's handles", () => {
  it("draws attack, decay to sustain and the release at the clip's end, and drags each stage", () => {
    const a = { attack: 100, hold: 0, decay: 200, sustain: 50, release: 300 };
    expect(adsrShape(a, 2).handles).toEqual({ attack: [0.1, 1], hold: [0.1, 1], decaySustain: [0.30000000000000004, 0.5], release: [1.7, 0.5] });
    expect(dragAdsr(a, "release", 1.5, 0.5, 2)).toEqual({ release: 500 });
    expect(dragAdsr(a, "decaySustain", 0.5, 0.8, 2)).toEqual({ decay: 400, sustain: 80 });
    expect(dragAdsr(a, "attack", 0.05, 1, 2)).toEqual({ attack: 50 });
    expect(adsrTip(a, "decaySustain")).toBe("Decay 200 ms · Sustain 50% · drag");
    expect(clipAdsr([{ id: "e", type: "envelope", on: true, params: { attack: 5 } }])?.adsr).toEqual({ attack: 5, hold: 0, decay: 100, sustain: 100, release: 200 });
    expect(clipAdsr([])).toBeNull();
  });

  it("ADR 0362: draws the hold as a plateau with its own handle, and drags it between the attack and the decay", () => {
    const a = { attack: 100, hold: 150, decay: 200, sustain: 50, release: 300 };
    const shape = adsrShape(a, 2);
    expect(shape.points.slice(0, 3)).toEqual([[0, 0], [0.1, 1], [0.25, 1]]);
    expect(shape.handles.hold).toEqual([0.25, 1]);
    expect(shape.handles.decaySustain[0]).toBeCloseTo(0.45);
    expect(dragAdsr(a, "hold", 0.6, 1, 2)).toEqual({ hold: 500 });
    expect(dragAdsr(a, "hold", 5, 1, 2)).toEqual({ hold: 1400 }); // never past the decay and release
    expect(dragAdsr(a, "decaySustain", 0.75, 0.5, 2)).toEqual({ decay: 500, sustain: 50 });
    expect(adsrTip(a, "hold")).toBe("Hold 150 ms · drag");
  });

  it("draws the Hold handle clear of Attack's at Hold 0, and on the plateau's end once the hold is wider than the gap", () => {
    const a = { attack: 100, hold: 0, decay: 200, sustain: 50, release: 300 };
    const spots = adsrHandleSpots(a, 2, 200); // 100 px a second
    expect(spots.attack).toEqual([10, 1]);
    expect(spots.hold).toEqual([10 + ADSR_HANDLE_GAP, 1]);
    expect(spots.release).toEqual([170, 0.5]);
    expect(adsrHandleSpots({ ...a, hold: 150 }, 2, 200).hold).toEqual([25, 1]);
    // The effect's defaults: a 5 ms attack, Hold 0, a 100 ms decay to a full sustain: three corners within a few px.
    const d = adsrHandleSpots({ attack: 5, hold: 0, decay: 100, sustain: 100, release: 200 }, 6, 600);
    expect(d.hold[0] - d.attack[0]).toBe(ADSR_HANDLE_GAP);
    expect(d.decaySustain[0] - d.hold[0]).toBeGreaterThanOrEqual(ADSR_HANDLE_GAP);
    // Release stays inside the clip, even when the stages crowd its end.
    expect(adsrHandleSpots({ attack: 5, hold: 0, decay: 100, sustain: 100, release: 0 }, 0.1, 12).release[0]).toBeLessThanOrEqual(12);
  });

  it("ADR 0362: a clip shorter than the stages squeezes them as the voices play them (the release first)", () => {
    const a = { attack: 100, hold: 20, decay: 100, sustain: 50, release: 200 };
    const shape = adsrShape(a, 0.25);
    expect(shape.handles.release[0]).toBeCloseTo(0.22); // a 30 ms release, ending on the clip's end
    expect(shape.points.at(-1)).toEqual([0.25, 0]);
  });
});

describe("the spectrogram", () => {
  it("puts a 1.5 kHz tone in the 1–2 kHz band", () => {
    const rate = 48000;
    const pcm = new Float32Array(rate);
    for (let i = 0; i < rate; i++) pcm[i] = Math.sin((2 * Math.PI * 1500 * i) / rate);
    const bands = spectrogramBands({ pcm, channels: 1, rate }, 0, 1, 4);
    expect(bands.length).toBe(24);
    expect(bands[3]!).toBeGreaterThan(0.9);
    expect(bands[0]!).toBeLessThan(0.3);
  });
});

describe("the Parameters panel's uses", () => {
  it("lists the parameters the sequence uses, each with where", () => {
    expect([...parameterUses(seq, fixtureSource)]).toEqual([["brake", ["Skid · brake_skid"]]]);
    expect(useChip(["Skid · brake_skid", "Loop 2"])).toEqual({ text: "2 uses", title: "Used by Skid · brake_skid, Loop 2", used: true });
    expect(useChip(undefined).text).toBe("unused");
  });
});

describe("curves and effects from the Inspector", () => {
  it("pastes copied curves onto another owner, reading its own time; skips targets it can't automate", () => {
    const lane = c("c1").automation[0]!;
    const r = pasteCurves(seq, { clip: "c2" }, [lane, { ...lane, id: "x", target: "fx:fx1:cutoff" }]);
    expect("next" in r && findClip(r.next, "c2")!.clip.automation.map((a) => [a.target, a.input, a.curve.length])).toEqual([["volume", "clipTime", 4]]);
    expect("refused" in pasteCurves(seq, { clip: "c2" }, [{ ...lane, target: "fx:fx1:cutoff" }])).toBe(true);
  });

  it("reseeds a lane flat over its new axis when what drives it changes", () => {
    const r = setDrivenBy(seq, { track: "t1" }, "a1", { parameter: "brake" }, 0, 1);
    expect("next" in r && r.next.tracks[0]!.automation[0]).toMatchObject({ input: { parameter: "brake" }, curve: [[0, 0], [1, 0]] });
    const back = setDrivenBy(seq, { track: "t1" }, "a1", "voiceTime", 0, 6);
    expect("next" in back && back.next.tracks[0]!.automation[0]!.input).toBe("sequenceTime");
  });

  it("finds the effect every clip on a track has and moves it to the track, with its curves", () => {
    const fx = { id: "fx1", type: "lowpass" as const, on: true, params: { cutoff: 900 } };
    const t = { ...seq.tracks[1]!, clips: [{ ...c("c2"), effects: [fx], automation: [{ id: "a", target: "fx:fx1:cutoff" as const, input: "clipTime" as const, curve: [[0, 1]] as [number, number][], bypass: false }] }, { ...c("c2"), id: "c9", effects: [{ ...fx, params: { cutoff: 300 } }] }] };
    expect(sharedClipEffect(t)).toBe("lowpass");
    expect(sharedClipEffect({ ...t, clips: [t.clips[0]!, { ...c("c2"), id: "c8" }] })).toBeNull();
    const s2 = { ...seq, tracks: [seq.tracks[0]!, t] };
    const r = moveEffectToTrack(s2, "t2", "lowpass");
    if (!("next" in r)) throw new Error(r.refused);
    const moved = r.next.tracks[1]!;
    expect(moved.effects.map((e) => [e.type, e.params.cutoff])).toEqual([["lowpass", 900]]);
    expect(moved.clips.every((x) => x.effects.length === 0 && x.automation.length === 0)).toBe(true);
  });
});

describe("the Snap split button and tap tempo", () => {
  it("offers the display's presets, reads its step, and toggles back to it", () => {
    expect(snapPresets("timecode").map((p) => p.label)).toEqual(["10 ms", "100 ms", "1 s"]);
    expect(snapPresets("samples").map((p) => p.label)).toEqual(["100 smp", "1,000 smp", "10,000 smp"]);
    expect(snapLabel({ ...DEFAULT_SNAP, mode: "custom", custom: 0.25 }, "timecode", null)).toBe("250 ms");
    const off = toggleSnap({ ...DEFAULT_SNAP, mode: "100ms" }, "timecode");
    expect(off.mode).toBe("off");
    expect(snapLabel(off, "timecode", null)).toBe("100 ms");
    expect(toggleSnap(off, "timecode").mode).toBe("100ms");
    expect(toggleSnap({ ...DEFAULT_SNAP, mode: "off" }, "bars").mode).toBe("beat");
  });

  it("starts a new tap count after a pause over 2.5 s", () => {
    expect(tapTempo([0, 2200])).toBeCloseTo(27.3, 1);
    expect(keepTaps([0], 2200)).toEqual([0, 2200]);
    expect(keepTaps([0], 2600)).toEqual([2600]);
  });
});
