// ADR 0348: the Studio's open take, through the replay store's interface over fake seams: one take open at a time, the
// frame loop runs only while it plays, the curve editor's histogram comes from its PARAM values, and closing undoes it.
import { describe, expect, it } from "vitest";
import { Take } from "../../engine/audio/take/reader";
import type { TakeMeta } from "../../engine/audio/take/types";
import type { ReplayTarget } from "../runtime/takeReplay";
import type { ParameterDef } from "../../engine/audio/parameters";
import { inputHistogram, parameterInputs } from "../screens/curveInputs";
import { HISTOGRAM_BINS, ReplayStore } from "./replay";

const META: TakeMeta = { project: "P", engine: "myco", audioHash: "h", seed: 0, seeded: false, device: "ua", started: new Date(0).toISOString(), duration: 4, emitters: {}, frames: false };
const take = new Take(META, [
  { type: "request", requests: [{ kind: "play", t: 0, instance: 1, path: "a", emitter: null, options: { parameters: { Speed: 0 } } }] },
  { type: "request", requests: [{ kind: "param", t: 1, instance: null, name: "Speed", value: 100 }] },
  { type: "request", requests: [{ kind: "param", t: 2, instance: 1, name: "Speed", value: 100 }] },
]);

function setup() {
  const clock = { t: 0 };
  const frames: (() => void)[] = [];
  const disposed: number[] = [];
  let made = 0;
  const target = (): ReplayTarget => {
    const n = made++;
    return {
      play: () => ({ playing: true, position: null, stop() {}, release() {}, setParameter() {}, trigger() {} }),
      setGlobal() {}, busVolume() {}, snapshot() {}, clearSnapshot() {}, masterVolume: () => 1, listener() {}, seed: () => true,
      dispose: () => disposed.push(n),
    };
  };
  const store = new ReplayStore({
    target,
    clock: { now: () => clock.t },
    frame: (fn) => {
      frames.push(fn);
      return () => frames.splice(frames.indexOf(fn), 1);
    },
  });
  return { store, clock, frames, disposed };
}

const speedInput = [{ id: "param:Speed", name: "Speed", min: 0, max: 200 }];

describe("ReplayStore (ADR 0348)", () => {
  it("opens one take at a time, titled by its file name", () => {
    const { store, disposed } = setup();
    store.openTake("takes/canyon_run_03.sporesample", take);
    expect(store.open.value?.title).toBe("canyon_run_03");
    store.openTake("takes/b.sporesample", take);
    expect(disposed).toEqual([0]);
    expect(store.open.value?.path).toBe("takes/b.sporesample");
    store.moved("takes/b.sporesample", "old/c.sporesample");
    expect(store.open.value?.title).toBe("c");
  });

  it("runs the frame loop only while the take plays, and moves the playhead with the clock", () => {
    const { store, clock, frames } = setup();
    store.openTake("t.sporesample", take);
    expect(frames).toHaveLength(0);
    store.toggle();
    expect(store.playing.value).toBe(true);
    expect(frames).toHaveLength(1);
    clock.t = 1.5;
    frames[0]!();
    expect(store.time.value).toBe(1.5);
    store.toggle();
    expect(frames).toHaveLength(0);
    store.seek(3);
    expect(store.time.value).toBe(3);
  });

  it("gives the curve editor a histogram of the values the take sent, until it closes", () => {
    const { store, disposed } = setup();
    store.openTake("t.sporesample", take);
    const bins = inputHistogram("param:Speed", speedInput)!;
    expect(bins).toHaveLength(HISTOGRAM_BINS);
    expect(bins[0]).toBe(1); // the play's start value
    expect(bins[HISTOGRAM_BINS / 2]).toBe(2); // two sends of 100
    expect(inputHistogram("param:Other", [{ id: "param:Other", name: "Other", min: 0, max: 1 }])).toBeUndefined();
    store.close();
    expect(store.open.value).toBeNull();
    expect(disposed).toEqual([0]);
    expect(inputHistogram("param:Speed", speedInput)).toBeUndefined();
  });

  it("gives the curve editor the game's value at the playhead (Game now), until it closes", () => {
    const { store } = setup();
    store.openTake("t.sporesample", take);
    const live = () => parameterInputs([{ name: "Speed", min: 0, max: 200, default: 0 } as unknown as ParameterDef])[0]!.live;
    expect(live()!()).toBe(0); // the play's start value
    store.seek(1.5);
    expect(live()!()).toBe(100);
    store.close();
    expect(live()).toBeUndefined();
  });
});
