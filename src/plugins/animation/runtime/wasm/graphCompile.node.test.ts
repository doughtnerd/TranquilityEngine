// ADR 0372 (T30): graphs compiled by the TypeScript compiler (`src/engine/animation/graphCompile.ts`) run in the
// committed wasm. (1) The T31 fixture `loco.animgraph` (written by native/anim/crates/anim-wasm/tests/graph_fixtures.rs)
// is reproduced byte for byte from its JSON source `fixtures/loco.animgraph.json`. (2) A graph with a state machine, a
// 2D blend space and a slot is compiled, loaded, bound by the compile's bindings, and run frame by frame with the
// `graph` family's records; the states it enters (graph change records) and its slot play's end are checked by name
// through the compile's tables. (3) A graph holding every node kind of the catalogue loads without unknown nodes (each
// block meets the core's load-time checks: rig chain limits, counts) and evaluates.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { familyOfKind, GRAPH_FAMILIES, GRAPH_NODE_KINDS, type AnimGraph, type GraphNode, type GraphParameter, type NodeParamValue } from "../../../../engine/animation/animGraph";
import { compileAnimGraph, compileAnimGraphSource, type CompiledAnimGraph } from "../../../../engine/animation/graphCompile";
import * as core from "./wire/core";
import * as graph from "./wire/graph";
import { commands_ptr, create_instance, evaluate, graph_bind, graph_change_count, graph_changes_ptr, init, initSync, last_status, load_clip, load_graph, load_mask, load_skeleton, write_inputs } from "./myco_anim.js";

type ScalarType = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32";
interface RecordLayout {
  readonly opcode: number;
  readonly version: number;
  readonly stride: number;
  readonly fields: Readonly<Record<string, { readonly offset: number; readonly type: ScalarType }>>;
}

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function put(view: DataView, at: number, layout: RecordLayout, values: Record<string, number>): number {
  view.setUint16(at + core.WIRE_HEADER.opcode, layout.opcode, true);
  view.setUint16(at + core.WIRE_HEADER.version, layout.version, true);
  for (const [name, f] of Object.entries(layout.fields)) {
    const v = values[name] ?? 0;
    if (f.type === "f32") view.setFloat32(at + f.offset, v, true);
    else view.setUint32(at + f.offset, v >>> 0, true);
  }
  return layout.stride;
}
function get(view: DataView, at: number, layout: RecordLayout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, f] of Object.entries(layout.fields)) out[name] = f.type === "f32" ? view.getFloat32(at + f.offset, true) : view.getUint32(at + f.offset, true);
  return out;
}

const param = (name: string, type: GraphParameter["type"], def: GraphParameter["default"] = type === "bool" ? false : 0): GraphParameter => ({ name, type, default: def, replicate: false, predicted: false, computed: false });
const node = (id: string, kind: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, family: familyOfKind(kind)!, kind, name: "", inputs: [], params: {}, ...extra });
const graphOf = (parameters: GraphParameter[], nodes: GraphNode[], output: string): AnimGraph => ({ format: "myco.animgraph-source@1", name: "", skeleton: null, output, parameters, nodes, layers: [] });

