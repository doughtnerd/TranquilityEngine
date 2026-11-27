// The Profiler screen's pure models, through their interfaces: voices and lanes from typed events, the problems-only
// filter, the messages' order, the track plan by capture contents, the cursor keys (step and marker jumps), the
// captures tree, the bus readouts and the "Why it played" chain.
import { describe, expect, it } from "vitest";
import { CursorModel } from "../../../plugins/audio/editor/mix/cursorModel";
import type { CaptureEvent, CaptureEventAt, CaptureKeyframeBus } from "../../../plugins/audio/runtime/capture/reader";
import { namesFromStart } from "../../../plugins/audio/runtime/capture/testSupport";
import { GEN_CLIP_ID_FIRST } from "../../../plugins/audio/runtime/wire.generated";
import { captureTitle, captureTree, nextCapturePath, searchCaptures, treeFolders, whyNotCaptureFile } from "../run/captureTree";
import { CURSOR_KEYS, profilerTargets, runCursorKey } from "./cursorKeys";
import { breakdownText, busReadouts, reasonsText } from "./cursorReadout";
import { buildMemory, memoryAt, memoryText } from "./memoryModel";
import { buildMessages, filterMessages, messageCounts, rulerMarks } from "./messagesModel";
import { noTracksText, planTracks, type CaptureContents } from "./trackPlan";
import { buildVoices, dimmed, isProblem, voiceLanes, voiceSummary, type VoiceBlock } from "./voiceModel";
import { NO_PICK_PATH, whyChain } from "./whyModel";

const names = namesFromStart({ clips: [[1, "engine.ogg"], [2, "boost.wav"], [3, "vo.wav"]], buses: [[1, "Vehicles"], [2, "Dialogue"]] });

let seq = 0;
type EventInit = CaptureEvent extends infer E ? (E extends unknown ? Omit<E, "perfMs"> : never) : never;
const at = (seconds: number, event: EventInit): CaptureEventAt => ({ seq: ++seq, seconds, event: { perfMs: 0, ...event } as CaptureEvent });
const start = (s: number, voice: number, clip: number, slot: number) => at(s, { type: "voiceStart", voice, clip, slot, busGen: 0, flags: 0, atFrameLo: 0, gain: 0.5 });

function scene(): VoiceBlock[] {
  return buildVoices(
    [
      start(1, 10, 1, 1),
      at(2, { type: "voiceStop", voice: 10, reason: "ended" }),
      start(1.5, 11, 2, 1),
      at(3, { type: "voiceSteal", voice: 11, thief: 12, reason: "busMaxVoices" }),
      at(2.5, { type: "voiceRefused", clip: 2, slot: 1, busGen: 0, reason: "busFull" }),
      at(4, { type: "voiceRefused", clip: 3, slot: 2, busGen: 0, reason: "loadFailed" }),
      start(5, 12, 1, 1),
      at(6, { type: "voiceStop", voice: 99, reason: "ended" }), // never started: ignored
    ],
    names,
    { start: 0, duration: 8, initial: [{ voice: 1, clip: 1, slot: 1 }] },
  );
}

