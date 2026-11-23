import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { setEffectOn, setEffectParam, removeEffect } from "../../components/effectChainModel";
import { editSendLevel } from "../../components/mixRowsModel";
import { automatedParams, gainInputs, levelAutomationDb, livePins, loudnessRows, snapshotLane, targetOptionText, togglePin } from "./boardModel";
import type { EditResult } from "./busTree";
import { createLiveMix, liveOps } from "./liveMix";
import { addDucking, addSend, baseGhost, clearOffset, clearOverride, doubleDucks, editEffects, editSend, levelGhosts, levelLabel, overridesOn, removeSend, setAutomation, setLevel, setMute, setTrigger, shownEffects, shownLevel } from "./mixEdits";
import { emptyMix, mixerFixture } from "./mixerFixture";
import { busRenameEdit, busUsers, renameBusInPlaylist, renameBusInScene } from "./renameReferences";
import { gainBreakdown } from "../../components/gainLanesModel";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");
const valid = (p: AudioProject) => {
  const back = parseAudioProject(audioProjectToJson(p));
  expect(back.problems).toEqual([]);
  expect(back.project).toEqual(p);
};
const bus = (p: AudioProject, n: string) => p.buses.find((b) => b.name === n)!;

describe("levels and snapshots", () => {
  it("draws the VCA tick and, while a snapshot is edited, the base-level tick together (D19)", () => {
    const p = mixerFixture();
    expect(levelGhosts(p, "Music", null)).toEqual([]);
    expect(levelGhosts(p, "Music", "Underwater")).toEqual([{ kind: "base", db: -10, title: "Base level: -10.0 dB" }]);
    const withVca = { ...p, vcas: p.vcas.map((v) => (v.name === "Gameplay SFX" ? { ...v, volumeDb: -4 } : v)) };
    expect(levelGhosts(withVca, "Footsteps", null)).toEqual([{ kind: "vca", db: -10, title: "With VCAs: -10.0 dB" }]);
    // Footsteps in Underwater: base −6, offset −12, shown −18; the VCA tick sits 4 dB under what the fader shows.
    expect(levelGhosts(withVca, "Footsteps", "Underwater")).toEqual([
      { kind: "vca", db: -22, title: "With VCAs: -22.0 dB" },
      { kind: "base", db: -6, title: "Base level: -6.0 dB" },
    ]);
    expect(levelGhosts(withVca, "Gameplay SFX", "Underwater")).toEqual([]);
  });
  it("a fader in the base mix (or a base-start snapshot) edits the base level", () => {
    const p = mixerFixture();
    expect(bus(ok(setLevel(p, "Music", -4, null)), "Music").volumeDb).toBe(-4);
    expect(bus(ok(setLevel(p, "Music", -4, "Gameplay")), "Music").volumeDb).toBe(-4);
    expect(levelLabel(p, "Music", null)).toBe("Set level · Music");
    expect(baseGhost(p, "Music", null)).toBeNull();
  });
  it("a fader in a snapshot edits that snapshot's offset, never the base (the prototype's double count fixed)", () => {
    const p = mixerFixture();
    expect(shownLevel(p, "Music", "Underwater")).toBe(-16);
    expect(baseGhost(p, "Music", "Underwater")).toBe(-10);
    const next = ok(setLevel(p, "Music", -12, "Underwater"));
    expect(bus(next, "Music").volumeDb).toBe(-10);
    expect(next.snapshots.find((s) => s.name === "Underwater")!.buses.Music).toBe(-2);
    expect(shownLevel(next, "Music", "Underwater")).toBe(-12);
    expect(levelLabel(p, "Music", "Underwater")).toBe("Snapshot level · Music");
    const ui = ok(setLevel(p, "UI", -20, "Underwater"));
    expect(ui.snapshots.find((s) => s.name === "Underwater")!.buses.UI).toBe(-12);
    expect(ok(clearOffset(next, "Underwater", "Music")).snapshots.find((s) => s.name === "Underwater")!.buses).not.toHaveProperty("Music");
    valid(next);
  });
  it("VCAs and returns have levels; mute works on buses and returns", () => {
    const p = mixerFixture();
    expect(ok(setLevel(p, "Gameplay SFX", -6, "Underwater")).vcas[0]!.volumeDb).toBe(-6);
    expect(levelLabel(p, "Gameplay SFX", null)).toBe("VCA level · Gameplay SFX");
    expect(ok(setLevel(p, "Reverb", -9, null)).returns[0]!.volumeDb).toBe(-9);
    expect(bus(ok(setMute(p, "Music", true)), "Music").mute).toBe(true);
    expect(ok(setMute(p, "Reverb", true)).returns[0]!.mute).toBe(true);
    expect(refused(setMute(p, "Gameplay SFX", true))).toMatch(/mute/);
  });
});

