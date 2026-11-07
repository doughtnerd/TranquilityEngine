import { describe, expect, it } from "vitest";
import type { ParticleGraph } from "../../engine/scene/particleGraph";
import { defaultParticleGraph, emptyParticleGraph } from "../../engine/scene/particleGraphFormat";
import {
  addBlock,
  addOutput,
  addNode,
  addNote,
  addProperty,
  addSystem,
  canMoveBlock,
  connectWire,
  copyItems,
  disconnect,
  disconnectEvent,
  duplicateItems,
  findBlock,
  groupItems,
  moveBlock,
  moveItems,
  moveProperty,
  parseParticleClipboard,
  pasteItems,
  removeBlock,
  removeItems,
  removeNote,
  removeProperty,
  renameProperty,
  renameSystem,
  collapsedSystems,
  setSystemCollapsed,
  setBlockEnabled,
  setBlockInput,
  setGroupTitle,
  setNodeInput,
  setNodeSetting,
  setOutputSettings,
  setOutputSoftness,
  setSeed,
  setSimulation,
  removeOutput,
  setOutputType,
  setPropertyExposed,
  setPropertyValue,
  setSpawnSettings,
  setSystemEnabled,
  setSystemSettings,
  ungroup,
  updateNote,
  whyNotPropertyName,
  whyNotWire,
} from "./graphEdit";
import { indexProblems, locateProblem } from "./problems";

/** Two Simple Loop systems (s1, s2), a gradient node and a time node. */
function sample(): ParticleGraph {
  let g = defaultParticleGraph();
  g = addSystem(g, "simpleLoop", [500, 0], "Sparks").graph;
  g = addNode(g, "gradient", [-300, 0]).graph;
  g = addNode(g, "time", [-300, 200]).graph;
  return g;
}
const ids = (g: ParticleGraph, sys: string, kind: "spawn" | "initialize" | "update" | "output") => g.systems.find((s) => s.id === sys)![kind].blocks.map((b) => b.id);
const colorBlock = (g: ParticleGraph, sys: string) => g.systems.find((s) => s.id === sys)!.update.blocks.find((b) => b.type === "update.colorOverLife")!.id;

