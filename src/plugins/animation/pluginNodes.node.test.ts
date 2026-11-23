// ADR 0370 "Third-party graph and rig nodes" (T45t) in a headless Engine, through the public API (`myco`), project assets
// and the render-sync contract (`skeletonInstances.ts`). A project plugin declares the sample node module
// (`native/anim/examples/plugin-sample`) in its `plugin.json`; graphs name its nodes with descriptor-named parameters and
// are compiled at run time by T30's compiler. The module is stored unmetered (`plugin_sample_raw.wasm`), so the loader
// meters it with the editor module's fuel pass (given to it as the editor does, `projectAnimationNodes.ts`); a module
// stored metered (`plugin_sample.wasm`, as builds ship them) loads with no fuel pass at all.
//
// The skeleton (`plugin.skel`) is a four-bone chain with identity rotations and inverse binds, so a skinning matrix's
// translation column is the bone's model position. Time comes from `engine.step(dt)` only.
//
// Tolerances: `scale` multiplies translations by a float: exact. `sway` is checked against the formula the sample
// documents, composed here with `Quaternion`: the sample's own sine is a degree-9 polynomial (error below 4e-6 rad), and
// the chain composes three rotations in f32, so positions agree to 2e-5 m.
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { Animator, Assets, Engine, GameObject, Quaternion, Skeleton, Vector3 } from "../../myco";
import type { World } from "../../engine/core/World";
import { pluginNodeKinds } from "../../engine/animation/graphNodes/plugin";
import { loadAnimationCompiler } from "./editor/compile/compiler";
import { setNodeModuleMeter } from "./runtime/features/nodes/loader";
import { skinningMatrices } from "./runtime/skeletonInstances";

const fixture = (name: string) => new URL(`./runtime/wasm/fixtures/${name}`, import.meta.url).href;
const dt = 1 / 30;
const SWAY = 2e-5;
const REST: readonly Vector3[] = [new Vector3(0, 1, 0), new Vector3(0, 1.25, 0.5), new Vector3(0.125, 1.5, 0.5), new Vector3(-0.375, 1.5, 1.25)];
const LOCAL: readonly Vector3[] = [new Vector3(0, 1, 0), new Vector3(0, 0.25, 0.5), new Vector3(0.125, 0.25, 0), new Vector3(-0.5, 0, 0.75)];

const manifest = (name: string, budget?: number) => ({ name, version: "1.0.0", sdk: "^1.0.0", animationNodes: [{ module: "nodes/sample.wasm", ...(budget !== undefined && { budget }) }] });
const rest = { id: "rest", family: "sources", kind: "referencePose" };
const graph = (module: string, node: Record<string, unknown>, parameters: unknown[] = []) => ({
  format: "myco.animgraph-source@1",
  output: "p",
  parameters,
  nodes: [rest, { id: "p", family: "plugin", kind: "plugin", inputs: ["rest"], params: { module: `asset:${module}`, ...node } }],
});

const files: Record<string, unknown> = {
  "anim/plugin.skel": fixture("plugin.skel"),
  "plugins/acme/plugin.json": manifest("acme"),
  "plugins/acme/nodes/sample.wasm": fixture("plugin_sample_raw.wasm"),
  "plugins/shipped/plugin.json": manifest("shipped"),
  "plugins/shipped/nodes/sample.wasm": fixture("plugin_sample.wasm"),
  "plugins/tight/plugin.json": manifest("tight", 1),
  "plugins/tight/nodes/sample.wasm": fixture("plugin_sample_raw.wasm"),
  "scale.animgraph.json": graph("plugins/acme/nodes/sample.wasm", { node: "scale", factor: "factor" }, [{ name: "factor", type: "float", default: 1 }]),
  "sway.animgraph.json": graph("plugins/acme/nodes/sample.wasm", { node: "sway", amplitude: 10 }),
  "shipped.animgraph.json": graph("plugins/shipped/nodes/sample.wasm", { node: "scale", factor: 3 }),
  "tight.animgraph.json": graph("plugins/tight/nodes/sample.wasm", { node: "sway", amplitude: 10 }),
};

let engine: Engine;
let world: World;
const made: GameObject[] = [];

function character(name: string, graphPath: string): { node: GameObject; anim: Animator } {
  const node = GameObject.create(name);
  made.push(node);
  node.addComponent(Skeleton, { skeleton: "anim/plugin.skel" });
  return { node, anim: node.addComponent(Animator, { graph: graphPath }) };
}

async function ready(node: GameObject): Promise<void> {
  await vi.waitFor(() => {
    engine.step(0);
    expect(skinningMatrices(world, node)).not.toBeNull();
  }, { timeout: 10_000 });
}