describe("effects and snapshot overrides", () => {
  it("in a snapshot, a parameter change writes the snapshot's override; Clear override removes it", () => {
    const p = mixerFixture();
    const shown = shownEffects(p, "Ambience", "Underwater");
    expect(shown[0]!.params.cutoff).toBe(800);
    const next = ok(editEffects(p, "Ambience", setEffectParam(shown, "fx1", "cutoff", 500), "Underwater"));
    expect(bus(next, "Ambience").effects).toEqual(bus(p, "Ambience").effects);
    expect(overridesOn(next, "Underwater", "Ambience")).toEqual([{ id: "fx1", param: "cutoff", value: 500 }]);
    const res = ok(editEffects(p, "Ambience", setEffectParam(shownEffects(p, "Ambience", "Pause menu"), "fx1", "resonance", 0.5), "Pause menu"));
    expect(overridesOn(res, "Pause menu", "Ambience")).toEqual([{ id: "fx1", param: "resonance", value: 0.5 }]);
    expect(ok(clearOverride(next, "Underwater", "Ambience", "fx1", "cutoff")).snapshots.find((s) => s.name === "Underwater")!.effects).toEqual({});
    valid(next);
  });
  it("in a snapshot, a structural change edits the base chain and keeps base values under overrides", () => {
    const p = mixerFixture();
    const next = ok(editEffects(p, "Ambience", setEffectOn(shownEffects(p, "Ambience", "Underwater"), "fx1", false), "Underwater"));
    expect(bus(next, "Ambience").effects[0]).toMatchObject({ on: false });
    expect(bus(next, "Ambience").effects[0]!.params.cutoff).toBe(bus(p, "Ambience").effects[0]!.params.cutoff);
  });
  it("removing an effect removes its automation and every snapshot override of it in the same edit", () => {
    const p = mixerFixture();
    const next = ok(editEffects(p, "Ambience", removeEffect(bus(p, "Ambience").effects, "fx1"), null));
    expect(next.automation.map((a) => `${a.on}:${a.target}`)).toEqual(["Music:volume", "Ambience:volume"]);
    expect(next.snapshots.find((s) => s.name === "Underwater")!.effects).toEqual({});
    valid(next);
  });
});

