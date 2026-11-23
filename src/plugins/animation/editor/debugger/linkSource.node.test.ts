// The live debugger against a connected build (ADR 0376, 0373; T60), end to end over loopback: a headless Engine runs
// a graph Animator and the build's debug link (the animation topic the plugin registered); the editor's debug link
// listens and accepts it (a local build); the link source lists the build's targets with their tables, delivers the
// frames the build recorded (the overlay reads them), and a parameter edit lands at the build's next frame start, so the
// frame evaluated in that step already has the new value. Graph fixtures: the T31 clips on `small.skel`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Skeleton } from "../../../../myco";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import { createTransport } from "../../../../engine/net/Transport";
import "../../../../engine/net/transport/loopback";
import { startDebugLink, type DebugLinkHandle } from "../../../../engine/debugLink/host";
import { EditorDebugLink } from "../../../../editor/debugLink/editorLink";
import { listenAddress } from "../../../../editor/debugLink/debugLinkLogic";
import { skinningMatrices } from "../../runtime/skeletonInstances";
import { createLinkSource, type LinkDebugSource } from "./linkSource";
import { overlayModel } from "./overlayLogic";

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
const PREFS = { listen: true, lan: false, port: 7811 };

let engine: Engine;
let editorLink: EditorDebugLink;
let build: DebugLinkHandle;
let source: LinkDebugSource;
let clock = 0;

/** One build frame, then the editor's poll and the promises it settled. */
async function frame(step = dt): Promise<void> {
  engine.step(step);
  clock += step * 1000;
  editorLink.poll();
  await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "anim/small.skel": fixtureUrl("small.skel").href, idle: fixtureUrl("graph_idle.anim").href, run: fixtureUrl("graph_run.anim").href, "hero.animgraph.json": GRAPH }));
  engine = await Engine.create({ headless: true });
  editorLink = new EditorDebugLink({ transport: () => createTransport("loopback"), autoPoll: false });
  await editorLink.apply(PREFS);
  build = (await startDebugLink(engine, { debug: { link: listenAddress(PREFS) }, name: "Hero build", transport: "loopback" }))!;
});

afterAll(() => {
  source?.dispose();
  build?.close();
  editorLink?.stop();
  engine?.dispose();
});

describe("the link source over a connected build", () => {
  it("accepts the local build and makes it the one the debugger reads", async () => {
    await frame();
    expect(editorLink.pending.value).toEqual([]);
    expect(editorLink.builds.value.map((b) => b.name)).toEqual(["Hero build"]);
    const active = editorLink.active.value!;
    expect(active.name).toBe("Hero build");
    await frame();
    expect(build.state).toBe("accepted");
    source = createLinkSource({ name: active.name, peer: active.peer }, { now: () => clock, refreshMs: 0 });
    expect(source.live).toBe(true);
    expect(source.name).toBe("Hero build");
  });

  it("lists the build's graph Animators, delivers their frames and applies a parameter edit at the next frame start", async () => {
    const node = GameObject.create("Hero");
    node.addComponent(Skeleton, { skeleton: "anim/small.skel" });
    node.addComponent(Animator, { graph: "hero.animgraph.json", parameters: {}, linkedGraphNodes: [], linkedGraphs: [], defaultClip: "" });
    await vi.waitFor(() => {
      engine.step(0);
      expect(skinningMatrices(engine.world, node)).not.toBeNull();
    });
    // Targets come from a request: asked on the first read, there on a later one.
    expect(source.targets("hero.animgraph.json")).toEqual([]);
    await vi.waitFor(async () => {
      await frame();
      expect(source.targets("asset:hero.animgraph.json").map((t) => t.label)).toEqual(["Hero"]);
    });
    const target = source.targets("hero.animgraph.json")[0]!;
    expect(target.tables.parameters).toEqual(["speed"]);
    expect(target.tables.bytes).toBeNull();

    // Frames: subscribed on the first read; every frame the build recorded arrives.
    expect(source.frame(target.id)).toBeNull();
    for (let i = 0; i < 6; i++) await frame();
    const rec = source.recording(target.id)!;
    expect(rec.frames.length).toBeGreaterThanOrEqual(5);
    const indices = rec.frames.map((f) => f.index);
    expect(indices).toEqual(indices.map((_, i) => indices[0]! + i)); // none lost to the rate limit
    const newest = source.frame(target.id)!;
    expect(newest.parameters).toEqual([null]);
    const graph = parseAnimGraph(GRAPH).value;
    expect(overlayModel(graph, target.tables, newest.report).machines.get("machine")?.current).toBe("Idle");
    expect(rec.show(rec.frames[0]!.index)).toBe(false); // a build's poses aren't shown from here

    // An edit is a command: applied at the build's next frame start, so that step's frame has it.
    const last = newest.index;
    expect(source.set(target.id, "speed", 0.9)).toBe(true);
    await frame();
    const after = source.recording(target.id)!.frames.filter((f) => f.index > last);
    expect(after[0]!.parameters[0]).toBeCloseTo(0.9, 6);
    expect(after[0]!.inputs).toContainEqual({ kind: "param", name: "speed", value: expect.closeTo(0.9, 6) });
    for (let i = 0; i < 6; i++) await frame();
    expect(overlayModel(graph, target.tables, source.frame(target.id)!.report).machines.get("machine")?.current).toBe("Run");
    expect(source.set("World#999", "speed", 1)).toBe(false);
    GameObject.destroy(node);
  });

  it("goes off when the build disconnects", async () => {
    const active = editorLink.active.value!;
    editorLink.disconnect(active.id);
    expect(editorLink.builds.value).toEqual([]);
    expect(editorLink.active.value).toBeNull();
    expect(source.live).toBe(false);
    expect(source.frame("x")).toBeNull();
  });
});
