import { describe, expect, it } from "vitest";
import { defaultEntryUse, emptyPlaylistBody, parsePlaylist } from "../../../engine/audio/playlist/format";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { activeTriangle, axisInput, axisName, laneCurves, liveWeights, normalisedPoints, nudge, triangleEdges } from "./blendViewModel";
import { FIXTURE_PARAMETERS, FIXTURE_PLAYLISTS, fixtureLints } from "./playlistFixture";
import { canRelease } from "./voiceLog";

describe("blend view model", () => {
  const engine = FIXTURE_PLAYLISTS["audio/vehicles/engine.playlist.json"]!;
  const wind = FIXTURE_PLAYLISTS["audio/ambience/wind.playlist.json"]!;

  it("reads the input from test values, defaults and the voice-time scrub", () => {
    expect(axisInput({ parameter: "rpm" }, FIXTURE_PARAMETERS, {}, 0)).toBe(3200);
    expect(axisInput({ parameter: "rpm" }, FIXTURE_PARAMETERS, { rpm: 100 }, 0)).toBe(100);
    expect(axisInput({ voiceTime: 2 }, FIXTURE_PARAMETERS, {}, 5)).toBe(2);
    expect(axisName({ voiceTime: 2 })).toBe("Voice time · 2 s");
  });

  it("draws the engine's weights: the lane's curves and the live weights", () => {
    const pts = normalisedPoints(engine.entries, [[0, 8000]]);
    expect(pts.map((p) => p.x)).toEqual([0.1, 0.4, 0.8]);
    const curves = laneCurves(pts.map((p) => p.x), "crossfade", "linear", 11);
    expect(curves[0]![0]).toEqual([0, 1]);
    expect(curves[2]![10]).toEqual([1, 1]);
    // rpm 3200 sits on the middle entry.
    expect(liveWeights(engine, FIXTURE_PARAMETERS, {}, 0).map((w) => Math.round(w * 100) / 100)).toEqual([0, 1, 0]);
  });

  it("triangulates a 2D blend and finds the triangle the input plays from", () => {
    const pts = normalisedPoints(wind.entries, [[0, 1], [0, 1]]);
    const edges = triangleEdges(pts);
    expect(edges.length).toBe(5); // a square: four sides and a diagonal
    const w = liveWeights(wind, FIXTURE_PARAMETERS, { wind: 0.3, rain: 0.6 }, 0);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(activeTriangle(w)).not.toBeNull();
    expect(activeTriangle([1, 0, 0])).toBeNull();
  });

  it("nudges by 1 % (10 % with Shift) within the range", () => {
    expect(nudge(50, [0, 100], 1, false)).toBe(51);
    expect(nudge(95, [0, 100], 1, true)).toBe(100);
    expect(nudge(0, [0, 100], -1, false)).toBe(0);
  });
});

describe("release and the fixture", () => {
  it("offers Release when something holds", () => {
    const load = (p: string) => FIXTURE_PLAYLISTS[p] ?? null;
    expect(canRelease(FIXTURE_PLAYLISTS["audio/vehicles/engine.playlist.json"]!, load)).toBe(true);
    expect(canRelease(FIXTURE_PLAYLISTS["audio/footsteps/footsteps.playlist.json"]!, load)).toBe(false);
    const looping: PlaylistBody = { ...emptyPlaylistBody("layer"), entries: [{ kind: "embedded", ...defaultEntryUse(), embedded: { ...emptyPlaylistBody("clip"), entries: [{ kind: "sample", sample: "a.wav", trim: null, loop: "on", ...defaultEntryUse() }] } }] };
    expect(canRelease(looping, load)).toBe(true);
    expect(canRelease({ ...emptyPlaylistBody("queue"), queue: { pick: "random", avoidRepeat: 1, continuous: { gapMs: 0 } } }, load)).toBe(true);
  });

  it("parses the fixture without problems, and lints the rule waiting for a bar", () => {
    for (const [p, v] of Object.entries(FIXTURE_PLAYLISTS)) expect(parsePlaylist(JSON.parse(JSON.stringify(v)), p).problems).toEqual([]);
    expect(fixtureLints("audio/footsteps/footsteps.playlist.json").map((l) => l.code)).toContain("noTempoSource");
  });
});