describe("sends, ducking, automation, triggers", () => {
  it("sends: add (not from Master, one per return), edit, remove with automation", () => {
    let p = mixerFixture();
    expect(refused(addSend(p, "Master", "Reverb"))).toMatch(/Master/);
    expect(refused(addSend(p, "Vehicles", "Reverb"))).toMatch(/already/);
    p = ok(addSend(p, "Music", "Reverb"));
    expect(bus(p, "Music").sends).toEqual([{ to: "Reverb", levelDb: -12 }]);
    p = ok(editSend(p, "Music", editSendLevel(bus(p, "Music").sends[0]!, -3)));
    expect(bus(p, "Music").sends[0]!.levelDb).toBe(-3);
    p = ok(setAutomation(p, { on: "Music", target: "send:Reverb" }, { parameter: "threat", curve: [[0, 0], [1, -6]], bypass: false }));
    const gone = ok(removeSend(p, "Music", "Reverb"));
    expect(gone.automation.some((a) => a.target === "send:Reverb")).toBe(false);
    valid(gone);
  });
  it("ducking: refusals, and the double-duck lint", () => {
    const p = mixerFixture();
    expect(refused(addDucking(p, "Music", "Music"))).toMatch(/itself/);
    expect(refused(addDucking(p, "Music", "Master"))).toMatch(/Master/);
    expect(refused(addDucking(p, "Music", "Dialogue"))).toMatch(/already/);
    expect(ok(addDucking(p, "UI", "Dialogue")).ducking.at(-1)).toMatchObject({ target: "UI", trigger: "Dialogue", amountDb: -6 });
    expect(doubleDucks(p)).toEqual([{ target: "Music", trigger: "Dialogue" }]);
  });
  it("automation: a flat curve is removed; values at the test parameters", () => {
    const p = mixerFixture();
    expect(ok(setAutomation(p, { on: "Music", target: "volume" }, { parameter: "threat", curve: [[0, -2], [1, -2]], bypass: false })).automation.some((a) => a.on === "Music")).toBe(false);
    expect(refused(setAutomation(p, { on: "Music", target: "volume" }, { parameter: "nope", curve: [[0, 0], [1, -2]], bypass: false }))).toMatch(/nope/);
    expect(levelAutomationDb(p, "Music", { threat: 1 })).toBe(-3);
    expect(automatedParams(p, "Ambience", { depth: 30 })).toEqual({ fx1: { cutoff: "800 Hz" } });
  });
  it("automation with a second input (ADR 0362 §5): kept when flat, refused when it can't run, valued at both test parameters", () => {
    const p = mixerFixture();
    const by = { input: "gameState", mode: "labels" as const, labels: { Paused: [[0, -30], [1, -30]] as [number, number][] } };
    const next = ok(setAutomation(p, { on: "Music", target: "volume" }, { parameter: "threat", curve: [[0, -2], [1, -2]], bypass: false, by }));
    expect(next.automation.find((a) => a.on === "Music")!.by).toEqual(by);
    expect(levelAutomationDb(next, "Music", { threat: 1 })).toBe(-2);
    expect(levelAutomationDb(next, "Music", { threat: 1, gameState: 1 })).toBe(-30);
    expect(refused(setAutomation(p, { on: "Music", target: "volume" }, { parameter: "threat", curve: [[0, 0]], bypass: false, by: { input: "health", mode: "labels" } }))).toMatch(/no labels/);
    expect(refused(setAutomation(p, { on: "Music", target: "volume" }, { parameter: "threat", curve: [[0, 0]], bypass: false, by: { input: "threat", mode: "scale" } }))).toMatch(/own parameter/);
    valid(next);
  });
  it("triggers: clamped, unknown parameters refused", () => {
    const p = mixerFixture();
    const next = ok(setTrigger(p, "Underwater", { priority: 250.4, fadeInMs: -5, combine: "add" }));
    expect(next.snapshots[1]).toMatchObject({ priority: 100, fadeInMs: 0, combine: "add" });
    expect(refused(setTrigger(p, "Underwater", { start: { kind: "conditions", match: "all", conditions: [{ parameter: "nope", op: "gt", value: 1 }] } }))).toMatch(/nope/);
    valid(next);
  });
});

