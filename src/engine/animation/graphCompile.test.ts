// The graph compiler (`myco.animgraph-source@1` → `myco.animgraph@1`, ADR 0372, T30), through `compileAnimGraph`:
// representative graphs compile and read back through T03t's header reader (`readAnimationHeader`) and, record by
// record, against `anim-format/src/graph.rs`'s layout (parameters with flags, a children-first node order, machines with
// any-state then priority-ordered transitions, every when / how, bridges, interrupt lists, prefix-order condition trees,
// slots, linked graphs with capacities, choosers, layers stacked over the output, the string table and the asset
// bindings); every node kind's parameter block has the Rust word table's length and its words where the Rust module
// puts them; each error class gives a problem with its path and never throws.
import { describe, expect, it } from "vitest";
import { shapeLevel } from "../audio/playlist/fadeShapes";
import { familyOfKind, GRAPH_FAMILIES, GRAPH_NODE_KINDS, type AnimGraph, type GraphNode, type GraphParameter, type MachineState, type Transition } from "./animGraph";
import { readAnimationHeader, type BinarySection } from "./binaryHeader";
import { AUDIO_FADE_SHAPE, compileAnimGraph, compileAnimGraphSource, type CompiledAnimGraph } from "./graphCompile";

const NONE = 0xffffffff;
const f32 = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
const fromBits = (w: number) => new Float32Array(new Uint32Array([w]).buffer)[0];

const param = (name: string, type: GraphParameter["type"], extra: Partial<GraphParameter> = {}): GraphParameter => ({ name, type, default: type === "bool" ? false : type === "vec3" ? [0, 0, 0] : 0, replicate: false, predicted: false, computed: false, ...extra });
const node = (id: string, kind: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, family: familyOfKind(kind)!, kind, name: "", inputs: [], params: {}, ...extra });
const tr = (to: string, extra: Partial<Transition> = {}): Transition => ({ id: "", to, if: null, when: "now", how: "crossfade", duration: 0.2, shape: "linear", bridge: null, interrupt: "never", ...extra });
const state = (name: string, root: string | null, transitions: Transition[] = [], exit = false): MachineState => ({ name, root, exit, transitions });
const graphOf = (nodes: GraphNode[], output: string | null, extra: Partial<AnimGraph> = {}): AnimGraph => ({ format: "myco.animgraph-source@1", name: "", skeleton: null, output, parameters: [], nodes, layers: [], ...extra });

/** The file's records, read with the layout `graph.rs` documents (test-side reader). */
function decode(bytes: Uint8Array) {
  const h = readAnimationHeader(bytes, "myco.animgraph@1");
  if (!h.ok) throw new Error(h.problem);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sec = (name: string): BinarySection => h.header.sections.find((s) => s.name === name)!;
  const words = (name: string, stride: number): number[][] => {
    const s = sec(name);
    return Array.from({ length: s.count }, (_, i) => Array.from({ length: stride / 4 }, (_, k) => v.getUint32(s.offset + i * stride + 4 * k, true)));
  };
  const st = sec("STRINGS");
  const ends = Array.from({ length: st.count + 1 }, (_, i) => v.getUint32(st.offset + 4 * i, true));
  const chars = st.offset + 4 * (st.count + 1);
  const strings = Array.from({ length: st.count }, (_, i) => new TextDecoder().decode(bytes.subarray(chars + ends[i], chars + ends[i + 1])));
  const inputs = words("NODE_INPUTS", 4).map((w) => w[0]);
  const blocks = words("PARAM_BLOCKS", 4).map((w) => w[0]);
  const nodes = words("NODES", 24).map((w) => ({ family: w[0] & 0xff, kind: w[0] >>> 16, inputs: inputs.slice(w[1], w[1] + w[2]), words: blocks.slice(w[3], w[3] + w[4]), name: w[5] }));
  const params = words("PARAMS", 24).map((w) => ({ name: strings[w[0]], type: w[1] & 0xff, flags: (w[1] >>> 8) & 0xff, value: w.slice(2) }));
  const transitions = words("TRANSITIONS", 40).map((w) => ({ target: w[0], condition: w[1], when: w[2] & 0xff, how: (w[2] >>> 8) & 0xff, mode: (w[2] >>> 16) & 0xff, whenValue: w[3], duration: fromBits(w[4]), shape: w[5], bridge: w[6], first: w[7], count: w[8] }));
  const conds = words("CONDITION_NODES", 16).map((w) => ({ code: w[0] & 0xff, op: (w[0] >>> 8) & 0xff, src: (w[0] >>> 16) & 0xff, operand: w[1], value: w[2] }));
  return {
    header: h.header, strings, nodes, params, transitions, conds,
    machines: words("MACHINES", 32), states: words("STATES", 24), interrupts: words("INTERRUPTS", 4).map((w) => w[0]), programs: words("CONDITION_PROGRAMS", 8),
    slots: words("SLOTS", 16), linked: words("LINKED", 16), layers: words("LAYERS", 24), choosers: words("CHOOSERS", 16), rows: words("CHOOSER_ROWS", 8),
    info: words("INFO", 16)[0],
  };
}

