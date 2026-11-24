// The animation debugger's take source (ADR 0348, 0373; T73), end to end in a headless Engine: a run of a graph Animator is
// recorded through the take source into a real take file (the audio take recorder's framing), the file is read back
// (`takeControl.ts` `readTake`), and the take source drives the overlay and live-parameter logic the graph editor uses:
// the overlay names the recorded report, parameters are read-only, a recorded pose shows on the live character bit for
// bit, and a graph that changed since the recording is said so and shows no poses. Time comes from `engine.step(dt)` only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../myco";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import type { World } from "../../../../engine/core/World";
import { CAPTURE_RECORD_HEAD_BYTES, RecordType, encodeRecords, recordPayloadBytes, type CaptureRecordInit, type IndexEntry } from "../../../audio/runtime/capture/format";
import type { RingSpan } from "../../../audio/runtime/capture/ring";
import { assembleTakeFile, type SaveTake } from "../../../audio/runtime/capture/save";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeBytesPlaceholder, statusBytes } from "../../../audio/runtime/capture/testSupport";
import { TakeRecorder, type TakeRecorderRing } from "../../../audio/runtime/capture/takeRecorder";
import { animationTakeSource } from "../../runtime/features/debug/takeRecord";
import { skinningMatrices } from "../../runtime/skeletonInstances";
import { liveParameterRows } from "./liveParameterLogic";
import { overlayModel } from "./overlayLogic";
import { takeLabel } from "./TakeBar";
import { readTake } from "./takeControl";
import { createTakeSource, type TakeSession } from "./takeSource";

const fixtureUrl = (name: string) => new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url);
const dt = 1 / 30;
const GRAPH = {
  format: "myco.animgraph-source@1",
  output: "machine",
  parameters: [{ name: "speed", type: "float" }],
  nodes: [
    { id: "idle", family: "sources", kind: "clipPlayer", params: { clip: "asset:idle" } },
    { id: "run", family: "sources", kind: "clipPlayer", params: { clip: "asset:run" } },
    {
      id: "machine", family: "logic", kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          { name: "Idle", root: "idle", transitions: [{ to: "Run", if: { param: "speed", op: ">", value: 0.5 }, duration: 0.1 }] },
          { name: "Run", root: "run", transitions: [{ to: "Idle", if: { param: "speed", op: "<=", value: 0.5 }, duration: 0.1 }] },
        ],
      },
    },
  ],
};
/** The same parameters and states with a different threshold: the graph's bytes differ, its names don't. */
const RETUNED = { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "machine" ? { ...n, machine: { ...(n as { machine: object }).machine, states: [
  { name: "Idle", root: "idle", transitions: [{ to: "Run", if: { param: "speed", op: ">", value: 0.8 }, duration: 0.1 }] },
  { name: "Run", root: "run", transitions: [{ to: "Idle", if: { param: "speed", op: "<=", value: 0.8 }, duration: 0.1 }] },
] } } : n)) };

let engine: Engine;
let world: World;

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "anim/small.skel": fixtureUrl("small.skel").href,
    idle: fixtureUrl("graph_idle.anim").href,
    run: fixtureUrl("graph_run.anim").href,
    "hero.animgraph.json": GRAPH,
    "retuned.animgraph.json": RETUNED,
  }));
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => engine?.dispose());

async function character(name: string, graph: string): Promise<{ node: GameObject; anim: Animator }> {
  const node = GameObject.create(name);
  node.addComponent(Skeleton, { skeleton: "anim/small.skel" });
  const anim = node.addComponent(Animator, { graph, parameters: {}, linkedGraphNodes: [], linkedGraphs: [], defaultClip: "" });
  await vi.waitFor(() => {
    engine.step(0);
    expect(skinningMatrices(world, node)).not.toBeNull();
  });
  return { node, anim };
}

/** The audio take recorder's ring, as the audio tests stand it in. */
class Ring implements TakeRecorderRing {
  seq = 1;
  readonly ringBytes = 1024 * 1024;
  stamp() { return { seq: this.seq++, epoch: 0, frame: 768 }; }
  marker(): void {}
}

