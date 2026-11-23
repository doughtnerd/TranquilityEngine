// What the Take screen reads from a take's playlists (spec §4.5.3-§4.5.5): how a lane plays, the "In this take" summary,
// a game parameter's "Drives …" line, and the Inspector's property cards (authored against live through the curves).
import { describe, expect, it } from "vitest";
import { defaultEntryUse, emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { drivesText, playlistSummary, playsText, propertyCards, unitText } from "./takePlaylists";

function engine(): PlaylistBody {
  const b = emptyPlaylistBody("layer");
  b.playback = { ...b.playback, plays: "untilStopped" };
  b.volume = -6;
  b.automation = [{ id: "a1", target: "pitch", input: { parameter: "Speed" }, curve: [[0, -3, "easeIn"], [200, 7]], bypass: false }];
  b.entries = [
    { ...defaultEntryUse(), kind: "sample", sample: "audio/engine_low.wav", trim: null, loop: "inherit", curves: { lowpass: { input: { parameter: "Speed" }, curve: [[0, 800], [200, 16000]], bypass: false } } },
    { ...defaultEntryUse(), kind: "sample", sample: "audio/engine_high.wav", trim: null, loop: "inherit", curves: { gain: { input: { parameter: "Rpm" }, curve: [[0, -12], [8000, 0]], bypass: false } } },
  ];
  return b;
}

describe("lane words", () => {
  it("say how the playlist plays", () => {
    expect(playsText(engine(), false)).toBe("until stopped · Layer");
    expect(playsText(emptyPlaylistBody("switch"), true)).toBe("one-shot · sustain · Switch");
    expect(playsText(null, false)).toBe("");
  });

  it("summarise it for In this take", () => {
    const q = emptyPlaylistBody("queue");
    q.entries = [1, 2, 3].map((n) => ({ ...defaultEntryUse(), kind: "sample" as const, sample: `t${n}.wav`, trim: null, loop: "inherit" as const }));
    q.queue = { pick: "roundRobin", avoidRepeat: 0, continuous: null };
    expect(playlistSummary(q)).toBe("3 takes, round robin");
    expect(playlistSummary(engine())).toBe("2 layers");
  });

  it("name what a game parameter drives, per playlist", () => {
    const playlists = [{ label: "engine", body: engine() }, { label: "boost", body: emptyPlaylistBody("clip") }];
    expect(drivesText("Speed", playlists)).toBe("Drives pitch, low-pass on engine");
    expect(drivesText("Rpm", playlists)).toBe("Drives volume on engine");
    expect(drivesText("Surface", playlists)).toBe("");
  });
});

describe("property cards", () => {
  it("put the game's value through the curves: the live value beside the authored one, with the mapping", () => {
    const cards = propertyCards(engine(), (name) => (name === "Speed" ? 100 : name === "Rpm" ? 4000 : null), [{ name: "Speed", min: 0, max: 200, default: 0, seekSpeed: 50 }]);
    expect(cards.map((c) => c.label)).toEqual(["Volume", "Pitch", "engine_low · Low-pass", "engine_high · Volume"]);
    const [volume, pitch, lowpass, gain] = cards;
    expect(volume!.driver).toBeNull();
    expect(volume!.text).toBe("−6.0 dB");
    // ease-in at the middle: −3 + 10 × 0.25 = −0.5 st on top of the authored 0.
    expect(pitch!.live).toBeCloseTo(-0.5, 5);
    expect(pitch!.authored).toBe(0);
    expect(pitch!.driver).toEqual({ parameter: "Speed", mapping: "−3 to +7 st · ease-in · seek 50/s" });
    expect(lowpass!.live).toBeCloseTo(8400, 0);
    expect(lowpass!.driver!.mapping).toBe("800 Hz to 16 kHz · log · seek 50/s");
    expect(gain!.live).toBeCloseTo(-6, 5);
  });

  it("a parameter the take never set leaves the authored value", () => {
    const [, pitch] = propertyCards(engine(), () => null);
    expect(pitch!.live).toBe(0);
    expect(pitch!.driver?.parameter).toBe("Speed");
  });

  it("units read as the prototype writes them", () => {
    expect(unitText(4.2, "st")).toBe("+4.2 st");
    expect(unitText(8200, "Hz")).toBe("8.2 kHz");
    expect(unitText(-6, "dB")).toBe("−6.0 dB");
  });
});
