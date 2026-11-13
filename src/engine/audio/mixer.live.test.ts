// ADR 0171 amended by 0172 (Ma1; api-and-models §3.1, §6.2; architecture §4.5, §4.7): `Mixer._applyLive`, the main-side
// half of a live op. Authored volume ramps asap over DRAG_RAMP_MS (never stamped); runtime state stays; the active
// snapshot follows an edit of its definition over SNAPSHOT_EDIT_MS; a rename keeps the state and the loudness object; an
// added bus goes to the end (slot order).
import { describe, expect, it, vi } from "vitest";
import { DRAG_RAMP_MS, Mixer, SNAPSHOT_EDIT_MS } from "./mixer";
import { parseAudioSettings } from "./settings";
import type { BusLoudness } from "./loudnessTypes";

const settings = () =>
  parseAudioSettings({
    buses: [{ name: "Master" }, { name: "Music", parent: "Master", volume: 0.8 }, { name: "SFX", parent: "Master" }],
    snapshots: [{ name: "Paused", volumes: { Music: 0.5 } }],
  }).settings;

describe("Mixer._applyLive (Ma1)", () => {
  it("authored volume ramps from now over DRAG_RAMP_MS even when the backend stamps ramps; the script's volume and fade stay", () => {
    const m = new Mixer(settings());
    let t = 1;
    m.setClock(() => t, () => t + 0.067); // a stamp 67 ms ahead (the lookahead at 30 fps)
    m.bus("Music").fadeTo(0.5, 2);
    const fade = { ...m._lanes("Music")!.runtime };
    expect(m._applyLive({ op: "setBus", bus: "Music", key: "volume", value: 0.4 })).toBe(true);
    expect(m._lanes("Music")!.authored).toMatchObject({ from: 0.8, to: 0.4, start: 1, seconds: DRAG_RAMP_MS / 1000 });
    expect(m._lanes("Music")!.runtime).toEqual(fade);
    t = 1 + DRAG_RAMP_MS / 1000;
    expect(m.bus("Music").authoredVolume).toBeCloseTo(0.4, 9);
    expect(m.audioSettings.buses[1]!.volume).toBe(0.4);
    // Re-applying the same value changes nothing (the commit after a preview).
    expect(m._applyLive({ op: "setBus", bus: "Music", key: "volume", value: 0.4 })).toBe(false);
  });

  it("authored mute toggles the lane and leaves the script's mute alone", () => {
    const m = new Mixer(settings());
    m.bus("SFX").mute = true;
    m._applyLive({ op: "setBus", bus: "SFX", key: "mute", value: true });
    expect(m.bus("SFX").authoredMute).toBe(true);
    m._applyLive({ op: "setBus", bus: "SFX", key: "mute", value: false });
    expect(m.bus("SFX").authoredMute).toBe(false);
    expect(m.bus("SFX").mute).toBe(true);
  });

  it("the active snapshot follows an edit of its definition over SNAPSHOT_EDIT_MS; renamed it stays active; removed, its lanes head back to 1", () => {
    const m = new Mixer(settings());
    let t = 0;
    m.setClock(() => t);
    m.snapshot("Paused", 0);
    m._applyLive({ op: "setSnapshot", index: 0, bus: "Music", key: "volume", value: 0.25 });
    expect(m._lanes("Music")!.snapshot).toMatchObject({ from: 0.5, to: 0.25, seconds: SNAPSHOT_EDIT_MS / 1000 });
    expect(m._lanes("SFX")!.snapshot.to).toBe(1);
    m._applyLive({ op: "renameSnapshot", index: 0, name: "Hush" });
    expect(m.currentSnapshot).toBe("Hush");
    t = 1;
    m._applyLive({ op: "removeSnapshot", index: 0 });
    expect(m.currentSnapshot).toBeNull();
    expect(m._lanes("Music")!.snapshot).toMatchObject({ from: 0.25, to: 1, seconds: SNAPSHOT_EDIT_MS / 1000 });
    // An edit of a snapshot not in force moves no lane.
    const seq = m._lanes("Music")!.snapshot.seq;
    m._applyLive({ op: "addSnapshot", index: 0, name: "Menu" });
    m._applyLive({ op: "setSnapshot", index: 0, bus: "Music", key: "volume", value: 0.1 });
    expect(m._lanes("Music")!.snapshot.seq).toBe(seq);
  });

  it("a rename moves the state, keeps the loudness object a script holds and aliases the old name (one warning)", () => {
    const m = new Mixer(settings());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    m.setLoudnessSource({ busLoudness: (bus) => (seen.push(bus), null as BusLoudness | null) });
    const music = m.bus("Music");
    music.volume = 0.3;
    const loudness = music.loudness;
    m._applyLive({ op: "renameBus", from: "Music", to: "Score" });
    expect(m.busNames).toEqual(["Master", "Score", "SFX"]);
    expect(m.bus("Score").volume).toBe(0.3);
    expect(music.volume).toBe(0.3); // the held handle, through the alias
    expect(m.bus("Score").loudness).toBe(loudness);
    void loudness.momentary;
    expect(seen.at(-1)).toBe("Score");
    expect(m.resolveOutput("Music")).toBe("Score");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("an added bus goes to the end of the running tree (slot order) with the slot it was given", () => {
    const m = new Mixer(settings());
    m._applyLive({ op: "addBus", name: "Amb", parent: "Music", index: 1 }, 3);
    expect(m.busNames).toEqual(["Master", "Music", "SFX", "Amb"]);
    expect(m.audioSettings.buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "Amb"]);
    expect(m._lanes("Amb")!.slot).toBe(3);
    expect(m.resolve("Amb")!.effectiveGain).toBeCloseTo(0.8, 9);
  });

  it("a removed bus (and its descendants) is gone from resolveAll, busNames and the lanes, while another bus's fade, mute, solo and voices carry on", () => {
    const m = new Mixer(parseAudioSettings({
      buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Stems", parent: "Music" }, { name: "SFX", parent: "Master" }],
    }).settings);
    let t = 0;
    m.setClock(() => t);
    m.voiceStarted("SFX");
    m.voiceStarted("SFX");
    m.bus("SFX").mute = true;
    m.bus("Master").solo = true;
    m.bus("Master").fadeTo(0.2, 2);
    t = 0.5;
    const mid = m.bus("Master").volume;
    const fade = { ...m._lanes("Master")!.runtime };
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(1);

    expect(m._applyLive({ op: "removeBus", bus: "Music" })).toBe(true);
    expect(m.busNames).toEqual(["Master", "SFX"]);
    expect(m.resolveAll().map((b) => b.name)).toEqual(["Master", "SFX"]);
    expect(m.has("Music")).toBe(false);
    expect(m.has("Stems")).toBe(false);
    expect(m._lanes("Stems")).toBeUndefined();

    // The fade on Master is the same ramp, unrestarted: it continues from where it was and lands at its target.
    expect(m._lanes("Master")!.runtime).toEqual(fade);
    expect(m.bus("Master").volume).toBeCloseTo(mid, 9);
    t = 2;
    expect(m.bus("Master").volume).toBeCloseTo(0.2, 9);
    expect(m.bus("SFX").mute).toBe(true);
    expect(m.bus("Master").solo).toBe(true);
    expect(m._state("SFX")!.voices).toBe(2);
  });

  it("a bus added with no slot after a removal takes a slot no remaining bus holds", () => {
    const m = new Mixer(settings());
    m._applyLive({ op: "removeBus", bus: "Music" }); // Master 0, SFX 2
    m._applyLive({ op: "addBus", name: "Amb", parent: "Master", index: 1 });
    const slots = m.busNames.map((n) => m._lanes(n)!.slot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(m._lanes("Amb")!.slot).toBe(3);
  });

  it("a removed bus's old name stops aliasing once its target is gone", () => {
    const m = new Mixer(settings());
    m._applyLive({ op: "renameBus", from: "SFX", to: "Fx" });
    m._applyLive({ op: "removeBus", bus: "Fx" });
    expect(m.busNames).toEqual(["Master", "Music"]);
    expect(m._state("SFX")).toBeUndefined();
  });

  it("a refused op changes nothing", () => {
    const m = new Mixer(settings());
    const before = m.audioSettings;
    expect(m._applyLive({ op: "setBus", bus: "Nope", key: "volume", value: 1 })).toBe(false);
    expect(m.audioSettings).toBe(before);
  });
});