/** A take file of `frames` frames of `anim`'s scripted run through the take source and the audio take recorder; and the poses the World showed. */
async function record(node: GameObject, anim: Animator, frames: number): Promise<{ file: Uint8Array; poses: Float32Array[] }> {
  const ring = new Ring();
  const early: CaptureRecordInit[] = [{ type: RecordType.EPOCH, epoch: 0, seq: ring.seq++, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, perfMs: 1000 } }];
  early.push({ type: RecordType.KEYFRAME, epoch: 0, seq: ring.seq++, frame: 768, payload: keyframeBytesPlaceholder() });
  early.push({ type: RecordType.STATUS, epoch: 0, seq: ring.seq++, frame: 768, payload: statusBytes(768) });
  const recorder = new TakeRecorder(ring, { now: () => 0 });
  const run = animationTakeSource.start({ engine, get seconds() { return recorder.seconds; }, write: (type, payload) => recorder.writeExtension(type, payload) });
  const poses: Float32Array[] = [];
  for (let i = 0; i < frames; i++) {
    anim.set("speed", i < 20 ? 0.1 : i < 70 ? 0.9 : 0.1);
    engine.step(dt);
    poses.push(skinningMatrices(world, node)!.slice());
  }
  run.stop();
  const { requests, section } = recorder.finish({ seed: 0, seeded: false, audioHash: "" });
  const keyframes: IndexEntry[] = [];
  let off = 0;
  for (const r of early) {
    if (r.type === RecordType.KEYFRAME) keyframes.push({ epoch: r.epoch, frame: r.frame, byteOffset: off, seq: r.seq });
    off += CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(r);
  }
  const span: RingSpan = { bytes: encodeRecords(early), recordCount: early.length, keyframes, firstFrame: 0, sampleRate: SAMPLE_RATE, firstSeq: 1 };
  const take: SaveTake = { header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span, truncatedFromSeq: 0, requests };
  return { file: assembleTakeFile(take), poses };
}

