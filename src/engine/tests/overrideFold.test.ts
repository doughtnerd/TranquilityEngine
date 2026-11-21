// The prefab-override fold (ADR 0280) through two of its adapters: the resolved scene view and
// instantiation agree on every case of the shared table (the editor's Apply runs the same table in
// src/editor/prefabApplyFold.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { listComponents } from "../editor";
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
