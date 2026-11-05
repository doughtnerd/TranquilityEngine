// ADR 0042: list fields, field choices, quaternion fields, and the `worlds` and `tags` overrides
// on prefab instances.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameBehavior, GameObject, Quaternion, Vector2, behavior, field, getFields } from "../index";
import { resolveChoices } from "../core/registry";
import { resolveSettings } from "../core/settings";
import type { World } from "../core/World";

enum Mood {
  Calm,
  Angry,
}

@behavior("test.fields.Lists")
class Lists extends GameBehavior {
  @field([Number]) numbers: number[] = [];
  @field([Vector2]) points: Vector2[] = [];
  @field([Color]) colors: Color[] = [];
  @field([GameObject]) targets: (GameObject | null)[] = [];
  @field([String], { choices: ["a", "b"] }) letters: string[] = [];
  @field(Quaternion) turn = new Quaternion();
  @field(Number, { choices: Mood }) mood: Mood = Mood.Calm;
}

@behavior("test.fields.Tagged")
class Tagged extends GameBehavior {
  @field(Number) n = 0;
}

Assets.addSource(
  Assets.fromObject({
    "scenes/lists.scene.json": {
      format: "myco.scene@1",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        {
          id: "holder",
          name: "Holder",
          components: [
            {
              type: "test.fields.Lists",
              data: {
                numbers: [1, 2.5, 3],
                points: [[1, 2], [3, 4]],
                colors: ["#ff0000", "#00ff0080"],
                targets: [{ $node: "b" }, null, { $node: "a" }],
                letters: ["b"],
                turn: [0, 0, 90],
                mood: 1,
              },
            },
          ],
        },
        { id: "inst", prefab: "prefabs/unit.prefab.json", overrides: [{ component: "test.fields.Lists", field: "numbers", value: [9] }] },
      ],
    },
    "prefabs/unit.prefab.json": {
      format: "myco.scene@1",
      nodes: [
        { id: "root", name: "Unit", tags: ["unit"], components: [{ type: "test.fields.Lists", data: { numbers: [1, 2] } }, { type: "test.fields.Tagged", worlds: ["server"] }] },
        { id: "eye", parent: "root", name: "Eye", components: [{ type: "test.fields.Tagged" }] },
      ],
    },
    "scenes/worlds.scene.json": {
      format: "myco.scene@1",
      nodes: [
        {
          id: "u",
          prefab: "prefabs/unit.prefab.json",
          overrides: [
            { component: "test.fields.Tagged", worlds: ["client"] }, // was server-only
            { target: ["eye"], component: "test.fields.Tagged", worlds: ["server"] },
            { target: ["eye"], tags: ["eye", "sensor"] },
          ],
        },
        { id: "plain", components: [{ type: "test.fields.Tagged", worlds: ["*"] }] },
      ],
    },
  }),
);

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