const ok = (out: CompiledAnimGraph) => {
  expect(out.problems.filter((p) => p.severity === "error")).toEqual([]);
  expect(out.bytes).not.toBeNull();
  return decode(out.bytes!);
};
const errors = (out: CompiledAnimGraph) => out.problems.filter((p) => p.severity === "error");
const warnings = (out: CompiledAnimGraph) => out.problems.filter((p) => p.severity === "warning");

function representative(): AnimGraph {
  return graphOf([
    node("idle", "clipPlayer", { params: { clip: "asset:clips/idle.anim.json", loop: true } }),
    node("walk", "clipPlayer", { params: { clip: "asset:models/hero.glb#Anim/Walk", speed: 1.1 } }),
    node("run", "clipPlayer", { params: { clip: "./clips/run.anim.json" } }),
    node("stop", "clipPlayer", { params: { clip: "asset:clips/stop.anim.json" } }),
    node("moveBs", "blendSpace1D", { inputs: ["walk", "run"], params: { x: "speed", coords: [1.5, 4], sync: true, glideMs: 120 } }),
    node("feet", "syncGroup", { inputs: ["moveBs"] }),
    node("loco", "stateMachine", {
      name: "Base",
      machine: {
        entry: "Move",
        states: [
          state("Idle", "idle", [tr("Move", { id: "go", if: { all: [{ param: "speed", op: ">", value: 0.1 }, { param: "dead", op: "==", value: false }] }, duration: 0.25, shape: "smoothstep" })]),
          state("Move", "feet", [
            tr("Idle", { id: "halt", if: { any: [{ param: "speed", op: "<=", value: 0.1 }, { request: "Stop", op: "==", value: true }] }, when: "exit", how: "bridge", bridge: "stop", duration: 0.1, shape: "easeOut", interrupt: ["go", "die"] }),
            tr("Idle", { if: { all: [{ operand: "normalizedTime", op: ">=", value: 0.9 }, { any: [{ curve: "FootIK", op: "<", value: 0.5 }, { operand: "syncPhase", op: "!=", value: 0 }] }] }, when: "marker:L", how: "inertialize", duration: 0.3, interrupt: "any" }),
            tr("Done", { if: { all: [{ operand: "stateTime", op: ">", value: 10 }, { param: "weapon", op: "==", value: 3 }, { request: "Skip", op: "!=", value: false }] }, when: 0.75, how: "cut", duration: 0 }),
          ]),
          state("Done", null, [], true),
        ],
        anyState: [tr("Done", { id: "die", if: { param: "dead", op: "==", value: true }, how: "cut", duration: 0 })],
      },
    }),
    node("pick", "chooser", { params: { blendTime: 0.3 }, chooser: { rows: [{ if: { param: "weapon", op: ">", value: 0 }, result: "run" }], fallback: "idle" } }),
    node("upper", "slot", { inputs: ["loco"], params: { mask: "asset:masks/upper.mask.json" }, slot: { name: "UpperBody", group: "Actions" } }),
    node("weapon", "linked", { params: { stateWords: 512, depth: 2 }, linked: { name: "Weapon", graph: "asset:graphs/sword.animgraph.json" } }),
    node("mix", "blend2", { inputs: ["upper", "pick"], params: { weight: "aim" } }),
    node("out", "inertialize", { name: "Output", inputs: ["mix"] }),
  ], "out", {
    name: "Locomotion",
    skeleton: "asset:models/hero.glb#Skeleton",
    parameters: [
      param("speed", "float", { replicate: true, predicted: true }),
      param("weapon", "int", { default: -2, replicate: true }),
      param("dead", "bool"),
      param("canVault", "bool", { default: true, computed: true }),
      param("look", "vec3", { default: [1, 2, 3] }),
      param("target", "node", { default: "Enemies/Boss" }),
      param("aim", "float", { default: 1 }),
    ],
    layers: [{ name: "Arms", root: "weapon", mask: "asset:masks/upper.mask.json", mode: "additive", weight: 0.5, weightParameter: "aim" }],
  });
}

