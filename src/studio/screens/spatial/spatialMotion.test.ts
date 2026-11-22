// ADR 0333 (owner: a moving emitter "I do want that to actually work"): while the Spatial screen plays, the Studio's
// World steps every animation frame and the screen's frame loop reads where each emitter is, so a moving emitter travels
// its route and the plan and readout follow it; Stop takes it back to its start. Driven through the screen's own
// actions (`openScene`, `playScene`, `stopAudition`, `editScene`) over a project in memory, a headless Engine on the
// fake audio backend standing in for the Studio's runtime, and animation frames this test fires.
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioTestSceneToJson, parseAudioTestScene } from "../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_FORMAT } from "../../../engine/audio/spatial/testSceneTypes";
import { joinPath, openFolderProject } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { eventKit } from "../../../plugins/audio/runtime/playlists/testKit";
import { createRouter, type HashLocation } from "../../shell/route";
import { provideStudio } from "../../shell/studioServices";
import type { StudioAudioRuntime } from "../../runtime/studioAudioHost";
import { dopplerRatioText, liveDistanceText, livePlace, placeNow, sameMotion, speedText, startFrameLoop, type FrameSource } from "./liveMotion";
import { findObject, moveObjectTo } from "./sceneEdits";
import { editScene, motion, openScene, playing, playScene, scene, stopAudition } from "./spatialScreen";

const kit = eventKit();
const PATH = "audio/scenes/flyby.audioscene.json";

/** Animation frames this test fires: each steps the World first (as the Studio's Engine loop does), then the screen's loop. */
function frames() {
  const queue = new Map<number, (now: number) => void>();
  let next = 1;
  let now = 0;
  let hidden = false;
  const source: FrameSource = {
    request: (cb) => (queue.set(next, cb), next++),
    cancel: (h) => void queue.delete(h),
    hidden: () => hidden,
  };
  const fire = (dt: number) => {
    now += dt * 1000;
    kit.frame(dt);
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) cb(now);
  };
  const hide = (h: boolean) => {
    hidden = h;
    vi.stubGlobal("document", { visibilityState: h ? "hidden" : "visible" }); // what the screen's loop reads
  };
  return { source, fire, pending: () => queue.size, hide };
}

let raf: ReturnType<typeof frames>;

beforeEach(async () => {
  await kit.boot({});
  raf = frames();
  vi.stubGlobal("requestAnimationFrame", raf.source.request);
  vi.stubGlobal("cancelAnimationFrame", raf.source.cancel);
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  const flyby = parseAudioTestScene({
    format: AUDIO_SCENE_FORMAT,
    listeners: [{ id: "p1", name: "Player 1", position: { x: 0, y: 0, z: -4 } }],
    activeListener: "p1",
    emitters: [{ id: "car", name: "Car", kind: "moving", route: [{ x: -20, z: 0 }, { x: 20, z: 0 }], height: 1, speed: 10, start: 0.25, loop: false, sound: "a.wav", volume: 0 }],
  }).scene;
  fs.files.set(joinPath(ROOT, PATH), JSON.stringify(audioTestSceneToJson(flyby)));
  currentProject.value = await openFolderProject(fs, ROOT);
  const hash: HashLocation = { get: () => "#/spatial", set: () => {}, listen: () => () => {} };
  const runtime = { playable: signal(true), state: signal({ kind: "running" }) } as unknown as StudioAudioRuntime;
  provideStudio({ router: createRouter(hash), runtime });
  openScene(PATH);
});

afterEach(() => {
  stopAudition();
  currentProject.value = null;
  status.value = null;
  vi.unstubAllGlobals();
});

/** The screen's Play; the player is built once the (absent) base scene is settled, a task later. */
async function start(): Promise<void> {
  playScene();
  await new Promise((r) => setTimeout(r, 0));
  expect(status.value).toBeNull();
}

const car = () => findObject(scene.value!, "car")!;
const carNow = () => motion.value.find((m) => m.id === "car");