describe("particle graph edits", () => {
  it("adds systems from templates with fresh ids and leaves the input alone", () => {
    const g0 = defaultParticleGraph();
    const before = JSON.stringify(g0);
    const { graph, id } = addSystem(g0, "burst", [100.4, 50.6]);
    expect(JSON.stringify(g0)).toBe(before);
    expect(id).toBe("s2");
    const s = graph.systems[1];
    expect(s.position).toEqual([100, 51]);
    expect(s.spawn.blocks[0].type).toBe("spawn.burst");
    const all = graph.systems.flatMap((x) => [x.id, ...x.spawn.blocks, ...x.initialize.blocks, ...x.update.blocks, ...x.output.blocks].map((b) => (typeof b === "string" ? b : b.id)));
    expect(new Set(all).size).toBe(all.length);
  });

  it("edits system, spawn and output settings", () => {
    let g = sample();
    g = renameSystem(g, "s1", " Flames ");
    expect(g.systems[0].name).toBe("Flames");
    expect(renameSystem(g, "s1", "  ")).toBe(g);
    g = setSystemEnabled(g, "s1", false);
    expect(g.systems[0].enabled).toBe(false);
    g = setSystemEnabled(g, "s1", true);
    expect("enabled" in g.systems[0]).toBe(false);
    g = setSystemSettings(g, "s1", { capacity: 50, space: "local" });
    expect(g.systems[0].settings).toEqual({ capacity: 50, space: "local" });
    g = setSpawnSettings(g, "s1", { looping: false, duration: 2 });
    expect(g.systems[0].spawn.settings).toMatchObject({ looping: false, duration: 2 });
    g = setOutputType(g, "s1", "trail");
    expect(g.systems[0].output.type).toBe("trail");
    g = setOutputSettings(g, "s1", { texture: "asset:fx/flame.png", trailLength: 40 });
    expect(g.systems[0].output.settings).toMatchObject({ texture: "asset:fx/flame.png", trailLength: 40 });
    expect(setSystemSettings(g, "s1", { capacity: 50 })).toBe(g);
  });

  it("adds blocks only where they fit, at an index", () => {
    const g = sample();
    const made = addBlock(g, "s1", "update", "update.gravity", 0);
    expect(made.id).toBeTruthy();
    expect(ids(made.graph, "s1", "update")[0]).toBe(made.id);
    expect(addBlock(g, "s1", "spawn", "update.gravity").id).toBeNull();
    expect(addBlock(g, "s1", "spawn", "no.such").id).toBeNull();
    const at = findBlock(made.graph, "s1", made.id!)!;
    expect(at.kind).toBe("update");
    expect(at.block.inputs.strength).toBe(1);
  });

  it("enables, disables and sets block inputs", () => {
    let g = sample();
    const b = g.systems[0].spawn.blocks[0].id;
    g = setBlockEnabled(g, "s1", b, false);
    expect(g.systems[0].spawn.blocks[0].enabled).toBe(false);
    g = setBlockEnabled(g, "s1", b, true);
    expect(g.systems[0].spawn.blocks[0].enabled).toBeUndefined();
    g = setBlockInput(g, "s1", b, "rate", { random: [1, 5] });
    expect(g.systems[0].spawn.blocks[0].inputs.rate).toEqual({ random: [1, 5] });
  });

  it("reorders blocks within a context using display slots", () => {
    const g = sample();
    const [a, b, c, d] = ids(g, "s1", "initialize");
    expect(ids(moveBlock(g, "s1", a, "s1", "initialize", 4), "s1", "initialize")).toEqual([b, c, d, a]);
    expect(ids(moveBlock(g, "s1", d, "s1", "initialize", 0), "s1", "initialize")).toEqual([d, a, b, c]);
    expect(ids(moveBlock(g, "s1", b, "s1", "initialize", 3), "s1", "initialize")).toEqual([a, c, b, d]);
    expect(moveBlock(g, "s1", b, "s1", "initialize", 1)).toBe(g);
    expect(moveBlock(g, "s1", b, "s1", "initialize", 2)).toBe(g);
  });

  it("moves blocks between systems with their wires, but only into contexts they fit", () => {
    let g = sample();
    const cb = colorBlock(g, "s1");
    g = connectWire(g, "n1.out", `s1.${cb}.color`);
    expect(canMoveBlock(g, "s1", cb, "s2", "spawn")).toBe(false);
    expect(moveBlock(g, "s1", cb, "s2", "spawn", 0)).toBe(g);
    const moved = moveBlock(g, "s1", cb, "s2", "update", 0);
    expect(ids(moved, "s2", "update")[0]).toBe(cb);
    expect(ids(moved, "s1", "update")).not.toContain(cb);
    expect(moved.edges).toEqual([{ from: "n1.out", to: `s2.${cb}.color` }]);
  });

  it("removes a block with its wires and events", () => {
    let g = sample();
    const trig = addBlock(g, "s1", "update", "update.triggerEvent");
    g = trig.graph;
    const cb = colorBlock(g, "s1");
    g = connectWire(g, "n1.out", `s1.${cb}.color`);
    g = connectWire(g, `s1.${trig.id}`, "s2.start");
    expect(g.events).toEqual([{ from: `s1.${trig.id}`, to: "s2.start" }]);
    expect(removeBlock(g, "s1", trig.id!).events).toEqual([]);
    expect(removeBlock(g, "s1", cb).edges).toEqual([]);
  });

  it("validates value and event wires", () => {
    let g = sample();
    const cb = colorBlock(g, "s1");
    const rate = g.systems[0].spawn.blocks[0].id;
    expect(whyNotWire(g, "n1.out", `s1.${cb}.color`)).toBeNull(); // gradient into a colour that takes gradients
    expect(whyNotWire(g, "n2.out", `s1.${rate}.rate`)).toBeNull(); // time into a number
    expect(whyNotWire(g, "n1.out", `s1.${rate}.rate`)).toMatch(/curve or gradient/);
    expect(whyNotWire(g, "n2.out", "s2.start")).toMatch(/Only events/);
    g = addNode(g, "event.play", [0, 400]).graph;
    expect(whyNotWire(g, "n3.out", "s2.start")).toBeNull();
    expect(whyNotWire(g, "n3.out", `s1.${rate}.rate`)).toMatch(/Events and values/);
    const trig = addBlock(g, "s1", "update", "update.triggerEvent");
    g = trig.graph;
    expect(whyNotWire(g, `s1.${trig.id}`, "s1.start")).toMatch(/own spawn/);
    expect(whyNotWire(g, `s1.${trig.id}`, `s2.${rate}.rate`)).toMatch(/Start or Stop/);
    // Enums and assets can't be wired.
    expect(whyNotWire(g, "n2.out", `s1.${trig.id}.on`)).toMatch(/can't be wired/);
  });

  it("connects and disconnects wires, one per input", () => {
    let g = sample();
    const rate = g.systems[0].spawn.blocks[0].id;
    g = addNode(g, "constant.number", [0, 0]).graph; // n3
    g = connectWire(g, "n2.out", `s1.${rate}.rate`);
    g = connectWire(g, "n3.out", `s1.${rate}.rate`);
    expect(g.edges).toEqual([{ from: "n3.out", to: `s1.${rate}.rate` }]);
    expect(connectWire(g, "n1.out", `s1.${rate}.rate`)).toBe(g); // refused
    g = disconnect(g, `s1.${rate}.rate`);
    expect(g.edges).toEqual([]);
    g = addNode(g, "event.custom", [0, 0], { name: "boom" }).graph; // n4
    expect(g.nodes.at(-1)!.settings).toEqual({ name: "boom" });
    g = connectWire(g, "n4.out", "s2.start");
    expect(g.events).toEqual([{ from: "n4", to: "s2.start" }]);
    expect(connectWire(g, "n4.out", "s2.start")).toBe(g);
    expect(disconnectEvent(g, "n4", "s2.start").events).toEqual([]);
  });

  it("removes systems and nodes with everything wired to them", () => {
    let g = sample();
    const cb = colorBlock(g, "s2");
    g = connectWire(g, "n1.out", `s2.${cb}.color`);
    g = addNode(g, "event.play", [0, 0]).graph; // n3
    g = connectWire(g, "n3.out", "s2.start");
    g = groupItems(g, ["s2", "n1"]).graph;
    const noSystem = removeItems(g, ["s2"]);
    expect(noSystem.systems.map((s) => s.id)).toEqual(["s1"]);
    expect(noSystem.edges).toEqual([]);
    expect(noSystem.events).toEqual([]);
    expect(noSystem.groups[0].members).toEqual(["n1"]);
    const noNodes = removeItems(g, ["n1", "n3"]);
    expect(noNodes.edges).toEqual([]);
    expect(noNodes.events).toEqual([]);
    expect(removeItems(noNodes, ["s2"]).groups).toEqual([]);
    expect(removeItems(g, ["nothing"])).toBe(g);
  });

  it("moves items and rounds positions", () => {
    let g = sample();
    g = moveItems(g, new Map([["s1", [10.2, 20.7]], ["n1", [-1, -2]]]));
    expect(g.systems[0].position).toEqual([10, 21]);
    expect(g.nodes[0].position).toEqual([-1, -2]);
    expect(moveItems(g, new Map([["s1", [10, 21]]]))).toBe(g);
  });

  it("sets node settings and inputs", () => {
    let g = sample();
    g = addNode(g, "multiply", [0, 0]).graph;
    g = setNodeInput(g, "n3", "a", 4);
    g = setNodeSetting(g, "n1", "gradient", { colors: [[0, "#ff0000"]], alphas: [] });
    expect(g.nodes[2].inputs).toEqual({ a: 4 });
    expect(g.nodes[0].settings?.gradient).toEqual({ colors: [[0, "#ff0000"]], alphas: [] });
  });

  it("manages Blackboard properties and their nodes", () => {
    let g = emptyParticleGraph();
    let made = addProperty(g, "number");
    g = made.graph;
    expect(made.name).toBe("Number");
    made = addProperty(g, "number");
    g = made.graph;
    expect(made.name).toBe("Number 2");
    g = addProperty(g, "gradient").graph;
    expect(g.properties[2]).toMatchObject({ name: "Gradient", type: "gradient", exposed: true });
    g = addNode(g, "property", [0, 0], { name: "Number" }).graph;
    expect(whyNotPropertyName(g, "Number", "Number 2")).toMatch(/already/);
    expect(whyNotPropertyName(g, "Number", "")).toBeTruthy();
    g = renameProperty(g, "Number", "Speed");
    expect(g.properties[0].name).toBe("Speed");
    expect(g.nodes[0].settings?.name).toBe("Speed");
    g = setPropertyValue(g, "Speed", 3);
    g = setPropertyExposed(g, "Speed", false);
    expect(g.properties[0]).toMatchObject({ value: 3, exposed: false });
    g = moveProperty(g, "Speed", 1);
    expect(g.properties.map((p) => p.name)).toEqual(["Number 2", "Speed", "Gradient"]);
    g = removeProperty(g, "Speed");
    expect(g.properties.map((p) => p.name)).toEqual(["Number 2", "Gradient"]);
    expect(g.nodes).toEqual([]);
  });

  it("copies and pastes systems and nodes with new ids, keeping the wires among them", () => {
    let g = sample();
    const cb = colorBlock(g, "s2");
    g = connectWire(g, "n1.out", `s2.${cb}.color`);
    const trig = addBlock(g, "s1", "update", "update.triggerEvent");
    g = connectWire(trig.graph, `s1.${trig.id}`, "s2.start");
    const clip = copyItems(g, ["s1", "s2", "n1"])!;
    expect(clip.edges).toHaveLength(1);
    expect(clip.events).toHaveLength(1);
    expect(parseParticleClipboard(JSON.stringify(clip))).toEqual(clip);
    expect(parseParticleClipboard("{\"format\":\"other\"}")).toBeNull();
    const pasted = pasteItems(g, clip, [1000, 1000]);
    expect(pasted.ids).toEqual(["s3", "s4", "n3"]);
    const s4 = pasted.graph.systems.find((s) => s.id === "s4")!;
    expect(s4.position).toEqual([1800, 1000]); // the gradient node at x -300 lands at 1000
    const newColor = s4.update.blocks.find((b) => b.type === "update.colorOverLife")!.id;
    expect(newColor).not.toBe(cb);
    expect(pasted.graph.edges).toContainEqual({ from: "n3.out", to: `s4.${newColor}.color` });
    const newTrig = pasted.graph.systems.find((s) => s.id === "s3")!.update.blocks.at(-1)!.id;
    expect(pasted.graph.events).toContainEqual({ from: `s3.${newTrig}`, to: "s4.start" });
    // Every id in the result is unique.
    const all = [...pasted.graph.systems.flatMap((s) => [s.id, ...[s.spawn, s.initialize, s.update, s.output].flatMap((c) => c.blocks.map((b) => b.id))]), ...pasted.graph.nodes.map((n) => n.id)];
    expect(new Set(all).size).toBe(all.length);
    // A wire from outside the selection isn't copied.
    expect(copyItems(g, ["s2"])!.edges).toEqual([]);
    expect(copyItems(g, [])).toBeNull();
  });

  it("duplicates items offset from where they were", () => {
    const g = sample();
    const d = duplicateItems(g, ["n1", "n2"]);
    expect(d.ids).toEqual(["n3", "n4"]);
    expect(d.graph.nodes[2].position).toEqual([-260, 40]);
    expect(duplicateItems(g, []).graph).toBe(g);
  });

  it("groups items and edits notes", () => {
    let g = sample();
    const grp = groupItems(g, ["s1", "n1", "missing"], "Fire");
    g = grp.graph;
    expect(g.groups).toEqual([{ id: grp.id, title: "Fire", members: ["s1", "n1"] }]);
    g = setGroupTitle(g, grp.id!, "Flames");
    expect(g.groups[0].title).toBe("Flames");
    // Grouping again takes the items out of their old group.
    g = groupItems(g, ["s1", "n1"]).graph;
    expect(g.groups).toHaveLength(1);
    g = ungroup(g, g.groups[0].id);
    expect(g.groups).toEqual([]);
    const note = addNote(g, [5.5, 6.5], "hi");
    g = updateNote(note.graph, note.id, { text: "there", size: [10, 10] });
    expect(g.notes[0]).toMatchObject({ text: "there", position: [6, 7], size: [80, 40] });
    expect(removeNote(g, note.id).notes).toEqual([]);
  });
});

describe("particle graph problems", () => {
  it("locates problems by id path and marks GPU wires", () => {
    let g = sample();
    const rate = g.systems[0].spawn.blocks[0].id;
    expect(locateProblem(g, "s1")).toEqual({ system: "s1" });
    expect(locateProblem(g, `s1.${rate}.rate`)).toEqual({ system: "s1", block: rate, input: "rate" });
    expect(locateProblem(g, "s1.spawn.settings")).toEqual({ system: "s1" });
    expect(locateProblem(g, "n2.x")).toEqual({ node: "n2", input: "x" });
    expect(locateProblem(g, "zz")).toBeNull();
    g = connectWire(g, "n2.out", `s1.${rate}.rate`);
    const ix = indexProblems(g, [
      { severity: "warning", message: "Add node can't combine per-particle values; that needs the GPU backend.", at: `s1.${rate}.rate` },
      { severity: "error", message: "Unknown node", at: "n1" },
    ]);
    expect([...ix.gpuWires]).toEqual([`s1.${rate}.rate`]);
    expect(ix.byItem.get(`s1.${rate}`)).toHaveLength(1);
    expect(ix.byItem.get("n1")).toHaveLength(1);
  });
});

describe("collapsed systems", () => {
  it("stores collapsed system ids in editor.collapsed without changing the input", () => {
    const g = defaultParticleGraph();
    const id = g.systems[0].id;
    const a = setSystemCollapsed(g, id, true);
    expect(g.editor?.collapsed).toBeUndefined();
    expect(a.editor?.collapsed).toEqual([id]);
    expect([...collapsedSystems(a)]).toEqual([id]);
    expect(setSystemCollapsed(a, id, true)).toBe(a);
    const b = setSystemCollapsed(a, id, false);
    expect(b.editor).toBeUndefined();
    expect(setSystemCollapsed(g, "nope", true)).toBe(g);
  });

  it("keeps other editor data and ignores ids of missing systems", () => {
    const g = defaultParticleGraph();
    g.editor = { zoom: 2, collapsed: ["gone"] };
    expect(collapsedSystems(g).size).toBe(0);
    const a = setSystemCollapsed(g, g.systems[0].id, true);
    expect(a.editor).toEqual({ zoom: 2, collapsed: [g.systems[0].id] });
  });
});

describe("simulation, seed, softness and several outputs", () => {
  it("sets the simulation (auto is not written) and the seed (empty is not written)", () => {
    let g = sample();
    g = setSimulation(g, "s1", "gpu");
    expect(g.systems[0].settings.simulation).toBe("gpu");
    g = setSimulation(g, "s1", undefined);
    expect("simulation" in g.systems[0].settings).toBe(false);
    expect(setSimulation(g, "s1", "auto")).toBe(g);
    g = setSeed(g, "s1", 42.7);
    expect(g.systems[0].settings.seed).toBe(42);
    g = setSeed(g, "s1", null);
    expect("seed" in g.systems[0].settings).toBe(false);
  });

  it("sets softness, and 0 turns it off", () => {
    let g = sample();
    g = setOutputSoftness(g, "s1", 0.5);
    expect(g.systems[0].output.settings.softness).toBe(0.5);
    g = setOutputSoftness(g, "s1", 0);
    expect("softness" in g.systems[0].output.settings).toBe(false);
  });

  it("adds an output copying the main one, edits it and removes it", () => {
    let g = sample();
    g = setOutputType(g, "s1", "stretched");
    g = setOutputSettings(g, "s1", { texture: "asset:a.png" });
    const added = addOutput(g, "s1");
    g = added.graph;
    expect(added.index).toBe(1);
    const extra = g.systems[0].extraOutputs![0];
    expect(extra.type).toBe("stretched");
    expect(extra.settings.texture).toBe("asset:a.png");
    expect(extra.blocks).toEqual([]);
    g = setOutputType(g, "s1", "mesh", 1);
    g = setOutputSettings(g, "s1", { texture: "asset:b.png" }, 1);
    g = setOutputSoftness(g, "s1", 1, 1);
    expect(g.systems[0].output.type).toBe("stretched");
    expect(g.systems[0].output.settings).toMatchObject({ texture: "asset:a.png" });
    expect(g.systems[0].extraOutputs![0]).toMatchObject({ type: "mesh", settings: { texture: "asset:b.png", softness: 1 } });
    expect(addOutput(g, "nope").index).toBeNull();
    expect(removeOutput(g, "s1", 0)).toBe(g);
    expect(removeOutput(g, "s1", 5)).toBe(g);
    g = removeOutput(g, "s1", 1);
    expect(g.systems[0].extraOutputs).toBeUndefined();
  });

  it("adds, moves and removes blocks in an extra output", () => {
    let g = addOutput(sample(), "s1").graph;
    const mainBlocks = g.systems[0].output.blocks.length;
    const made = addBlock(g, "s1", "output", "output.flipbook", undefined, 1);
    expect(made.id).not.toBeNull();
    g = made.graph;
    expect(g.systems[0].extraOutputs![0].blocks.map((b) => b.id)).toEqual([made.id]);
    expect(g.systems[0].output.blocks.length).toBe(mainBlocks);
    expect(findBlock(g, "s1", made.id!)).toMatchObject({ kind: "output", output: 1, index: 0 });
    expect(addBlock(g, "s1", "output", "output.flipbook", undefined, 2).id).toBeNull();
    expect(canMoveBlock(g, "s1", made.id!, "s1", "output", 0)).toBe(true);
    const moved = moveBlock(g, "s1", made.id!, "s1", "output", 0, 0);
    expect(findBlock(moved, "s1", made.id!)).toMatchObject({ output: 0, index: 0 });
    expect(moved.systems[0].extraOutputs![0].blocks).toEqual([]);
    g = setBlockEnabled(g, "s1", made.id!, false);
    expect(g.systems[0].extraOutputs![0].blocks[0].enabled).toBe(false);
    expect(removeBlock(g, "s1", made.id!).systems[0].extraOutputs![0].blocks).toEqual([]);
  });

  it("removing an output drops its blocks", () => {
    let g = addOutput(sample(), "s1").graph;
    const made = addBlock(g, "s1", "output", "output.flipbook", undefined, 1);
    g = removeOutput(made.graph, "s1", 1);
    expect(findBlock(g, "s1", made.id!)).toBeNull();
    expect(g.edges.some((e) => e.to.startsWith(`s1.${made.id}.`))).toBe(false);
  });
});