describe("voices from typed events", () => {
  it("names a generator voice's kind from its reserved clip id (ADR 0360)", () => {
    const blip = GEN_CLIP_ID_FIRST + 3;
    const genNames = namesFromStart({ clips: [[1, "engine.ogg"], [blip, "ui/coin.generator.json"]], buses: [[1, "UI"]] });
    const v = buildVoices([start(1, 20, blip, 1), start(1, 21, 1, 1)], genNames, { start: 0, duration: 2 });
    expect(v.map((b) => [b.clipName, b.generator])).toEqual([["ui/coin.generator.json", "blip"], ["engine.ogg", null]]);
  });

  it("makes one block per voice and refusal, with the prototype's statuses, by start time", () => {
    const v = scene();
    expect(v.map((b) => [b.clipName, b.busName, b.start, b.end, b.status, b.open])).toEqual([
      ["engine.ogg", "Vehicles", 0, 8, "played", true], // from the first keyframe, open to the end
      ["engine.ogg", "Vehicles", 1, 2, "played", false],
      ["boost.wav", "Vehicles", 1.5, 3, "stolen", false],
      ["boost.wav", "Vehicles", 2.5, 2.5, "blocked", false],
      ["vo.wav", "Dialogue", 4, 4, "missing", false],
      ["engine.ogg", "Vehicles", 5, 8, "played", true],
    ]);
    expect(v[0]!.fromKeyframe).toBe(true);
    expect(v[2]!.thief).toBe(12);
    expect(voiceSummary(v[2]!)).toBe("Vehicles stole boost.wav (bus max voices) for voice 12");
    expect(voiceSummary(v[4]!)).toBe("Missing file vo.wav");
  });

  it("lanes by bus or by clip; overlapping blocks take rows; problems only drops quiet lanes and dims played voices", () => {
    const v = scene();
    const byBus = voiceLanes(v, "bus");
    expect(byBus.map((l) => [l.label, l.blocks.length, l.problems])).toEqual([["Dialogue", 1, 1], ["Vehicles", 5, 2]]);
    const vehicles = byBus[1]!;
    expect(vehicles.rowCount).toBeGreaterThan(1);
    expect(voiceLanes(v, "clip").map((l) => l.label)).toEqual(["boost.wav", "engine.ogg", "vo.wav"]);
    expect(voiceLanes(v, "clip", true).map((l) => l.label)).toEqual(["boost.wav", "vo.wav"]);
    expect(v.filter(isProblem).length).toBe(3);
    expect(dimmed(v[0]!, true)).toBe(true);
    expect(dimmed(v[2]!, true)).toBe(false);
    expect(dimmed(v[0]!, false)).toBe(false);
  });
});

describe("messages", () => {
  it("are in time order, errors before warnings before notes at one instant, each seeking and selecting", () => {
    const voices = scene();
    const m = buildMessages({
      voices,
      loudness: [{ busName: "Master", kind: "over", metric: "shortTerm", from: 3, to: 5.5 }],
      markers: [{ time: 4, text: "Boss" }],
      notes: [{ time: 0.5, text: "Music Explore → Combat" }],
      truncated: true,
    });
    expect(m.map((x) => [x.time, x.kind, x.text])).toEqual([
      [0, "info", "The ring wrapped: this capture starts at a later keyframe, not at the start of the run."],
      [0.5, "info", "Music Explore → Combat"],
      [2.5, "warning", "boost.wav blocked: voice limit (bus full)"],
      [3, "warning", "Master over the target (short-term) for 2.500 s"],
      [3, "warning", "Vehicles stole boost.wav (bus max voices) for voice 12"],
      [4, "error", "Missing file vo.wav"],
      [4, "info", "Marker: Boss"],
    ]);
    expect(m.find((x) => x.text.startsWith("Missing"))!.voice).toBe(voices[4]!.key);
    // Each warning about a bus carries it, for "Open in Mixer ›" (J10.4; spec §3.2: links carry the object).
    expect(m.find((x) => x.text.startsWith("Vehicles stole"))!.bus).toBe(voices.find((v) => v.status === "stolen")!.busName);
    expect(m.find((x) => x.source === "loudness")!.bus).toBe("Master");
    expect(m.filter((x) => x.source === "marker" || x.source === "note" || x.source === "capture").map((x) => x.bus)).toEqual([null, null, null]);
    expect(messageCounts(m)).toEqual({ error: 1, warning: 3, info: 3 });
    expect(filterMessages(m, new Set(["error"])).length).toBe(1);
    expect(rulerMarks(m).map((r) => [r.time, r.kind])).toEqual([[2.5, "warning"], [3, "warning"], [3, "warning"], [4, "error"], [4, "info"]]);
  });
});

