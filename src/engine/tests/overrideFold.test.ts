// The prefab-override fold (ADR 0280) through two of its adapters: the resolved scene view and
// instantiation agree on every case of the shared table (the editor's Apply runs the same table in
// src/editor/prefabApplyFold.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { instantiateDocument, listComponents } from "../editor";
import { FORMAT, PREFAB, expectCase, observeResolved, overrideCases, prefabFiles, type Observed, type OverrideCase } from "./overrideCases";

const sceneFile = (c: OverrideCase) => ({ format: FORMAT, nodes: [{ id: "inst", prefab: PREFAB, overrides: c.overrides }] });

afterEach(() => Assets.clearSources());

describe("the override fold: resolved view and instantiation agree (ADR 0280)", () => {
  for (const c of overrideCases) {
    it(`resolved view: ${c.name}`, () => {
      const files: Record<string, unknown> = { ...prefabFiles, "s.scene.json": sceneFile(c) };
      expectCase(c, observeResolved("s.scene.json", (p) => files[p]));
    });

    it(`instantiation: ${c.name}`, async () => {
      await Engine.create({ headless: true, assets: Assets.fromObject({ ...prefabFiles, "s.scene.json": sceneFile(c) }) });
      const scene = await SceneManager.load("s.scene.json");
      const root = scene.children[0];
      const out = new Map<string, Observed>();
      const visit = (node: GameObject): void => {
        const infos = listComponents(node);
        const of = (type: string, index: number) => infos.find((i) => i.type === type && i.index === index);
        out.set(node.name, {
          parent: node === root ? null : node.parent!.name,
          active: node.active,
          tags: [...node.tags],
          behaviours: infos.filter((i) => i.kind === "behavior").map((i) => i.type),
          data: infos.filter((i) => i.kind === "data").map((i) => i.type),
          field: (type, index, field) => of(type, index)?.fields.find((f) => f.name === field)?.value,
          enabled: (type, index) => of(type, index)?.enabled ?? false,
        });
        node.children.forEach(visit);
      };
      visit(root);
      expectCase(c, out);
    });
  }
});

describe("the override fold's node references", () => {
  it("resolves a reference in an added component's data among the scene's nodes", async () => {
    const scene = {
      format: FORMAT,
      nodes: [
        { id: "target", name: "Target" },
        { id: "inst", prefab: PREFAB, overrides: [{ addComponent: { type: "test.fold.A", data: { ref: { $node: "target" } } } }] },
      ],
    };
    await Engine.create({ headless: true, assets: Assets.fromObject({ ...prefabFiles, "s.scene.json": scene }) });
    const loaded = await SceneManager.load("s.scene.json");
    const root = loaded.children.find((n) => n.name === "Root")!;
    const added = listComponents(root).filter((i) => i.type === "test.fold.A")[2];
    expect((added.fields.find((f) => f.name === "ref")!.value as GameObject).name).toBe("Target");
  });
});

describe("removeNode and the removed node's descendants (B5)", () => {
  const inner = { format: FORMAT, nodes: [{ id: "r", name: "R" }, { id: "a", parent: "r", name: "A" }, { id: "b", parent: "a", name: "B" }] };
  const scene = { format: FORMAT, nodes: [{ id: "i", prefab: "inner.prefab.json", overrides: [{ target: ["a"], removeNode: true }, { target: ["b"], name: "Renamed" }] }] };

  it("reports a later override on a descendant as a missing target (editor)", async () => {
    const engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "inner.prefab.json": inner }) });
    const problems: string[] = [];
    const root = instantiateDocument(engine.world, scene as never, "s.scene.json", { onProblem: (message) => problems.push(message) });
    expect(problems).toEqual([expect.stringMatching(/override target "b" not found/)]);
    expect(root.children[0].children.map((c) => c.name)).toEqual([]);
  });

  it("stops a game's load on it with the same problem", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject({ "inner.prefab.json": inner, "s.scene.json": scene }) });
    await expect(SceneManager.load("s.scene.json")).rejects.toThrow(/override target "b" not found/);
  });
});
