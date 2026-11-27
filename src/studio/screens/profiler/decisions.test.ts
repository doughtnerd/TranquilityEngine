// Why each voice played (spec §4.6.5): a capture's eventStart and pick records tie a voice to the game's request and each
// playlist level's decision; the chain then runs GAME → playlists → SAMPLE → BUS. The graph opens in a row when it fits
// at 60% or more, else in a column, and zooms about the pointer within its limits.
import { describe, expect, it } from "vitest";
import type { CaptureEventAt, CaptureNames } from "../../../plugins/audio/runtime/capture/reader";
import { instanceDecisions, instanceOf, pickReason } from "./decisionModel";
import { chooseLayout, contentSize, fitView, MAX_ZOOM, zoomAt } from "./whyGraphModel";
import { whyChain } from "./whyModel";
import type { VoiceBlock } from "./voiceModel";

const EVENTS = ["vehicles/land.playlist.json", "vehicles/impacts.playlist.json"];
const PARAMS = ["Rock"];
const names = { event: (id: number) => EVENTS[id]!, parameter: (id: number) => PARAMS[id]! } as unknown as CaptureNames;

const ev = (seq: number, seconds: number, event: CaptureEventAt["event"]): CaptureEventAt => ({ seq, seconds, event });
const events: CaptureEventAt[] = [
  ev(10, 20.2, { perfMs: 0, type: "eventStart", instance: 7, asset: 0 }),
  ev(11, 20.2, { perfMs: 0, type: "pick", instance: 7, depth: 0, playlist: 0, playlistType: "switch", choice: 1, label: 0, weights: [] }),
  ev(12, 20.2, { perfMs: 0, type: "pick", instance: 7, depth: 1, playlist: 1, playlistType: "queue", choice: 3, label: null, weights: [] }),
  ev(20, 25, { perfMs: 0, type: "eventStop", instance: 7 }),
];

const voice: VoiceBlock = {
  key: "v3.1", voice: 3, clip: 1, clipName: "land_hard_04.wav", generator: null, slot: 2, busName: "Vehicles", start: 0.2, end: 1.1, open: false, fromKeyframe: false,
  status: "played", reason: null, thief: null, startGain: 1, seq: 13,
};

describe("decisions", () => {
  it("gather each instance's picks and tie a voice started at its instant, after it, to it", () => {
    const [d] = instanceDecisions(events, names, 20);
    expect(d!.asset).toBe("vehicles/land.playlist.json");
    expect(d!.start).toBeCloseTo(0.2, 6);
    expect(d!.picks.map((p) => [p.type, p.label, p.choice])).toEqual([["switch", "Rock", 1], ["queue", null, 3]]);
    expect(instanceOf([d!], 13, 0.2)).toBe(d);
    // A voice recorded before the instance, or at another instant, isn't its.
    expect(instanceOf([d!], 9, 0.2)).toBeNull();
    expect(instanceOf([d!], 30, 3)).toBeNull();
    expect(pickReason(d!.picks[0]!)).toBe("Rock → entry 2");
    expect(pickReason(d!.picks[1]!)).toBe("picked #4");
  });

  it("make the chain from the game's request to the bus", () => {
    const [d] = instanceDecisions(events, names, 20);
    const chain = whyChain(voice, d);
    expect(chain.note).toBeNull();
    expect(chain.steps.map((s) => s.label)).toEqual(["GAME", "PLAYLIST · SW", "PLAYLIST · RND", "SAMPLE", "BUS"]);
    expect(chain.steps.map((s) => s.name)).toEqual(["Game event land", "vehicles / land", "vehicles / impacts", "land_hard_04.wav", "Vehicles"]);
    expect(chain.steps[1]).toMatchObject({ screen: "playlists", target: "vehicles/land.playlist.json" });
    // A blocked voice's last level says why.
    const blocked = whyChain({ ...voice, status: "blocked", end: voice.start }, d);
    expect(blocked.steps[2]!.severity).toBe("warning");
  });
});

describe("the game step's trigger and source (ADR 0435)", () => {
  const CAUSE_PARAMS = ["Audio.play", "/Level/Player/Bike", "BikeAudio.onCollisionEnter", "game.Waves", "AudioSource"];
  const causeNames = { event: (id: number) => EVENTS[id]!, parameter: (id: number) => CAUSE_PARAMS[id]! } as unknown as CaptureNames;
  const start = (cause: { trigger: number | null; node: number | null; behaviour: number | null; system: number | null }) =>
    [ev(10, 20.2, { perfMs: 0, type: "eventStart", instance: 7, asset: 0, cause })];

  it("names the trigger, and the GameObject, behaviour hook and system it came from", () => {
    const [d] = instanceDecisions(start({ trigger: 0, node: 1, behaviour: 2, system: 3 }), causeNames, 20);
    expect(d!.cause).toEqual({ trigger: "Audio.play", node: "/Level/Player/Bike", behaviour: "BikeAudio.onCollisionEnter", system: "game.Waves" });
    const game = whyChain(voice, d).steps[0]!;
    expect(game).toMatchObject({ kind: "game", label: "GAME", name: "Audio.play", why: "/Level/Player/Bike · BikeAudio.onCollisionEnter · system game.Waves" });
    expect(game.detail!.split("\n")).toEqual([
      "Trigger: Audio.play",
      "GameObject: /Level/Player/Bike",
      "Behaviour: BikeAudio.onCollisionEnter",
      "System: game.Waves",
      "Asked for: vehicles/land.playlist.json",
    ]);
  });

  it("shows what it has: a component's GameObject alone, or no script when nothing was running", () => {
    const [source] = instanceDecisions(start({ trigger: 4, node: 1, behaviour: null, system: null }), causeNames, 20);
    expect(whyChain(voice, source).steps[0]).toMatchObject({ name: "AudioSource", why: "/Level/Player/Bike" });
    const [bare] = instanceDecisions(start({ trigger: 0, node: null, behaviour: null, system: null }), causeNames, 20);
    expect(whyChain(voice, bare).steps[0]).toMatchObject({ name: "Audio.play", why: "No script hook running" });
  });

  it("a capture from before it keeps the older game step", () => {
    const [d] = instanceDecisions(events, names, 20);
    expect(d!.cause).toBeNull();
    expect(whyChain(voice, d).steps[0]).toMatchObject({ name: "Game event land", why: "Game trigger" });
    expect(whyChain(voice, d).steps[0]!.detail).toBeUndefined();
  });
});

describe("the graph's geometry", () => {
  it("opens in a row when it fits at 60%, else a column", () => {
    expect(chooseLayout(5, { w: 1000, h: 300 })).toBe("row");
    expect(chooseLayout(5, { w: 300, h: 500 })).toBe("column");
    expect(contentSize(3, "row")).toEqual({ w: 3 * 170 + 2 * 24, h: 58 });
  });

  it("fits, centring what fits and starting at the request otherwise; zooms about a point within its limits", () => {
    const v = fitView({ w: 1000, h: 300 }, contentSize(3, "row"));
    expect(v.scale).toBe(1);
    expect(v.x).toBeCloseTo((1000 - 558) / 2, 6);
    const tight = fitView({ w: 300, h: 300 }, contentSize(5, "row"));
    expect(tight.scale).toBe(0.6);
    expect(tight.x).toBe(16);
    const z = zoomAt({ scale: 1, x: 0, y: 0 }, 4, 100, 50);
    expect(z.scale).toBe(MAX_ZOOM);
    expect(z.x).toBeCloseTo(100 - 100 * MAX_ZOOM, 6);
  });
});