describe("the track plan", () => {
  const full: CaptureContents = { frames: true, status: true, cpu: true, effects: true, buses: [{ slot: 1, name: "Music" }, { slot: 2, name: "Vehicles" }], loudness: true, voices: true, parameters: ["Speed"] };

  it("orders the tracks as the prototype does", () => {
    expect(planTracks(full).map((t) => t.label)).toEqual(["Picture", "Load", "Effects cost · estimated", "Bus · Music", "Bus · Vehicles", "Loudness", "Voices", "Game · Speed"]);
  });

  it("shows only the tracks the capture has data for", () => {
    const babylon: CaptureContents = { frames: false, status: false, cpu: false, effects: true, buses: [], loudness: false, voices: true, parameters: [] };
    expect(planTracks(babylon).map((t) => t.id)).toEqual(["voices"]);
    expect(planTracks({ ...full, frames: false, effects: false, loudness: false, parameters: [] }).map((t) => t.id)).toEqual(["load", "bus:1", "bus:2", "voices"]);
    const empty = { ...babylon, voices: false };
    expect(planTracks(empty)).toEqual([]);
    expect(noTracksText(empty)).toMatch(/no voices/);
    expect(noTracksText(full)).toBeNull();
  });
});

describe("the cursor keys", () => {
  const cols = { seconds: Float64Array.of(0, 0.5, 1, 1.5, 2), underruns: new Float64Array(5), lateCommands: new Float64Array(5), m3Shed: new Float64Array(5), loudShed: new Float64Array(5) };

  it("step one STATUS block, and jump between the capture's markers and the warnings", () => {
    const cursor = new CursorModel({ live: false });
    cursor.setDuration(2);
    cursor.setTargets(profilerTargets(cols, [{ seq: 1, seconds: 10.4, text: "m" }], 10, [{ time: 1.2, kind: "warning", text: "w", voice: null }, { time: 0.4, kind: "info", text: "m", voice: null }]));
    expect(CURSOR_KEYS.map((k) => k.keys[0])).toEqual(["ArrowLeft", "ArrowRight", "Shift+ArrowLeft", "Shift+ArrowRight"]);
    expect(runCursorKey("stepForward", cursor)).toBe(true);
    expect(cursor.time).toBe(0.5);
    expect(runCursorKey("stepBack", cursor)).toBe(true);
    expect(cursor.time).toBe(0);
    expect(runCursorKey("stepBack", cursor)).toBe(false); // the first block
    expect(runCursorKey("markerForward", cursor)).toBe(true);
    expect(cursor.time).toBeCloseTo(0.4); // the capture's marker (axis 10.4, start 10)
    expect(runCursorKey("markerForward", cursor)).toBe(true);
    expect(cursor.time).toBe(1.2); // a warning
    expect(runCursorKey("markerForward", cursor)).toBe(false);
    expect(runCursorKey("markerBack", cursor)).toBe(true);
    expect(cursor.time).toBeCloseTo(0.4);
  });
});