const positions = (node: GameObject): Vector3[] => {
  const m = skinningMatrices(world, node)!;
  return REST.map((_, b) => new Vector3(m[b * 12 + 3]!, m[b * 12 + 7]!, m[b * 12 + 11]!));
};
const far = (a: readonly Vector3[], b: readonly Vector3[]) => Math.max(...a.map((p, i) => Vector3.distance(p, b[i]!)));

/** The sample's sway (its doc comment) after `phase` cycles: bones from 1 rotate about +Z by 10° · sin(2π phase) · 0.8^k. */
function swayed(phase: number): Vector3[] {
  let angle = (10 * Math.PI) / 180 * Math.sin(2 * Math.PI * phase);
  const out = [REST[0]!];
  let rot = new Quaternion();
  for (let b = 1; b < 4; b++) {
    out.push(Vector3.add(out[b - 1]!, Quaternion.rotate(rot, LOCAL[b]!)));
    rot = Quaternion.mul(rot, Quaternion.rotateZ(angle));
    angle *= 0.8;
  }
  return out;
}

/** The editor module's fuel pass, as the editor gives it to the loader (`projectAnimationNodes.ts`). */
function useEditorMeter(): void {
  setNodeModuleMeter(async (bytes) => {
    const out = (await loadAnimationCompiler()).meterNodeModule(bytes);
    if ("error" in out) throw new Error(out.error);
    return out.bytes;
  });
}

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
  engine = await Engine.create({ headless: true });
  world = engine.world;
});

afterAll(() => {
  for (const n of made) if (n.isValid) GameObject.destroy(n);
  engine?.dispose();
  setNodeModuleMeter(null);
});

describe("third-party nodes in an Engine", () => {
  it("loads a module stored metered with no fuel pass, and refuses an unmetered one without it", async () => {
    setNodeModuleMeter(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const shipped = character("Shipped", "shipped.animgraph.json");
    await ready(shipped.node);
    engine.step(dt);
    expect(far(positions(shipped.node), REST.map((p) => Vector3.scale(p, 3)))).toBe(0);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/node module/);
    warn.mockRestore();
  });

  it("meters the declared module, registers its node kinds and scales the bones by a graph parameter", async () => {
    useEditorMeter();
    const { node, anim } = character("Scaled", "scale.animgraph.json");
    await ready(node);
    expect(pluginNodeKinds().filter((k) => k.module === "plugins/acme/nodes/sample.wasm").map((k) => [k.node.name, k.schema.params.map((p) => p.name)])).toEqual([
      ["sway", ["module", "node", "amplitude", "frequency", "axis", "first_bone", "falloff"]],
      ["scale", ["module", "node", "factor"]],
    ]);
    engine.step(dt);
    expect(far(positions(node), REST)).toBe(0);
    anim.set("factor", 2);
    engine.step(dt);
    expect(far(positions(node), REST.map((p) => Vector3.scale(p, 2)))).toBe(0);
    anim.set("factor", 0.5);
    engine.step(dt);
    expect(far(positions(node), REST.map((p) => Vector3.scale(p, 0.5)))).toBe(0);
  });

  it("sways the chain as the sample documents, its phase in the core-owned state", async () => {
    useEditorMeter();
    const { node } = character("Swayed", "sway.animgraph.json");
    await ready(node);
    const before = positions(node);
    // Frames with dt 0 (while loading) leave the phase at 0: no sway yet.
    expect(far(before, REST)).toBeLessThan(SWAY);
    engine.step(dt);
    expect(far(positions(node), swayed(0.5 * dt))).toBeLessThan(SWAY);
    engine.step(dt);
    engine.step(dt);
    expect(far(positions(node), swayed(3 * 0.5 * dt))).toBeLessThan(SWAY);
    expect(far(positions(node), REST)).toBeGreaterThan(1e-3);
  });

  it("passes the input through when the module runs out of fuel, warns once, and recovers with a larger budget", async () => {
    useEditorMeter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { node } = character("Tight", "tight.animgraph.json");
    await ready(node);
    for (let i = 0; i < 3; i++) {
      engine.step(dt);
      expect(far(positions(node), REST)).toBe(0);
    }
    const faults = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("plugin node"));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/"sway" \(module plugins\/tight\/nodes\/sample\.wasm, graph node \d+\) failed: it ran out of its instruction budget/);
    // The plugin raises its budget: the loaded module takes it, and the next frame runs the node again.
    files["plugins/tight/plugin.json"] = manifest("tight", 100_000);
    Assets.notifyChanged("plugins/tight/plugin.json");
    await Promise.resolve();
    engine.step(dt);
    expect(far(positions(node), REST)).toBeGreaterThan(1e-3);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("plugin node"))).toHaveLength(1);
    warn.mockRestore();
  });
});