describe("a moving emitter while the Spatial screen plays", () => {
  it("travels its route each animation frame, and the plan follows it", async () => {
    expect(placeNow(car(), motion.value)).toMatchObject({ x: -10, z: 0 }); // stopped: its start, a quarter along
    await start();
    expect(playing.value).toBe(true);
    for (let i = 0; i < 60; i++) raf.fire(1 / 60); // a second at 10 m/s
    const p = carNow()!;
    expect(p.position.x).toBeCloseTo(0, 4);
    expect(p.position.y).toBe(1);
    expect(p.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(livePlace(car(), motion.value)).toMatchObject({ position: { x: expect.closeTo(0, 4) }, direction: { x: 1, z: 0 }, speed: 10 });
    expect(placeNow(car(), motion.value)!.x).toBeCloseTo(0, 4);
    // The voice the runtime plays is where the plan draws it.
    expect(kit.fake.voices.find((v) => v.request.path === "a.wav")!.position!.x).toBeCloseTo(0, 4);
  });

  it("stops at the end of a route that doesn't loop, its speed 0", async () => {
    await start();
    for (let i = 0; i < 4 * 60; i++) raf.fire(1 / 60); // 40 m: past the 30 m left
    expect(carNow()).toMatchObject({ position: { x: 20 }, speed: 0 });
    expect(livePlace(car(), motion.value)!.direction).toBeNull();
  });

  it("Stop takes it back to its start and ends the frame loop", async () => {
    await start();
    for (let i = 0; i < 30; i++) raf.fire(1 / 60);
    expect(carNow()!.position.x).toBeGreaterThan(-10);
    stopAudition();
    expect(motion.value).toEqual([]);
    expect(raf.pending()).toBe(0);
    expect(placeNow(car(), motion.value)).toMatchObject({ x: -10, z: 0 });
    // Playing again starts from the start.
    await start();
    raf.fire(0);
    expect(carNow()!.position.x).toBeCloseTo(-10, 4);
  });

  it("a new start while playing (scrubbing) puts it there", async () => {
    await start();
    for (let i = 0; i < 30; i++) raf.fire(1 / 60);
    expect(editScene("Edit emitter", (s) => moveObjectTo(s, "car", { x: 15, z: 0 }))).toBe(true); // drag its start on the path
    raf.fire(0);
    expect(carNow()!.position.x).toBeCloseTo(15, 4);
  });

  it("the plan stands still while the window is hidden", async () => {
    await start();
    raf.fire(1 / 60);
    const before = carNow()!.position.x;
    raf.hide(true);
    raf.fire(1 / 60);
    expect(carNow()!.position.x).toBe(before); // the screen's loop skipped the frame
    raf.hide(false);
    raf.fire(1 / 60);
    expect(carNow()!.position.x).toBeGreaterThan(before);
  });
});

describe("the screen's frame loop", () => {
  it("passes each frame's real seconds, 0 after a hidden spell, and nothing once stopped", async () => {
    const f = frames();
    const seen: number[] = [];
    const stop = startFrameLoop((dt) => seen.push(Math.round(dt * 1000)), f.source);
    f.fire(0.016);
    f.fire(0.020);
    f.hide(true);
    f.fire(0.5);
    f.hide(false);
    f.fire(0.016);
    f.fire(0.016);
    stop();
    f.fire(0.016);
    expect(seen).toEqual([0, 20, 0, 16]);
    expect(f.pending()).toBe(0);
  });
});

describe("the readout of a moving emitter", () => {
  const row = (doppler: number | null, playing = true) => ({ id: "car", kind: "emitter" as const, playing, rendered: "panned" as const, distance: 10, occlusion: null, doppler, dopplerCents: null });

  it("shows the Doppler ratio and its cents, its speed and its live distance", () => {
    expect(dopplerRatioText(row(343 / 323))).toBe("×1.062 · +104 ct");
    expect(dopplerRatioText(row(343 / 363))).toBe("×0.945 · −98 ct");
    expect(dopplerRatioText(row(1))).toBe("×1.000");
    expect(dopplerRatioText(row(1.05, false))).toBe("—");
    expect(dopplerRatioText(row(null))).toBe("—");
    expect(dopplerRatioText(undefined)).toBe("—");
    expect(speedText(12)).toBe("12.0 m/s");
    expect(speedText(0)).toBe("Stopped");
    expect(liveDistanceText({ x: 3, y: 0, z: 4 }, { x: 0, y: 0, z: 0 })).toBe("5.0 m");
  });

  it("redraws only when something moved", () => {
    const a = [{ id: "car", position: { x: 1, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, speed: 10 }];
    expect(sameMotion(a, [{ ...a[0]!, position: { x: 1, y: 0, z: 0 } }])).toBe(true);
    expect(sameMotion(a, [{ ...a[0]!, position: { x: 1.1, y: 0, z: 0 } }])).toBe(false);
    expect(sameMotion(a, [])).toBe(false);
  });
});