describe("references outside audio.json", () => {
  it("playlists, scenes and prefab overrides follow a rename", () => {
    const playlist = { format: "myco.playlist@1", output: "SFX", entries: [{ playlist: { output: "SFX", entries: [] } }], sequence: { tracks: [{ output: "SFX" }, { output: "Music" }] } };
    const renamed = renameBusInPlaylist(playlist, "SFX", "Effects") as typeof playlist;
    expect(renamed.output).toBe("Effects");
    expect(renamed.sequence.tracks.map((t) => t.output)).toEqual(["Effects", "Music"]);
    expect(renameBusInPlaylist(playlist, "UI", "X")).toBe(playlist);
    const scene = { format: "myco.scene@1", nodes: [{ components: [{ type: "engine.AudioSource", data: { output: "SFX" } }, { type: "engine.Other", data: { output: "SFX" } }] }], overrides: [{ component: "engine.AudioSource", field: "output", value: "SFX" }] };
    const s = renameBusInScene(scene, "SFX", "Effects") as typeof scene;
    expect(s.nodes[0]!.components.map((c) => c.data.output)).toEqual(["Effects", "SFX"]);
    expect(s.overrides[0]!.value).toBe("Effects");
    const edit = busRenameEdit("SFX", "Effects");
    expect(edit.json({ buses: [] }, "audio.json")).toBeNull();
    expect(edit.json(playlist, "a/b.playlist.json")).toMatchObject({ output: "Effects" });
    expect(edit.mentioned('{"output":"SFX"}')).toBe(true);
    expect(busUsers([{ path: "a.playlist.json", json: playlist }, { path: "s.scene.json", json: scene }, { path: "audio.json", json: {} }], "SFX")).toEqual(["a.playlist.json", "s.scene.json"]);
  });
});

describe("live mixing", () => {
  it("maps an edit to mix ops over the runtime's view, and applies them only while running", () => {
    const p = mixerFixture();
    const next = ok(setLevel(p, "Music", -4, null));
    const { ops } = liveOps(p, next);
    expect(ops).toEqual([{ op: "setBus", bus: "Music", key: "volume", value: expect.closeTo(Math.pow(10, -4 / 20), 6) }]);
    expect(liveOps(p, p).ops).toEqual([]);
    let running = false;
    const applied: MixOp[] = [];
    let current = p;
    const live = createLiveMix({ running: () => running, apply: (op): ApplyResult => (applied.push(op), { ok: true, class: "smoothed" }) }, () => current);
    expect(live.changed(p, next)).toBeNull();
    running = true;
    current = next;
    expect(live.changed(p, next)!.ops).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });
  it("Compare plays A (the mix the session started with) and locks edits; B restores the edit", () => {
    const p = mixerFixture();
    let current = p;
    const applied: MixOp[] = [];
    const live = createLiveMix({ running: () => true, apply: (op): ApplyResult => (applied.push(op), { ok: true, class: "smoothed" }) }, () => current);
    live.started(p);
    current = ok(setLevel(p, "Music", -4, null));
    live.changed(p, current);
    applied.length = 0;
    expect(live.compare.toggle()!.active).toBe(true);
    expect(live.locked).toBe(true);
    expect(applied).toEqual([{ op: "setBus", bus: "Music", key: "volume", value: expect.closeTo(Math.pow(10, -10 / 20), 6) }]);
    expect(live.changed(current, ok(setLevel(current, "UI", -1, null)))).toBeNull();
    live.compare.toggle();
    expect(live.locked).toBe(false);
  });
  it("solo is a monitor control: never in the file, taints meters", () => {
    const calls: string[] = [];
    const live = createLiveMix({ running: () => true, apply: () => ({ ok: true, class: "direct" }), setMonitor: (b, c) => calls.push(`${b}:${JSON.stringify(c)}`), noteMonitorSolo: () => calls.push("taint") }, mixerFixture);
    live.monitor.toggleSolo("Music");
    expect(calls).toEqual(['Music:{"solo":true}', "taint"]);
    expect(live.monitor.taintedMeters()).toEqual(["Master"]);
  });
});