describe("compiled graphs in the core", () => {
  const exports = initSync({ module: readFileSync(new URL("./myco_anim_bg.wasm", import.meta.url)) });
  const memory = (): DataView => new DataView(exports.memory.buffer);
  const initBytes = new Uint8Array(core.INIT.stride);
  put(new DataView(initBytes.buffer), 0, core.INIT, { maxInstances: 8, maxBones: 64, arenaInitialBytes: 1 << 22 });
  init(initBytes);
  const skel = load_skeleton(file("small.skel"));
  const bones = 8;
  const clips: Record<string, number> = {
    "clips/idle.anim": load_clip(file("graph_idle.anim")),
    "clips/walk.anim": load_clip(file("graph_walk.anim")),
    "clips/run.anim": load_clip(file("graph_run.anim")),
  };
  const shot = load_clip(file("graph_shot.anim"));
  const masks: Record<string, number> = { "masks/upper.mask.json": load_mask(new Float32Array(Array.from({ length: bones }, (_, i) => (i >= 3 ? 1 : 0)))) };

  /** Loads a compile's bytes and binds its string ids (clips and masks by project path). */
  function loadCompiled(out: CompiledAnimGraph): number {
    expect(out.bytes, JSON.stringify(out.problems)).not.toBeNull();
    const g = load_graph(out.bytes!);
    expect(g, `last status ${last_status()}`).not.toBe(0);
    for (const b of out.bindings) {
      const key = b.ref.replace(/^asset:/, "");
      const asset = b.asset === "clip" ? clips[key] : b.asset === "mask" ? masks[key] : undefined;
      if (asset !== undefined) expect(graph_bind(g, b.stringId, asset)).toBe(core.STATUS_OK);
    }
    return g;
  }

  it("reproduces the T31 fixture loco.animgraph byte for byte from its JSON source", () => {
    const src = JSON.parse(readFileSync(new URL("./fixtures/loco.animgraph.json", import.meta.url), "utf8")) as unknown;
    const out = compileAnimGraphSource(src);
    expect(out.problems).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.bytes).toEqual(file("loco.animgraph"));
    // The fixture's string ids the Node test binds (graph_expected.json's "binds").
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/graph_expected.json", import.meta.url), "utf8")) as { binds: Record<string, number> };
    expect(Object.fromEntries(out.bindings.map((b) => [b.ref.replace("asset:", ""), b.stringId]))).toEqual(fixture.binds);
  });

  it("runs a compiled state machine with a 2D blend space and a slot, entering states by name", () => {
    const g = graphOf(
      [param("speed", "float"), param("x", "float"), param("y", "float")],
      [
        node("idle", "clipPlayer", { params: { clip: "asset:clips/idle.anim" } }),
        node("walk", "clipPlayer", { params: { clip: "asset:clips/walk.anim" } }),
        node("run", "clipPlayer", { params: { clip: "asset:clips/run.anim" } }),
        node("hop", "clipPlayer", { params: { clip: "asset:clips/run.anim", loop: false } }),
        node("move", "blendSpace2D", { inputs: ["idle", "walk", "run"], params: { x: "x", y: "y", coords: [0, 0, 0, 1, 1, 1], sync: true } }),
        node("loco", "stateMachine", {
          machine: {
            entry: "Idle",
            states: [
              { name: "Idle", root: "idle", exit: false, transitions: [{ id: "go", to: "Move", if: { param: "speed", op: ">", value: 0.5 }, when: "now", how: "crossfade", duration: 0.2, shape: "smoothstep", bridge: null, interrupt: "never" }] },
              { name: "Move", root: "move", exit: false, transitions: [{ id: "stop", to: "Idle", if: { param: "speed", op: "<=", value: 0.5 }, when: "now", how: "inertialize", duration: 0.2, shape: "linear", bridge: null, interrupt: "never" }] },
              { name: "Hop", root: "hop", exit: false, transitions: [{ id: "", to: "Move", if: null, when: "exit", how: "crossfade", duration: 0.1, shape: "linear", bridge: null, interrupt: "never" }] },
            ],
            anyState: [{ id: "hopping", to: "Hop", if: { request: "Hop", op: "==", value: true }, when: "now", how: "cut", duration: 0, shape: "linear", bridge: null, interrupt: "never" }],
          },
        }),
        node("upper", "slot", { inputs: ["loco"], params: { mask: "asset:masks/upper.mask.json" }, slot: { name: "UpperBody", group: null } }),
        node("out", "inertialize", { inputs: ["upper"] }),
      ],
      "out",
    );
    const out = compileAnimGraph(g);
    expect(out.problems).toEqual([]);
    const gh = loadCompiled(out);
    expect(last_status()).toBe(core.STATUS_OK);
    const h = create_instance(0, skel, gh);
    expect(h).not.toBe(0);

    const p = (name: string) => out.parameters.indexOf(name);
    const f32 = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
    const script: Record<number, [RecordLayout, Record<string, number>][]> = {
      2: [[graph.SET_PARAM, { param: p("speed"), paramType: 0, w0: f32(1) }], [graph.SET_PARAM, { param: p("y"), paramType: 0, w0: f32(0.7) }]],
      8: [[graph.SLOT_PLAY, { slot: out.slots.indexOf("UpperBody"), clip: shot, playId: 7, blendIn: 0.1, blendOut: 0, speed: 1, start: 0, end: 0.4 }]],
      10: [[graph.REQUEST, { name: out.strings.indexOf("Hop"), lifetime: 0.2 }]],
      45: [[graph.SET_PARAM, { param: p("speed"), paramType: 0, w0: f32(0) }]],
    };
    const entered: [number, string][] = [];
    const slotEnds: [number, number][] = [];
    const states = out.machines[0].states;
    const dt = Math.fround(1 / 30);
    for (let f = 0; f < 50; f++) {
      const view = memory();
      const start = commands_ptr();
      let at = start;
      for (const [layout, values] of script[f] ?? []) at += put(view, at, layout, { ...values, instance: h });
      expect(write_inputs(at - start)).toBe((script[f] ?? []).length);
      evaluate(0, core.PASS_NORMAL, dt, dt);
      const v = memory();
      for (let i = 0; i < graph_change_count(); i++) {
        const c = get(v, graph_changes_ptr() + i * graph.GRAPH_CHANGE.stride, graph.GRAPH_CHANGE);
        if (c.kind === graph.GRAPH_STATE_ENTERED) entered.push([f, states[c.value!]]);
        if (c.kind === graph.GRAPH_SLOT_FINISHED) slotEnds.push([f, c.value!]);
      }
    }
    // Frames are the product's clock (dt = 1/30): Move as the speed rises; Hop on the request (an any-state cut); back
    // to Move at the hop clip's end (0.7 s, played once: 21 frames); Idle when the speed drops.
    expect(entered).toEqual([[2, "Move"], [10, "Hop"], [31, "Move"], [45, "Idle"]]);
    // The slot's section [0, 0.4) (12 frames) played from frame 8 reports its end, once. (No blend-out: with one, the
    // core's slot leaves its play during the blend-out and never reports it finished, contrary to `slots.rs`'s docs;
    // reported in T30.)
    expect(slotEnds).toEqual([[19, 7]]);
  });

  it("loads a graph holding every catalogue kind without unknown nodes, and evaluates it", () => {
    const minimal: Record<string, Partial<GraphNode>> = {
      blendSpace1D: { inputs: ["a", "b"], params: { x: "f", coords: [0, 1] } },
      blendSpace2D: { inputs: ["a", "b", "c"], params: { x: "f", y: "f", coords: [0, 0, 1, 0, 0, 1] } },
      stateMachine: { machine: { entry: "S", states: [{ name: "S", root: "a", exit: false, transitions: [] }], anyState: [] } },
      random: { inputs: ["a", "b"], params: { weights: [1, 2] } },
      chooser: { chooser: { rows: [{ if: { param: "on", op: "==", value: true }, result: "a" }], fallback: "b" } },
      blend2: { inputs: ["a", "b"], params: { weight: "f" } },
      crossfade: { inputs: ["a", "b"] },
      layer: { inputs: ["a", "b"], params: { mask: "asset:masks/upper.mask.json" } },
      blendEnum: { inputs: ["a", "b"], params: { value: "i" } },
      blendBool: { inputs: ["a", "b"], params: { value: "on" } },
      additive: { inputs: ["a", "b"] },
      mirror: { inputs: ["a"], params: { table: [0, 1, 2, 3, 4, 5, 6, 7] } },
      slot: { inputs: ["a"], slot: { name: "S", group: null } },
      linked: { linked: { name: "L", graph: null } },
      twoBoneIk: { inputs: ["a"], params: { chain: "LeftLeg", target: "foot", pole: "knee" } },
      ccd: { inputs: ["a"], params: { bones: [1, 2, 3], target: "hand" } },
      fabrik: { inputs: ["a"], params: { bones: [1, 2, 3], target: "hand" } },
      fullBodyIk: { inputs: ["a"], params: { leftFootTarget: "foot" } },
      lookAt: { inputs: ["a"], params: { bones: [1, 2], target: "look" } },
      aim: { inputs: ["a"], params: { bones: [1], aimBone: 2, target: "look" } },
      grounder: { inputs: ["a"], params: { pelvis: 0, legs: [1, 2, 3, 4, 5, 6] } },
      springChain: { inputs: ["a"], params: { bones: [3, 4, 5], colliderBones: [0], colliderShapes: ["capsule"], colliderA: [0, 0, 0], colliderB: [0, 1, 0], colliderRadius: [0.1] } },
      limitRotation: { inputs: ["a"], params: { bones: [1, 2] } },
      strideWarp: { inputs: ["a"], params: { pelvis: 0, legs: [1, 2, 3] } },
      orientationWarp: { inputs: ["a"], params: { pelvis: 0, bones: [1, 2], shares: [0.5, 0.5] } },
      distanceMatch: { inputs: ["a"], params: { parameter: "f" } },
      physicsBlend: { inputs: ["a", "b"] },
      plugin: { inputs: ["a"], params: { module: "asset:plugins/sample.wasm" } },
    };
    const nodes: GraphNode[] = [node("a", "clipPlayer", { params: { clip: "asset:clips/idle.anim" } }), node("b", "clipPlayer"), node("c", "clipPlayer")];
    for (const family of GRAPH_FAMILIES) {
      for (const kind of GRAPH_NODE_KINDS[family]) {
        const extra = minimal[kind] ?? (["inertialize", "timeScale", "syncGroup", "notifyGate", "copy", "limitPosition", "damp", "motionWarp"].includes(kind) ? { inputs: ["a"] } : {});
        nodes.push(node(`n_${kind}`, kind, extra as Partial<GraphNode> & { params?: Record<string, NodeParamValue> }));
      }
    }
    const out = compileAnimGraph(graphOf([param("f", "float", 0.5), param("i", "int"), param("on", "bool")], nodes, "n_blend2"));
    expect(out.problems.filter((x) => x.severity === "error")).toEqual([]);
    const gh = loadCompiled(out);
    expect(last_status()).toBe(core.STATUS_OK);
    const h = create_instance(0, skel, gh);
    expect(h, `last status ${last_status()}`).not.toBe(0);
    expect(write_inputs(0)).toBe(0);
    expect(evaluate(0, core.PASS_NORMAL, 1 / 30, 1 / 30)).toBeGreaterThanOrEqual(0);
  });
});