describe("compileAnimGraph", () => {
  it("compiles a representative graph that reads back through the header reader and record by record", () => {
    const out = compileAnimGraph(representative());
    // Every state is reachable (Done through the any-state transition) and every node feeds the output or the layer.
    expect(warnings(out)).toEqual([]);
    const d = ok(out);
    expect(d.header.name).toBe("Locomotion");
    expect(d.header.info).toEqual({ kind: "graph", nodes: 14, parameters: 7, machines: 1, states: 3, transitions: 5, slots: 1, linked: 1, layers: 1, skeleton: "models/hero.glb#Skeleton" });

    // Parameters: names, ParamType ids, flags, default words.
    expect(d.params.map((p) => [p.name, p.type, p.flags])).toEqual([["speed", 0, 3], ["weapon", 1, 1], ["dead", 2, 0], ["canVault", 2, 4], ["look", 4, 0], ["target", 6, 0], ["aim", 0, 0]]);
    expect(d.params[1].value).toEqual([-2 >>> 0, 0, 0, 0]);
    expect(d.params[3].value).toEqual([1, 0, 0, 0]);
    expect(d.params[4].value).toEqual([f32(1), f32(2), f32(3), 0]);
    expect(d.strings[d.params[5].value[0]]).toBe("Enemies/Boss");

    // Nodes children-first: the empty player for the root-less state first, then the source order, the layer node last.
    expect(out.nodes).toEqual(["", "idle", "walk", "run", "stop", "moveBs", "feet", "loco", "pick", "upper", "weapon", "mix", "out", ""]);
    const at = (id: string) => out.nodes.indexOf(id);
    expect(d.nodes[at("moveBs")].inputs).toEqual([at("walk"), at("run")]);
    expect(d.strings[d.nodes[at("out")].name]).toBe("Output");
    expect(d.nodes[at("loco")].name).toBe(d.strings.indexOf("Base"));
    const top = d.nodes.length - 1;
    expect(d.info[1]).toBe(top);
    expect(d.nodes[top]).toMatchObject({ family: 2, kind: 2, inputs: [at("out"), at("weapon")] });
    expect(d.nodes[top].words).toEqual([0, 1, d.strings.indexOf("masks/upper.mask.json"), f32(0.5), 6]);

    // The machine: any-state first, then each state's transitions in priority order.
    expect(d.machines[0]).toEqual([at("loco"), d.strings.indexOf("Base"), 0, 3, 1, 0, 1, 0]);
    expect(d.states.map((s) => [d.strings[s[0]], s[1], s[2], s[3], s[4]])).toEqual([["Idle", at("idle"), 1, 1, 0], ["Move", at("feet"), 2, 3, 0], ["Done", 0, 5, 0, 1]]);
    const [die, go, halt, inert, cut] = d.transitions;
    expect(die).toMatchObject({ target: 2, how: 1, duration: 0, mode: 0 });
    expect(go).toMatchObject({ target: 1, when: 0, how: 0, shape: 1, mode: 0 });
    expect(go.duration).toBeCloseTo(0.25, 6);
    expect(halt).toMatchObject({ target: 0, when: 1, how: 3, bridge: at("stop"), shape: 3, mode: 2, count: 2 });
    expect(d.interrupts.slice(halt.first, halt.first + halt.count)).toEqual([1, 0]); // "go", "die"
    expect(inert).toMatchObject({ when: 2, how: 2, mode: 1, whenValue: d.strings.indexOf("L"), bridge: NONE });
    expect(cut).toMatchObject({ target: 2, when: 3, whenValue: f32(0.75), how: 1, duration: 0 });

    // Conditions: prefix order, built per state in order then any-state.
    const program = (i: number) => d.conds.slice(d.programs[i][0], d.programs[i][0] + d.programs[i][1]);
    expect(program(go.condition)).toEqual([
      { code: 0, op: 0, src: 0, operand: 2, value: 0 },
      { code: 2, op: 4, src: 0, operand: 0, value: f32(0.1) },
      { code: 2, op: 0, src: 0, operand: 2, value: 0 },
    ]);
    expect(program(halt.condition)).toEqual([
      { code: 1, op: 0, src: 0, operand: 2, value: 0 },
      { code: 2, op: 3, src: 0, operand: 0, value: f32(0.1) },
      { code: 2, op: 0, src: 5, operand: d.strings.indexOf("Stop"), value: 1 },
    ]);
    expect(program(inert.condition).map((c) => [c.code, c.src, c.op])).toEqual([[0, 0, 0], [2, 2, 5], [1, 0, 0], [2, 4, 2], [2, 3, 1]]);
    expect(program(inert.condition)[3].operand).toBe(d.strings.indexOf("FootIK"));
    expect(program(cut.condition)).toEqual([
      { code: 0, op: 0, src: 0, operand: 3, value: 0 },
      { code: 2, op: 4, src: 1, operand: 0, value: f32(10) },
      { code: 2, op: 0, src: 0, operand: 1, value: 3 },
      { code: 2, op: 1, src: 5, operand: d.strings.indexOf("Skip"), value: 0 },
    ]);
    expect(d.programs.length).toBe(6); // go, halt, inert, cut, die, the chooser row

    // Chooser, slot, linked graph, layer records.
    expect(d.choosers).toEqual([[at("pick"), 0, 1, at("idle")]]);
    expect(d.rows).toEqual([[5, at("run")]]);
    expect(d.nodes[at("pick")].words).toEqual([0, f32(0.3)]);
    expect(d.slots).toEqual([[d.strings.indexOf("UpperBody"), at("upper"), d.strings.indexOf("Actions"), 0]]);
    expect(d.linked).toEqual([[d.strings.indexOf("Weapon"), at("weapon"), d.strings.indexOf("graphs/sword.animgraph.json"), 0]]);
    expect(d.nodes[at("weapon")].words).toEqual([512, 1024, 2, 64]);
    expect(d.layers).toEqual([[d.strings.indexOf("Arms"), at("weapon"), d.strings.indexOf("masks/upper.mask.json"), 1, f32(0.5), 6]]);

    // Strings: name, skeleton, parameters, requests, then node strings in node order.
    expect(d.strings.slice(0, 11)).toEqual(["Locomotion", "models/hero.glb#Skeleton", "speed", "weapon", "dead", "canVault", "look", "target", "Enemies/Boss", "aim", "Stop"]);
    expect(out.strings).toEqual(d.strings);
    // Bindings: every asset reference once, by kind, with the reference as written.
    expect(out.bindings.map((b) => [d.strings[b.stringId], b.asset, b.ref])).toEqual([
      ["clips/idle.anim.json", "clip", "asset:clips/idle.anim.json"],
      ["models/hero.glb#Anim/Walk", "clip", "asset:models/hero.glb#Anim/Walk"],
      ["clips/run.anim.json", "clip", "./clips/run.anim.json"],
      ["clips/stop.anim.json", "clip", "asset:clips/stop.anim.json"],
      ["masks/upper.mask.json", "mask", "asset:masks/upper.mask.json"],
      ["graphs/sword.animgraph.json", "graph", "asset:graphs/sword.animgraph.json"],
    ]);
    expect(out.machines).toEqual([{ node: "loco", states: ["Idle", "Move", "Done"] }]);
    expect([out.slots, out.linked, out.layers]).toEqual([["UpperBody"], ["Weapon"], ["Arms"]]);
    expect(out.ok).toBe(true);
  });

  it("orders nodes children first, keeping the source order otherwise", () => {
    const out = compileAnimGraph(graphOf([node("out", "inertialize", { inputs: ["mix"] }), node("mix", "blend2", { inputs: ["b", "a"] }), node("a", "clipPlayer"), node("b", "clipPlayer")], "out"));
    const d = ok(out);
    expect(out.nodes).toEqual(["a", "b", "mix", "out"]);
    expect(d.nodes[2].inputs).toEqual([1, 0]);
    expect(d.info[1]).toBe(3);
  });

  it("packs every kind's block with the Rust word table's length and positions", () => {
    // Block lengths with the parameters below (each Rust family module's word table; `rig/mod.rs`'s per-kind modules).
    const cases: [string, Partial<GraphNode>, number][] = [
      ["clipPlayer", {}, 5], ["blendSpace1D", { inputs: ["a", "b"], params: { coords: [0, 1] } }, 9], ["blendSpace2D", { inputs: ["a", "b", "c"], params: { coords: [0, 0, 1, 0, 0, 1] } }, 13],
      ["poseSnapshot", {}, 1], ["referencePose", {}, 1], ["bindPose", {}, 0],
      ["random", { inputs: ["a", "b"], params: { weights: [1, 2] } }, 4], ["chooser", {}, 2],
      ["blend2", { inputs: ["a", "b"] }, 2], ["crossfade", { inputs: ["a", "b"] }, 1], ["layer", { inputs: ["a", "b"] }, 5], ["inertialize", { inputs: ["a"] }, 0],
      ["blendEnum", { inputs: ["a", "b"] }, 2], ["blendBool", { inputs: ["a", "b"] }, 2], ["additive", { inputs: ["a", "b"] }, 2], ["timeScale", { inputs: ["a"] }, 2],
      ["mirror", { inputs: ["a"], params: { table: [0, 1, 2] } }, 5],
      ["slot", { inputs: ["a"] }, 1], ["linked", {}, 4], ["syncGroup", { inputs: ["a"] }, 0], ["notifyGate", { inputs: ["a"] }, 2],
      ["twoBoneIk", { inputs: ["a"] }, 12], ["ccd", { inputs: ["a"], params: { bones: [1, 2, 3] } }, 12], ["fabrik", { inputs: ["a"], params: { bones: [1, 2] } }, 11],
      ["fullBodyIk", { inputs: ["a"] }, 21], ["fullBodyIk", { inputs: ["a"], params: { mode: "explicit", rootBone: 0, chainLengths: [3, 2], chainParents: [-1, 0], chainBones: [0, 1, 2, 2, 3] } }, 15 + 6 + 5],
      ["lookAt", { inputs: ["a"], params: { bones: [1, 2] } }, 17 + 6], ["aim", { inputs: ["a"], params: { bones: [1] } }, 19 + 3],
      ["grounder", { inputs: ["a"], params: { legs: [1, 2, 3, 4, 5, 6] } }, 19 + 6],
      ["springChain", { inputs: ["a"], params: { bones: [1, 2, 3], colliderBones: [0], colliderA: [0, 0, 0], colliderB: [0, 1, 0], colliderRadius: [0.1] } }, 17 + 3 + 9],
      ["copy", { inputs: ["a"] }, 20], ["limitRotation", { inputs: ["a"], params: { bones: [1, 2] } }, 12], ["limitPosition", { inputs: ["a"] }, 14], ["damp", { inputs: ["a"] }, 7],
      ["strideWarp", { inputs: ["a"], params: { legs: [1, 2, 3] } }, 22], ["orientationWarp", { inputs: ["a"], params: { bones: [1, 2], shares: [0.4, 0.6] } }, 17],
      ["motionWarp", { inputs: ["a"] }, 10], ["distanceMatch", { inputs: ["a"] }, 9],
      ["retarget", { params: { goalWeights: [1, 0.5] } }, 9 + 4], ["poseDatabase", {}, 40], ["matchTags", {}, 12],
      ["physicalPose", {}, 0], ["physicsBlend", { inputs: ["a", "b"] }, 3], ["plugin", { params: { block: [1, 2, 3] } }, 5 + 3],
    ];
    const covered = new Set(cases.map(([k]) => k));
    for (const f of GRAPH_FAMILIES) for (const k of GRAPH_NODE_KINDS[f]) if (k !== "stateMachine") expect(covered.has(k), k).toBe(true);
    for (const [kind, extra, length] of cases) {
      const out = compileAnimGraph(graphOf([node("a", "clipPlayer"), node("b", "clipPlayer"), node("c", "clipPlayer"), node("n", kind, extra)], "a"));
      expect(errors(out), kind).toEqual([]);
      expect(decode(out.bytes!).nodes[3].words.length, kind).toBe(length);
    }
  });

  it("puts words where the Rust modules read them", () => {
    const g = graphOf([
      node("a", "clipPlayer", { params: { clip: "asset:c.anim", speed: 2, loop: "once", start: 0.5, layer: 3 } }),
      node("ik", "twoBoneIk", { inputs: ["a"], params: { chain: "LeftLeg", tip: 9, target: "foot", pole: "knee", tipMode: "target", soft: 0.1, weight: "w", weightCurve: "IK", lodSkip: 2 } }),
      node("gr", "grounder", { inputs: ["ik"], params: { pelvis: "Hips", legs: ["LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "thighR", "shinR", "footR"] } }),
      node("gr2", "grounder", { inputs: ["gr"], params: { legs: [1, 2, 3] } }),
      node("db", "poseDatabase", { params: { database: "asset:loco.posedb", position: "pos", yaw: "w", requiredTags: [0, 33], anyTags: ["run"], tagParameters: ["", "", "", "", "t"] } }),
      node("mw", "motionWarp", { inputs: ["gr2"], params: { window: "times", startTime: 0.25, endTime: 1 } }),
      node("rt", "retarget", { params: { map: "asset:a.retarget", source: "asset:src.animgraph.json", rootY: "locked", goalWeights: [0.5], goalParameters: ["w"] } }),
    ], "mw", { parameters: [param("w", "float"), param("pos", "vec3"), param("t", "int")] });
    const out = compileAnimGraph(g, { bones: ["root", "thighR", "shinR", "footR"], poseDatabaseTags: (db) => (db === "asset:loco.posedb" ? ["idle", "walk", "run"] : undefined) });
    const d = ok(out);
    const words = (id: string) => d.nodes[out.nodes.indexOf(id)].words;
    expect(words("a")).toEqual([d.strings.indexOf("c.anim"), f32(2), 1, f32(0.5), 3]);
    // Head (weight, weight parameter, curve, LOD skip), then two_bone's ROOT 4, MID 5, TIP 6, TARGET 7, POLE 8, TIP_MODE 9, SOFT 10, MAX_STRETCH 11.
    const ROLE = 0x80000000;
    expect(words("ik")).toEqual([f32(1), 0, d.strings.indexOf("IK"), 2, (ROLE | 48) >>> 0, (ROLE | 49) >>> 0, 9, 0, 1, 2, f32(0.1), f32(1)]);
    expect(out.ikTargets).toEqual(["foot", "knee"]);
    // grounder: PELVIS 4, RAY_BASE 5 (assigned: 0, then 2 for the next grounder), COUNT 18, LEGS 19.
    expect(words("gr").slice(4, 6)).toEqual([(ROLE | 1) >>> 0, 0]);
    expect(words("gr").slice(18)).toEqual([2, (ROLE | 48) >>> 0, (ROLE | 49) >>> 0, (ROLE | 50) >>> 0, 1, 2, 3]);
    expect(words("gr").slice(12, 13)).toEqual([f32(Math.PI / 4)]);
    expect(words("gr2")[5]).toBe(2);
    expect(out.rays).toBe(3);
    // Pose database: word 10 position, 11 yaw, 16–27 tag masks, 28–39 tag parameters.
    const db = words("db");
    expect(db[0]).toBe(d.strings.indexOf("loco.posedb"));
    expect([db[2], db[10], db[11], db[12]]).toEqual([6, 1, 0, NONE]);
    expect(db.slice(16, 28)).toEqual([1, 2, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]);
    expect(db.slice(28, 40)).toEqual([NONE, NONE, NONE, NONE, 2, ...new Array(7).fill(NONE)]);
    // motion_warp: WINDOW 4 (times), START 5, END 6 as f32.
    expect(words("mw").slice(4, 7)).toEqual([1, f32(0.25), f32(1)]);
    // retarget: map, source, capacities, root axes, goal count, (weight, parameter) per goal.
    expect(words("rt")).toEqual([d.strings.indexOf("a.retarget"), d.strings.indexOf("src.animgraph.json"), 16384, 8, 64, 0, 2, 0, 1, f32(0.5), 0]);
    expect(out.bindings.map((b) => b.asset)).toEqual(["clip", "posedb", "retargetMap", "graph"]);
  });

  it("names each transition and condition term by its source path, in table order (the debugger's tables, T52)", () => {
    const m = node("m", "stateMachine", {
      machine: {
        entry: "A",
        states: [
          state("A", "c", [tr("B", { if: { all: [{ param: "go", op: "==", value: true }, { operand: "stateTime", op: ">", value: 1 }] } }), tr("Nowhere"), tr("B")]),
          state("B", "c", [tr("A", { if: { request: "Back", op: "==", value: true } })]),
        ],
        anyState: [tr("A", { if: { param: "go", op: "!=", value: true } })],
      },
    });
    const out = compileAnimGraph(graphOf([node("c", "clipPlayer", { params: { clip: "asset:a.anim" } }), m], "m", { parameters: [param("go", "bool")] }));
    // Any-state first, then each state's list; the transition to an unknown state is dropped (and has no index).
    expect(out.transitions).toEqual([
      "nodes[1].machine.anyState[0]",
      "nodes[1].machine.states[0].transitions[0]",
      "nodes[1].machine.states[0].transitions[2]",
      "nodes[1].machine.states[1].transitions[0]",
    ]);
    // Programs in state order then any-state, prefix order inside each.
    expect(out.conditions).toEqual([
      "nodes[1].machine.states[0].transitions[0].if",
      "nodes[1].machine.states[0].transitions[0].if.all[0]",
      "nodes[1].machine.states[0].transitions[0].if.all[1]",
      "nodes[1].machine.states[1].transitions[0].if",
      "nodes[1].machine.anyState[0].if",
    ]);
  });

  it("maps D53's fade shapes onto audio's curves", () => {
    // The core's shapes (logic.rs): 0 linear, 1 smooth 3x² − 2x³, 2 ease in x², 3 ease out 1 − (1 − x)².
    const core = [(x: number) => x, (x: number) => 3 * x * x - 2 * x * x * x, (x: number) => x * x, (x: number) => 1 - (1 - x) * (1 - x)];
    (["linear", "smoothstep", "easeIn", "easeOut"] as const).forEach((shape, id) => {
      for (let k = 0; k <= 10; k++) expect(shapeLevel(AUDIO_FADE_SHAPE[shape], k / 10)).toBeCloseTo(core[id](k / 10), 12);
    });
  });
});

describe("compile problems", () => {
  const base = () => [node("a", "clipPlayer"), node("b", "clipPlayer")];
  const machine = (states: MachineState[], anyState: Transition[] = [], entry: string | null = null) => node("m", "stateMachine", { machine: { entry: entry ?? states[0]?.name ?? null, states, anyState } });

  it("refuses a cycle with the nodes on it, writing nothing", () => {
    const out = compileAnimGraph(graphOf([node("x", "blend2", { inputs: ["a", "y"] }), node("y", "timeScale", { inputs: ["x"] }), node("a", "clipPlayer")], "x"));
    expect(out.bytes).toBeNull();
    expect(errors(out)).toEqual([{ path: "nodes[0]", severity: "error", message: expect.stringContaining('"x" → "y" → "x" form a cycle') }]);
    // A cycle through a state root.
    const viaState = compileAnimGraph(graphOf([machine([state("S", "t")]), node("t", "timeScale", { inputs: ["m"] })], "m"));
    expect(viaState.bytes).toBeNull();
    expect(errors(viaState)[0].message).toContain("cycle");
  });

  it("reports unknown families and kinds, writing a node that outputs nothing", () => {
    const out = compileAnimGraph(graphOf([...base(), { ...node("x", "clipPlayer"), kind: "warp9" }, { ...node("y", "clipPlayer"), family: "nope" as never }, node("o", "blend2", { inputs: ["x", "y"] })], "o"));
    expect(errors(out).map((p) => p.path)).toEqual(["nodes[2].kind", "nodes[3].family"]);
    const d = decode(out.bytes!);
    expect(d.nodes[out.nodes.indexOf("x")]).toMatchObject({ family: 0, kind: 0, words: [NONE, f32(1), 0, 0, NONE] });
    expect(out.ok).toBe(false);
  });

  it("reports wrong input counts", () => {
    const out = compileAnimGraph(graphOf([...base(), node("few", "blend2", { inputs: ["a"] }), node("many", "inertialize", { inputs: ["a", "b"] }), node("none", "clipPlayer", { inputs: ["a"] }), node("ghost", "timeScale", { inputs: ["zz"] }), node("o", "blendSpace1D", { inputs: ["few", "many", "none", "ghost"], params: { coords: [0, 1, 2, 3] } })], "o"));
    expect(errors(out).map((p) => [p.path, p.message])).toEqual([
      ["nodes[2].inputs", "a blend2 node needs 2 inputs (a, b), has 1."],
      ["nodes[3].inputs", "a inertialize node takes at most 1 inputs; the rest are dropped."],
      ["nodes[4].inputs", "a clipPlayer node takes no inputs; dropped."],
      ["nodes[5].inputs[0]", '"zz" isn\'t a node of this graph; dropped.'],
      ["nodes[5].inputs", "a timeScale node needs 1 input (child), has 0."],
    ]);
    expect(decode(out.bytes!).nodes[out.nodes.indexOf("many")].inputs).toEqual([out.nodes.indexOf("a")]);
  });

  it("warns about unreachable states and unused nodes", () => {
    const out = compileAnimGraph(graphOf([...base(), node("lonely", "clipPlayer"), machine([state("A", "a", [tr("B")]), state("B", "b"), state("C", "a")])], "m"));
    expect(errors(out)).toEqual([]);
    expect(warnings(out)).toEqual([
      { path: "nodes[2]", severity: "warning", message: 'node "lonely" doesn\'t feed the output or a layer; it never runs.' },
      { path: "nodes[3].machine.states[2]", severity: "warning", message: 'state "C" can\'t be reached from the entry state by any transition (only `jump` enters it).' },
    ]);
    // Any-state transitions reach their targets.
    const viaAny = compileAnimGraph(graphOf([...base(), machine([state("A", "a"), state("B", "b")], [tr("B")])], "m"));
    expect(warnings(viaAny)).toEqual([]);
  });

  it("type-checks conditions against the parameters, dropping the transition", () => {
    const g = graphOf([...base(), machine([state("A", "a", [
      tr("B", { if: { param: "v", op: ">", value: 1 } }),
      tr("B", { if: { param: "on", op: ">", value: true } as never }),
      tr("B", { if: { param: "on", op: "==", value: 1 } }),
      tr("B", { if: { param: "n", op: "==", value: 1.5 } }),
      tr("B", { if: { param: "f", op: "<", value: true } }),
      tr("B", { if: { param: "missing", op: "==", value: 1 } }),
      tr("B", { if: { all: [] } }),
      tr("B", { if: { request: "R", op: "<" as "==", value: true } }),
      tr("B", { if: { curve: "c", op: "~" as "==", value: 1 } }),
      tr("Nowhere"),
      tr("B", { id: "fine", if: { param: "f", op: "<", value: 2 }, interrupt: ["nope", "fine2"] }),
      tr("B", { id: "fine2" }),
    ]), state("B", "b")])], "m", { parameters: [param("v", "vec3"), param("on", "bool"), param("n", "int"), param("f", "float")] });
    const out = compileAnimGraph(g);
    const t = (k: number) => `nodes[2].machine.states[0].transitions[${k}]`;
    expect(errors(out).map((p) => p.path)).toEqual([
      `${t(0)}.if.param`, t(0), `${t(1)}.if.op`, t(1), `${t(2)}.if.value`, t(2), `${t(3)}.if.value`, t(3), `${t(4)}.if.value`, t(4), `${t(5)}.if.param`, t(5),
      `${t(6)}.if.all`, t(6), `${t(7)}.if.op`, t(7), `${t(8)}.if.op`, t(8), `${t(9)}.to`, `${t(10)}.interrupt[0]`,
    ]);
    expect(errors(out)[0].message).toBe('"v" is a vec3 parameter, which isn\'t comparable.');
    const d = decode(out.bytes!);
    expect(d.states[0][3]).toBe(2); // only "fine" and "fine2" survive
    expect(d.transitions[0]).toMatchObject({ mode: 2, count: 1 });
    expect(d.interrupts).toEqual([1]);
  });

  it("refuses conditions deeper than 16", () => {
    let c: import("./animGraph").Condition = { param: "f", op: ">", value: 0 };
    for (let i = 0; i < 16; i++) c = { all: [c] };
    const out = compileAnimGraph(graphOf([...base(), machine([state("A", "a", [tr("B", { if: c })]), state("B", "b")])], "m", { parameters: [param("f", "float")] }));
    expect(errors(out)[0].message).toBe("conditions nest at most 16 deep.");
    let ok16: import("./animGraph").Condition = { param: "f", op: ">", value: 0 };
    for (let i = 0; i < 15; i++) ok16 = { all: [ok16] };
    expect(errors(compileAnimGraph(graphOf([...base(), machine([state("A", "a", [tr("B", { if: ok16 })]), state("B", "b")])], "m", { parameters: [param("f", "float")] })))).toEqual([]);
  });

  it("type-checks node parameters", () => {
    const out = compileAnimGraph(graphOf([
      node("a", "clipPlayer", { params: { clip: 3 as never, speed: "fast", loop: "sometimes", start: -1, bogus: 1 } }),
      node("b", "blendSpace1D", { inputs: ["a"], params: { x: "on", speed: "nope", coords: [0, 1] } }),
      node("c", "twoBoneIk", { inputs: ["b"], params: { root: "Elbow", weight: "on", soft: 2 } }),
      node("d", "layer", { inputs: ["c", "a"], params: { layer: "Missing" } }),
    ], "d", { parameters: [param("on", "bool")] }));
    expect(out.problems.map((p) => [p.path, p.severity])).toEqual([
      ["nodes[0].params.bogus", "warning"],
      ["nodes[0].params.clip", "error"],
      ["nodes[0].params.speed", "error"],
      ["nodes[0].params.loop", "error"],
      ["nodes[0].params.start", "warning"],
      ["nodes[1].params.x", "error"],
      ["nodes[1].params.speed", "error"],
      ["nodes[1].params.coords", "error"],
      ["nodes[2].params.weight", "error"],
      ["nodes[2].params.root", "error"],
      ["nodes[2].params.soft", "warning"],
      ["nodes[3].params.layer", "error"],
    ]);
    expect(out.problems[5].message).toBe('"on" is a bool parameter; this takes float. None.');
    expect(out.problems[9].message).toBe('"Elbow" isn\'t a Humanoid role (bone names need the skeleton); none.');
    expect(out.bytes).not.toBeNull();
  });

  it("refuses one string bound as two kinds of asset", () => {
    const out = compileAnimGraph(graphOf([node("a", "clipPlayer", { params: { clip: "asset:x.bin" } }), node("s", "slot", { inputs: ["a"], params: { mask: "asset:x.bin" }, slot: { name: "S", group: null } })], "s"));
    expect(errors(out)).toEqual([{ path: "nodes[1].params.mask", severity: "error", message: '"asset:x.bin" is bound as a clip elsewhere in this graph; one string can\'t name two kinds of asset.' }]);
  });

  it("reports IK target and ray-row overflows", () => {
    const iks = Array.from({ length: 17 }, (_, i) => node(`ik${i}`, "twoBoneIk", { inputs: [i ? `ik${i - 1}` : "a"], params: { target: `t${i}` } }));
    const out = compileAnimGraph(graphOf([node("a", "clipPlayer"), ...iks], "ik16"));
    expect(errors(out)).toEqual([{ path: "nodes[17].params.target", severity: "error", message: 'an instance has 16 IK target slots; "t16" gets none.' }]);
    // Three grounders of three feet need 9 ray rows; an instance has 8.
    const legs = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const rays = compileAnimGraph(graphOf([node("a", "clipPlayer"), ...[1, 2, 3].map((k) => node(`g${k}`, "grounder", { inputs: [k > 1 ? `g${k - 1}` : "a"], params: { legs } }))], "g3"));
    expect(errors(rays)).toEqual([{ path: "nodes[3]", severity: "error", message: "the grounders need 9 ray rows; an instance has 8." }]);
    expect(rays.rays).toBe(6);
  });

  it("reports a missing output, a graph without nodes, and machines without states", () => {
    expect(compileAnimGraph(graphOf([node("a", "clipPlayer")], null))).toMatchObject({ bytes: null, problems: [{ path: "output", severity: "error", message: "a graph needs an output node." }] });
    expect(compileAnimGraph(graphOf([], null))).toMatchObject({ bytes: null, problems: [{ path: "nodes", message: "a graph needs at least one node." }] });
    const out = compileAnimGraph(graphOf([machine([])], "m"));
    expect(errors(out)).toEqual([{ path: "nodes[0].machine", severity: "error", message: "a state machine needs at least one state; the node outputs nothing." }]);
    expect(decode(out.bytes!).header.info).toMatchObject({ machines: 0, nodes: 1 });
  });

  it("reports bad parameters and layers", () => {
    const out = compileAnimGraph(graphOf(base(), "a", {
      parameters: [param("f", "float", { default: Number.NaN }), param("f", "int"), param("q", "quat", { default: [1, 2] }), param("i", "int", { default: 0.5 })],
      layers: [{ name: "L", root: "b", mask: null, mode: "override", weight: 2, weightParameter: "i" }, { name: "L", root: "a", mask: null, mode: "override", weight: 1, weightParameter: null }, { name: "M", root: "zz", mask: null, mode: "override", weight: 1, weightParameter: null }],
    }));
    expect(out.problems.map((p) => [p.path, p.severity])).toEqual([
      ["parameters[0].default", "error"], ["parameters[1].name", "error"], ["parameters[2].default", "error"], ["parameters[3].default", "error"],
      ["layers[0].weight", "warning"], ["layers[0].weightParameter", "error"], ["layers[1].name", "error"], ["layers[2].root", "error"],
    ]);
    const d = decode(out.bytes!);
    expect(d.params.map((p) => p.name)).toEqual(["f", "q", "i"]);
    expect(d.params[1].value).toEqual([0, 0, 0, f32(1)]);
    expect(d.layers).toEqual([[d.strings.indexOf("L"), 1, NONE, 0, f32(1), NONE]]);
  });

  it("warns when layers outnumber the core's runtime layer weights", () => {
    const layers = ["A", "B", "C", "D", "E"].map((name) => ({ name, root: "b", mask: null, mode: "override" as const, weight: 1, weightParameter: null }));
    const out = compileAnimGraph(graphOf(base(), "a", { layers }));
    expect(warnings(out)).toEqual([{ path: "layers[4]", severity: "warning", message: "the core takes runtime weights for the first 4 layers; this one and later ones keep their default weight." }]);
    expect(decode(out.bytes!).header.info).toMatchObject({ layers: 5, nodes: 7 });
  });

  it("adds the parse's problems when compiling a source file", () => {
    const out = compileAnimGraphSource({ format: "myco.animgraph-source@1", output: "a", nodes: [{ id: "a", kind: "clipPlayer" }, { id: "b", kind: "teleport" }] });
    expect(out.problems).toEqual([
      { path: "nodes[1].kind", severity: "error", message: '"teleport" isn\'t a node kind; the node is dropped.' },
      { path: "nodes[0].family", severity: "error", message: '"clipPlayer" is a "sources" node; using "sources".' },
    ]);
    expect(out.ok).toBe(false);
    expect(out.bytes).not.toBeNull();
  });
});