describe("board", () => {
  it("gain lanes: snapshot offset, VCA, automation and the runtime's duck", () => {
    const p = mixerFixture();
    const inputs = gainInputs(p, "Underwater", null, { threat: 1 }, (n) => (n === "Music" ? { volume: 1, duckGain: 0.5, peak: 0.1, activeVoices: 1 } : null));
    const b = gainBreakdown(inputs, "Music")!;
    expect(b.lanes.find((l) => l.key === "snapshot")!.db).toBe(-6);
    expect(b.lanes.find((l) => l.key === "automation")!.db).toBe(-3);
    expect(b.lanes.find((l) => l.key === "duck")!.db).toBeCloseTo(-6.02, 2);
    expect(gainBreakdown(gainInputs(p, null, "Music", {}), "UI")!.totalDb).toBe(-Infinity);
  });
  it("the snapshot lane blends the snapshots on with the test values when the base mix is edited", () => {
    const p = mixerFixture();
    expect(snapshotLane(p, null, {})).toEqual({ name: "Gameplay", buses: {} });
    expect(snapshotLane(p, null, { depth: 5, health: 10 })).toEqual({ name: "Gameplay + Underwater + Low health", buses: { Ambience: -20, Music: -6, Footsteps: -12, Vehicles: -10 } });
    expect(snapshotLane(p, "Pause menu", { depth: 5 })!.name).toBe("Pause menu");
  });
  it("loudness rows say — without readings and warn against the target", () => {
    expect(loudnessRows(null, null).map((r) => r.text)).toEqual(["—", "—", "—", "—", "—"]);
    const rows = loudnessRows({ momentary: -14.2, shortTerm: -15.8, integrated: -16.4, lra: 7.2, maxTruePeak: -0.6, tainted: false }, { integrated: -24, tolerance: 2, truePeak: -1 });
    expect(rows.map((r) => r.text)).toEqual(["-14.2 LUFS", "-15.8 LUFS", "-16.4 LUFS", "7.2 LU", "-0.6 dBTP"]);
    expect(rows[2]!.warn).toMatch(/Over the -24 LUFS target by 7.6 LU/);
    expect(rows[4]!.warn).toBe("Over -1 dBTP");
    // The tiles: the figure with a true minus, then the unit or the verdict (the prototype's Loudness tiles).
    expect(rows.map((r) => [r.value, r.note, r.verdict])).toEqual([
      ["−14.2", "LUFS", null], ["−15.8", "LUFS", null], ["−16.4", "Warning · 7.6 LU over −24", "warn"], ["7.2", "LU", null], ["−0.6", "Warning · over −1 dBTP", "warn"],
    ]);
    const mobile = loudnessRows({ momentary: -14.2, shortTerm: -15.8, integrated: -16.4, lra: 7.2, maxTruePeak: -1.5, tainted: false }, { integrated: -16, tolerance: 1, truePeak: -1 });
    expect([mobile[2]!.note, mobile[2]!.verdict, mobile[4]!.verdict]).toEqual(["On target (−16)", "ok", null]);
    expect(loudnessRows(null, { integrated: -16, tolerance: 1, truePeak: -1 })[2]).toMatchObject({ value: "—", note: "LUFS", verdict: null });
  });
  it("a new project's platform targets are the spec's three, listed as the spec words them (§4.3.6)", () => {
    const targets = emptyMix().loudness.targets;
    expect(targets.map(targetOptionText)).toEqual(["Console · −24 LUFS, −1 dBTP", "PC / web · −18 LUFS, −1 dBTP", "Mobile · −16 LUFS, −1 dBTP"]);
    expect(targetOptionText({ name: "Handheld", integrated: -14.5, truePeak: 0 })).toBe("Handheld · −14.5 LUFS, 0 dBTP");
  });
  it("pins: at most 8, pruned to what the mix has", () => {
    const p = mixerFixture();
    expect(livePins(["Music", "Gone", "Music", "Reverb"], p)).toEqual(["Music", "Reverb"]);
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(togglePin(eight, "i")).toBeNull();
    expect(togglePin(eight, "a")).toHaveLength(7);
  });
});
