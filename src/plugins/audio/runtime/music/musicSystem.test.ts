// ADR 0166 (Q2): the flip "engine.AudioMusic in the frame" and its safety net. In a World with no music (and so no
// subscribers: `handle.onMusic` and the component hooks need a playing music instance) the new update-phase step does
// nothing: no `beginFrame` call and no allocation, because it returns before anything past the guard runs (the step's
// work counter stays 0). With a music instance it runs in the World that has the view, and stops again when it ends.
import { afterEach, describe, expect, it } from "vitest";
import type { World } from "../../../../engine/core/World";
import { setAudioBackend } from "../backend";
import { AUDIO_SYSTEMS } from "../audioSystem";
import { makeFakeBackend, type FakeBackend } from "../testing";
import type { EventInstance } from "../events/eventRuntime";
import { _musicStepStats, _resetMusicPlayers, createMusicPlayer, disposeMusicPlayer, musicActive, musicPlanStep, musicPlayers, playerOf } from "./musicSystem";
import { routeGroupEvent } from "./segmentRun";

const step = AUDIO_SYSTEMS.find((s) => s.name === "engine.AudioMusic")!;
const viewWorld = { render: {}, _componentsOfType: () => [] } as unknown as World;
const hiddenWorld = { render: null, _componentsOfType: () => [] } as unknown as World;
const fakeInstance = (group: number) => ({ group }) as unknown as EventInstance;

let fake: FakeBackend;
function rig(): FakeBackend {
  fake = makeFakeBackend();
  setAudioBackend(fake);
  _musicStepStats.early = 0;
  _musicStepStats.plan = 0;
  return fake;
}

afterEach(() => {
  _resetMusicPlayers();
  setAudioBackend(null);
});

describe("engine.AudioMusic (ADR 0166 §6 step 0, ADR 0167 §2)", () => {
  it("is an update-phase system after the lobby and prediction smoothing, before the scripts", () => {
    expect(step.phase).toBe("update");
    expect(step.after).toEqual(["engine.Lobby", "engine.PredictionSmooth"]);
    expect(step.before).toEqual(["engine.UpdateScripts"]);
    expect(AUDIO_SYSTEMS[0]!.name).toBe("engine.Audio");
  });

  it("does nothing in a World with no music and no subscribers: no beginFrame, no work past the guard", () => {
    const b = rig();
    expect(musicActive()).toBe(false);
    for (let k = 0; k < 10_000; k++) step.run(viewWorld, 1 / 60);
    for (let k = 0; k < 10_000; k++) musicPlanStep(b, 1 / 60); // step 9 likewise
    expect(b.beginFrameCalls).toBe(0);
    expect(_musicStepStats).toEqual({ early: 0, plan: 0 });
    expect(b.music!.onGroupEvent).toBeNull();
    expect(musicPlayers()).toHaveLength(0);
  });

  it("runs while a music instance plays, only in the World with the view, and stops when it ends", () => {
    const b = rig();
    const instance = fakeInstance(7);
    const player = createMusicPlayer(instance, { id: "explore", type: "segment" }, { at: 3 });
    expect(createMusicPlayer(instance, { id: "explore", type: "segment" })).toBe(player);
    expect(player.state).toBe("starting");
    expect(player.requestedAt).toBe(3);
    expect(playerOf(instance)).toBe(player);
    step.run(hiddenWorld, 1 / 60);
    expect(_musicStepStats.early).toBe(0);
    step.run(viewWorld, 1 / 60);
    expect(_musicStepStats.early).toBe(1);
    expect(b.music!.onGroupEvent).toBe(routeGroupEvent);
    musicPlanStep(b, 1 / 60);
    expect(_musicStepStats.plan).toBe(1);
    disposeMusicPlayer(player, b);
    expect(b.music!.released).toEqual([7]);
    expect(playerOf(instance)).toBeNull();
    expect(player.state).toBe("stopped");
    step.run(viewWorld, 1 / 60);
    musicPlanStep(b, 1 / 60);
    expect(_musicStepStats).toEqual({ early: 1, plan: 1 });
  });

  it("a player disposed during step 9 doesn't skip the next one", () => {
    const b = rig();
    const a = createMusicPlayer(fakeInstance(1), { id: "a", type: "segment" });
    createMusicPlayer(fakeInstance(2), { id: "b", type: "segment" });
    expect(a.requestedAt).toBeNaN();
    disposeMusicPlayer(a, b);
    musicPlanStep(b, 0);
    expect(musicPlayers().map((p) => p.root.id)).toEqual(["b"]);
  });
});