describe("the take source", () => {
  it("opens a take file and drives the overlay and the read-only parameters with the recorded frames", async () => {
    const { node, anim } = await character("Hero", "hero.animgraph.json");
    const { file } = await record(node, anim, 90);
    const take = await readTake(file);
    if ("refused" in take) throw new Error(take.refused);
    const source = createTakeSource(take, { animator: () => anim, redraw: () => {} }, "run_01.sporesample");
    expect(takeLabel("takes/run_01.sporesample")).toBe("run_01");
    expect(source.name).toBe("Take run_01.sporesample");
    expect(source.live && source.paused && source.readOnly).toBe(true);
    const targets = source.targets("hero.animgraph.json");
    expect(targets.map((t) => t.label)).toEqual(["Hero"]);
    expect(source.targets("other.animgraph.json")).toEqual([]);
    const target = targets[0]!;
    const rec = source.recording(target.id)!;
    expect(rec.frames).toHaveLength(90);
    expect(rec.isKeyframe(rec.frames[30]!.index)).toBe(true);
    expect(rec.isKeyframe(rec.frames[31]!.index)).toBe(false);
    expect(source.frame(target.id)).toBe(rec.frames[89]);

    const graph = parseAnimGraph(GRAPH).value;
    // At the start: Idle, its transition waiting on `speed > 0.5` (0.10 now).
    const early = overlayModel(graph, target.tables, rec.frames[5]!.report);
    expect(early.machines.get("machine")?.current).toBe("Idle");
    expect(early.transitions.get("machine/Idle/0")).toEqual({ blocker: "condition", why: "Its condition is false: speed > 0.5 fails, because speed is 0.10." });
    // Later: the recorded speed took the machine into Run.
    expect(overlayModel(graph, target.tables, rec.frames[60]!.report).machines.get("machine")?.current).toBe("Run");
    // The parameter rows show the recorded values; editing is refused.
    const rows = liveParameterRows(graph, target.tables, rec.frames[60]!);
    expect(rows.find((r) => r.name === "speed")?.value).toBeCloseTo(0.9, 6);
    expect(source.set(target.id, "speed", 1)).toBe(false);
    expect(source.notes?.(target.id)).toEqual([]); // the project is as recorded
    source.dispose();
    expect(source.live).toBe(false);
    GameObject.destroy(node);
    engine.step(0);
  });

  it("shows a recorded pose on the live character bit for bit, and puts the live pose back", async () => {
    const { node, anim } = await character("Posed", "hero.animgraph.json");
    const { file, poses } = await record(node, anim, 90);
    const take = await readTake(file);
    if ("refused" in take) throw new Error(take.refused);
    const redraw = vi.fn();
    const source = createTakeSource(take, { animator: () => anim, redraw }, "t.sporesample");
    const rec = source.recording(source.targets()[0]!.id)!;
    const live = skinningMatrices(world, node)!.slice();
    for (const i of [0, 29, 30, 45, 89, 10]) {
      expect(rec.show(rec.frames[i]!.index), `frame ${i}`).toBe(true);
      expect(rec.showing).toBe(rec.frames[i]!.index);
      expect(Array.from(skinningMatrices(world, node)!), `frame ${i}`).toEqual(Array.from(poses[i]!));
    }
    expect(rec.show(null)).toBe(true);
    expect(rec.showing).toBeNull();
    expect(Array.from(skinningMatrices(world, node)!)).toEqual(Array.from(live));
    source.redraw();
    expect(redraw).toHaveBeenCalledTimes(1);
    source.dispose();
    GameObject.destroy(node);
    engine.step(0);
  });

  it("says what changed when the graph differs from the recording, and shows no pose rather than a wrong one", async () => {
    const { node, anim } = await character("Changed", "hero.animgraph.json");
    const { file } = await record(node, anim, 40);
    const take = await readTake(file);
    if ("refused" in take) throw new Error(take.refused);
    const other = await character("Retuned", "retuned.animgraph.json"); // same names, another threshold
    const session: TakeSession = { animator: () => other.anim, redraw: () => {} };
    const source = createTakeSource(take, session, "t.sporesample");
    const id = source.targets()[0]!.id;
    expect(source.compat(id).poses).toBe(false);
    expect(source.notes?.(id)?.[0]).toContain("logic changed");
    const rec = source.recording(id)!;
    const before = skinningMatrices(world, other.node)!.slice();
    expect(rec.show(rec.frames[10]!.index)).toBe(false);
    expect(Array.from(skinningMatrices(world, other.node)!)).toEqual(Array.from(before));
    // The recorded graph states still show.
    expect(overlayModel(parseAnimGraph(GRAPH).value, source.targets()[0]!.tables, rec.frames[10]!.report).machines.get("machine")?.current).toBe("Idle");
    // No Animator running the graph: the notes say to play and pause; nothing shows.
    const idle = createTakeSource(take, { animator: () => null, redraw: () => {} }, "t.sporesample");
    expect(idle.notes?.(id)?.[0]).toContain("play the scene and pause it");
    expect(idle.recording(id)!.show(rec.frames[10]!.index)).toBe(false);
    idle.dispose();
    source.dispose();
    GameObject.destroy(other.node);
    GameObject.destroy(node);
    engine.step(0);
  });

  it("refuses a file that isn't a take, and a take with no animation in it", async () => {
    const notTake = await readTake(new Uint8Array([1, 2, 3, 4]));
    expect(notTake).toEqual({ refused: expect.stringContaining("isn't a take the editor can read") });
    // A take the audio recorder wrote without any animation records.
    const ring = new Ring();
    const recorder = new TakeRecorder(ring, { now: () => 0 });
    const { requests, section } = recorder.finish({ seed: 0, seeded: false, audioHash: "" });
    const early: CaptureRecordInit[] = [{ type: RecordType.EPOCH, epoch: 0, seq: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, perfMs: 1000 } }];
    const span: RingSpan = { bytes: encodeRecords(early), recordCount: 1, keyframes: [], firstFrame: 0, sampleRate: SAMPLE_RATE, firstSeq: 0 };
    const file = assembleTakeFile({ header: SAMPLE_HEADER, meta: { ...SAMPLE_META, take: section }, span, truncatedFromSeq: 0, requests });
    expect(await readTake(file)).toEqual({ refused: expect.stringContaining("no animation") });
  });
});