describe("the captures tree", () => {
  const files = ["recordings/b.sporesample", "recordings/a.sporesample", "recordings/test pc/slot 07.sporesample", "recordings/run.sporesample", "sfx/boom.wav", "root.sporesample"];

  it("holds capture files by folder, folders first, by name", () => {
    const tree = captureTree(files);
    expect(tree.map((n) => n.name)).toEqual(["recordings", "root.sporesample"]);
    const captures = tree[0]!;
    expect(captures.kind === "folder" && captures.children.map((n) => n.name)).toEqual(["test pc", "a.sporesample", "b.sporesample", "run.sporesample"]);
    expect(treeFolders(tree)).toEqual(["recordings", "recordings/test pc"]);
    expect(captureTitle("recordings/test pc/slot 07.sporesample")).toBe("slot 07");
  });

  it("searches by path, names the next free capture and refuses other files", () => {
    expect(searchCaptures(files, "PC slot")).toEqual(["recordings/test pc/slot 07.sporesample"]);
    expect(searchCaptures(files, "boom")).toEqual([]);
    expect(nextCapturePath(["recordings/capture_01.sporesample"])).toBe("recordings/capture_02.sporesample");
    expect(whyNotCaptureFile("x.wav")).toMatch(/isn't a recording/);
    expect(whyNotCaptureFile("x.SPORESAMPLE")).toBeNull();
  });
});

describe("bus readouts at the cursor", () => {
  const lane = (value: number) => ({ value, target: value });
  const bus = (slot: number, authored: number, duck: number, dip = 1): CaptureKeyframeBus =>
    ({ slot, gen: 0, lanes: { authored: lane(authored), runtime: lane(1), snapshot: lane(1), monitor: lane(1), dip: lane(dip) }, duck, automation: 1, authoredMute: false, runtimeMute: false, monitorMute: false, monitorSolo: false, tombstone: false, metered: false }) as CaptureKeyframeBus;
  const busNames = namesFromStart({ buses: [[1, "Music"], [2, "Vehicles"]] });

  it("give each bus's level, its authored level and the reasons it differs", () => {
    const r = busReadouts({ buses: [bus(2, 1, 1, 0.1), bus(1, 0.316, 0.5)] }, busNames, 0);
    expect(r.map((x) => x.name)).toEqual(["Music", "Vehicles"]);
    expect(reasonsText(r[0]!)).toBe("ducked");
    expect(reasonsText(r[1]!)).toBe("dip");
    expect(breakdownText(r[0]!)).toBe("Music -16.0 dB / authored -10.0 / duck -6.0");
    expect(busReadouts(null, busNames, 0)).toEqual([]);
  });
});

describe("why it played", () => {
  it("is the sample and the bus with a note until captures carry pick paths", () => {
    const v = scene();
    const chain = whyChain(v[2]!);
    expect(chain.steps.map((s) => [s.label, s.name, s.severity, s.screen])).toEqual([["SAMPLE", "boost.wav", "ok", "samples"], ["BUS", "Vehicles", "warning", "mixer"]]);
    expect(chain.note).toBe(NO_PICK_PATH);
    expect(whyChain(v[4]!).steps[0]!.severity).toBe("error");
  });
});

describe("the memory track (ADR 0351 §6)", () => {
  const pkgNames = namesFromStart({ parameters: [[1, "Core"], [2, "Boss"]] });
  const pkg = (seconds: number, name: number, event: "loadStart" | "loaded" | "failed" | "unload", memoryBytes: number | null) => at(seconds, { type: "audioPackage", name, event, bytes: 1000, memoryBytes });

  it("adds each loaded package's memory and takes it away at its unload, with a mark for each", () => {
    const m = buildMemory([0, 1, 2], [100, 200, 150], [pkg(10.5, 1, "loadStart", null), pkg(10.6, 1, "loaded", 4096), pkg(11, 2, "loaded", 8192), pkg(11.5, 2, "failed", null), pkg(12, 1, "unload", 4096)], pkgNames, 10)!;
    expect(Array.from(m.arena.values)).toEqual([102_400, 204_800, 153_600]);
    expect(m.peakArena).toBe(204_800);
    expect(Array.from(m.packages.times, (t) => Math.round(t * 10) / 10)).toEqual([0.6, 1, 2]);
    expect(Array.from(m.packages.values)).toEqual([4096, 12_288, 8192]);
    expect(m.marks.map((k) => k.text)).toEqual(["Core loaded · 4 KB", "Boss loaded · 8 KB", "Boss failed to load", "Core unloaded"]);
    expect(memoryAt(m.packages, 1.5)).toBe(12_288);
    expect(memoryText(m, 1.5, (b) => `${b}`)).toBe("arena 204800 · packages 12288");
  });

  it("shows an older capture's package marks without a package line; none at all without arena or packages", () => {
    const old = buildMemory([0], [0], [pkg(1, 1, "loaded", null), pkg(2, 1, "unload", null)], pkgNames, 0)!;
    expect(old.packages.times.length).toBe(0);
    expect(old.unknownPackages).toEqual(["Core"]);
    expect(old.marks).toHaveLength(2);
    expect(buildMemory([0, 1], [0, 0], [], pkgNames, 0)).toBeNull();
    expect(buildMemory([], null, [], pkgNames, 0)).toBeNull();
  });

  it("plans the Memory track after Load and Effects cost", () => {
    const c: CaptureContents = { frames: false, status: true, cpu: true, effects: true, memory: true, buses: [], loudness: false, voices: false, parameters: [] };
    expect(planTracks(c).map((t) => t.id)).toEqual(["load", "effects", "memory"]);
  });
});