describe("list fields", () => {
  it("are declared with the item type in brackets; lists don't nest", () => {
    const f = getFields(Lists).find((x) => x.name === "numbers")!;
    expect(f.type).toEqual([Number]);
    expect(() => field([[Number]] as never)).toThrow(/lists don't nest/);
    expect(() => field([] as never)).toThrow(/one item type/);
  });

  it("load each item as its type, resolving node references per item", async () => {
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Main", scenes: ["scenes/lists.scene.json"] }] } });
    engines.push(engine);
    const scene = engine.world.activeScene!;
    const c = scene.find("Holder")!.getBehavior(Lists)!;
    expect(c.numbers).toEqual([1, 2.5, 3]);
    expect(c.points.map((p) => p.toArray())).toEqual([[1, 2], [3, 4]]);
    expect(c.points[0]).toBeInstanceOf(Vector2);
    expect(c.colors[1].a).toBeCloseTo(0x80 / 255);
    expect(c.targets[0]).toBe(scene.find("B"));
    expect(c.targets[1]).toBeNull();
    expect(c.targets[2]).toBe(scene.find("A"));
    expect(c.letters).toEqual(["b"]);
    expect(c.turn.toEuler().z).toBeCloseTo(90);
    expect(c.mood).toBe(Mood.Angry);
  });

  it("are replaced whole by a prefab override", async () => {
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Main", scenes: ["scenes/lists.scene.json"] }] } });
    engines.push(engine);
    expect(engine.world.activeScene!.find("Unit")!.getBehavior(Lists)!.numbers).toEqual([9]);
  });
});

describe("field choices", () => {
  it("resolve from a list, a label object or enum, or the project settings", () => {
    expect(resolveChoices(["a", "b"])).toEqual([{ label: "a", value: "a" }, { label: "b", value: "b" }]);
    expect(resolveChoices(Mood)).toEqual([{ label: "Calm", value: 0 }, { label: "Angry", value: 1 }]); // reverse entries skipped
    expect(resolveChoices({ Small: 1, Big: 10 })).toEqual([{ label: "Small", value: 1 }, { label: "Big", value: 10 }]);
    const settings = resolveSettings({ render: { sortingLayers: ["Back", "Front"] } });
    expect(resolveChoices((s) => s.render.sortingLayers, settings)!.map((c) => c.value)).toEqual(["Back", "Front"]);
    expect(resolveChoices((s) => s.render.sortingLayers)).toEqual([]);
    expect(resolveChoices(undefined)).toBeNull();
  });

  it("resolve a labelled record returned by a settings function (label = key), keeping every entry", () => {
    const settings = resolveSettings({ render: { sortingLayers: ["Back", "Front"] } });
    expect(resolveChoices(() => ({ Default: 1, Enemy: 2 }), settings)).toEqual([{ label: "Default", value: 1 }, { label: "Enemy", value: 2 }]);
    expect(resolveChoices((s) => Object.fromEntries(s.render.sortingLayers.map((l, i) => [l, i])), settings)).toEqual([{ label: "Back", value: 0 }, { label: "Front", value: 1 }]);
    // Names that look like numbers aren't taken for enum reverse entries.
    expect(resolveChoices(() => ({ "5": "id-5", Grass: "id-g" }), settings)!.map((c) => c.label).sort()).toEqual(["5", "Grass"]);
    expect(resolveChoices(() => ({ Default: 1 }))).toEqual([]); // no settings: empty, as for lists
  });

  it("are recorded on the field", () => {
    expect(getFields(Lists).find((f) => f.name === "letters")!.options!.choices).toEqual(["a", "b"]);
  });
});

describe("per-instance worlds and tags overrides", () => {
  const nodes = (w: World) => {
    const u = w.activeScene!.find("Unit")!;
    return { root: u.getBehavior(Tagged), eye: u.find("Eye")!.getBehavior(Tagged), plain: w.activeScene!.find("plain")!.getBehavior(Tagged), eyeNode: u.find("Eye")! };
  };

  it("decide which Worlds an instance's components are created in", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const engine = await Engine.create({
      headless: true,
      bootstrap: {
        worlds: [
          { name: "Client", tags: ["client"], scenes: ["scenes/worlds.scene.json"] },
          { name: "Server", tags: ["server"], scenes: ["scenes/worlds.scene.json"] },
        ],
      },
    });
    engines.push(engine);
    const client = nodes(engine._world("Client")!);
    const server = nodes(engine._world("Server")!);
    expect(client.root).not.toBeNull(); // the override moved it from the server to the client
    expect(server.root).toBeNull();
    expect(client.eye).toBeNull(); // the override limited it to the server
    expect(server.eye).not.toBeNull();
    expect(client.plain).not.toBeNull(); // "*": every World
    expect(server.plain).not.toBeNull();
  });

  it("replace a node's tags inside an instance", async () => {
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Main", scenes: ["scenes/worlds.scene.json"] }] } });
    engines.push(engine);
    const { eyeNode } = nodes(engine.world);
    expect(eyeNode.tags).toEqual(["eye", "sensor"]);
    expect(engine.world.activeScene!.find("Unit")!.hasTag("unit")).toBe(true);
  });
});
