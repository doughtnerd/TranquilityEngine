import { PHYSICS_2D, physics2DOf } from "../../plugins/physics/runtime/systems2d";
import { _startWorldService } from "../core/worldServices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Assets,
  BoxCollider2D,
  Engine,
  GameBehavior,
  GameObject,
  Input,
  Physics2D,
  SceneManager,
  Vector2,
  behavior,
  defineBuffer,
  defineComponent,
  defineSystem,
  f32,
  field,
} from "../../myco";
import { World } from "../core/World";
import { instantiateFile, loadSceneFile } from "../scene/SceneLoader";

// ADR 0032, T3: Worlds share no nodes, data, buffers or physics; references and reparenting never
// cross Worlds; local input reaches only Worlds that take it. Worlds are built directly and made
// current the way the Engine's loop does, so these tests don't depend on the Engine (T1); only the
// input test uses one, since which Worlds take input is the Engine's to decide (`WorldConfig.input`).

@behavior("test.isolation.Pointer")
class Pointer extends GameBehavior {
  @field(GameObject) target: GameObject | null = null;
}

class Marker extends GameBehavior {}

const Health = defineComponent("test.isolation.Health", { hp: f32 });
const Hits = defineBuffer<{ target: GameObject; amount: number }>("test.isolation.Hits");

const files = {
  "level.scene.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [{ id: "player", name: "Player" }] },
  "thing.json": { format: "myco.scene@1", nodes: [{ id: "thing", name: "Thing" }] },
  "ref.json": {
    format: "myco.scene@1",
    nodes: [{ id: "a", name: "A", components: [{ type: "test.isolation.Pointer", data: { target: { $node: "outside" } } }] }],
  },
};

let a: World;
let b: World;
let previous: World | null;

/** Run `fn` with `world` current, as the Engine does while that World's frame runs. */
function inWorld<T>(world: World, fn: () => T): T {
  const outer = World.active;
  World.active = world;
  try {
    return fn();
  } finally {
    World.active = outer;
  }
}

/** One frame of `world` (ADR 0011, through `World.step`, ADR 0239): one fixed step at the default rate, with it current. */
function frame(world: World, dt = 1 / 60): void {
  world.step(dt);
}

beforeEach(() => {
  previous = World.active;
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
  a = new World("runtime", {}, { name: "A", tags: ["client"] });
  b = new World("runtime", {}, { name: "B", tags: ["server"] });
  World.active = a;
});

afterEach(() => {
  World.active = previous;
  Assets.clearSources();
  Input.reset();
});

describe("Worlds share nothing (T3)", () => {
  it("keeps nodes, scenes and find results per World", async () => {
    await inWorld(a, () => SceneManager.load("level.scene.json"));
    const inA = inWorld(a, () => GameObject.create("OnlyInA"));
    inWorld(a, () => inA.addBehavior(Marker));
    const inB = inWorld(b, () => GameObject.create("OnlyInB"));

    expect(inA.world).toBe(a);
    expect(inB.world).toBe(b);
    expect(inWorld(a, () => SceneManager.scenes.length)).toBe(1);
    expect(inWorld(b, () => SceneManager.scenes)).toEqual([]);
    expect(inWorld(b, () => GameObject.findObjectOfType(Marker))).toBeNull();
    expect(inWorld(a, () => GameObject.findObjectsOfType(Marker))).toHaveLength(1);
    expect(b.root.children).toEqual([inB]);
    // Created with no scene in B, inB sits under B's root, not A's scene.
    expect(inB.parent).toBe(b.root);
  });

  it("keeps data components per World", () => {
    const n = inWorld(a, () => GameObject.create("n"));
    n.addData(Health, { hp: 10 });
    expect([...a._query([Health])]).toHaveLength(1);
    expect([...b._query([Health])]).toHaveLength(0);
    // The same entity index in B is a different node with no data.
    const m = inWorld(b, () => GameObject.create("m"));
    expect(m.entity).toBe(n.entity);
    expect(m.hasData(Health)).toBe(false);
  });

  it("keeps buffers per World", () => {
    const n = inWorld(a, () => GameObject.create("n"));
    inWorld(a, () => Hits.push({ target: n, amount: 1 }));
    expect(inWorld(a, () => Hits.read())).toHaveLength(1);
    expect(inWorld(b, () => Hits.read())).toHaveLength(0);
  });

  it("gives each World its own physics", async () => {
    await _startWorldService(a, PHYSICS_2D);
    await _startWorldService(b, PHYSICS_2D);
    expect(physics2DOf(a)).not.toBe(physics2DOf(b));
    const wall = inWorld(a, () => GameObject.create("Wall"));
    wall.addBehavior(BoxCollider2D, { size: new Vector2(2, 2) });
    frame(a);
    frame(b);
    expect(inWorld(a, () => Physics2D.raycast({ x: -5, y: 0 }, { x: 1, y: 0 }))?.collider.node).toBe(wall);
    expect(inWorld(b, () => Physics2D.raycast({ x: -5, y: 0 }, { x: 1, y: 0 }))).toBeNull();
    inWorld(b, () => (Physics2D.gravity = { x: 0, y: 3 }));
    expect(inWorld(a, () => Physics2D.gravity.y)).not.toBe(3);
  });
});

describe("references and reparenting never cross Worlds (T3)", () => {
  it("throws when reparenting under another World's node", () => {
    const n = inWorld(a, () => GameObject.create("n"));
    const other = inWorld(b, () => GameObject.create("other"));
    expect(() => n.setParent(other)).toThrow(/World "B".*isolated/);
    expect(n.parent).toBe(a.root);
  });

  it("creates under another World's node in that World (the parent decides, ADR 0034)", () => {
    const other = inWorld(b, () => GameObject.create("other"));
    // As after an await, when World A is current but the code means World B.
    const x = inWorld(a, () => GameObject.create("x", { parent: other }));
    expect(x.world).toBe(b);
    expect(other.children).toEqual([x]);
    expect(a.root.children).toEqual([]);
  });

  it("this.instantiate stays in the behavior's World, and refuses another World's parent", () => {
    class Spawner extends GameBehavior {}
    const s = inWorld(b, () => GameObject.create("spawner").addBehavior(Spawner));
    const mine = inWorld(a, () => GameObject.create("mine"));
    expect(() => inWorld(a, () => s.instantiate("thing.json", { parent: mine }))).toThrow(/World "A"/);
  });

  it("throws when a component init or a buffer record holds another World's node", () => {
    const n = inWorld(a, () => GameObject.create("n"));
    const other = inWorld(b, () => GameObject.create("other"));
    expect(() => n.addBehavior(Pointer, { target: other })).toThrow(/World "B"/);
    expect(() => inWorld(a, () => Hits.push({ target: other, amount: 1 }))).toThrow(/World "B"/);
    expect(inWorld(a, () => Hits.read())).toHaveLength(0);
    // A node of the same World is fine.
    const self = inWorld(a, () => GameObject.create("self"));
    expect(n.addBehavior(Pointer, { target: self }).target).toBe(self);
  });

  it("doesn't remove another World's component through a node with the same entity index", () => {
    const n = inWorld(a, () => GameObject.create("n"));
    const m = inWorld(b, () => GameObject.create("m"));
    expect(m.entity).toBe(n.entity);
    const marker = m.addBehavior(Marker);
    expect(() => n.removeBehavior(marker)).toThrow(/not attached/);
  });

  it("never resolves a scene's $node reference to another World's node", () => {
    const other = inWorld(b, () => GameObject.create("outside"));
    const file = loadSceneFile("ref.json");
    expect(() => instantiateFile(a, file, a.root, "ref.json", { resolveExternal: () => other })).toThrow(/node reference "outside".*World "B"/);
    const mine = inWorld(a, () => GameObject.create("outside"));
    const [root] = instantiateFile(a, file, a.root, "ref.json", { resolveExternal: () => mine });
    expect(root.getBehavior(Pointer)!.target).toBe(mine);
  });

  it("throws when loading a file under another World's node", () => {
    const other = inWorld(b, () => GameObject.create("other"));
    expect(() => instantiateFile(a, loadSceneFile("thing.json"), other, "thing.json")).toThrow(/World "B"/);
  });
});

/** What scripts in a World read from `Input` in its last frame, by World name (`inputReads`). */
interface InputRead {
  keyDown: boolean;
  key: boolean;
  keyUp: boolean;
  anyKeyDown: boolean;
  mouse: boolean;
  mouseDown: boolean;
  mouseDeltaX: number;
  scrollY: number;
  mouseX: number;
}
const inputReads: Record<string, InputRead> = {};
defineSystem({
  name: "test.isolation.inputProbe",
  phase: "update",
  worlds: ["client", "server"],
  run(_rows, ctx) {
    inputReads[ctx.world.name] = {
      keyDown: Input.getKeyDown("space"),
      key: Input.getKey("space"),
      keyUp: Input.getKeyUp("space"),
      anyKeyDown: Input.anyKeyDown,
      mouse: Input.getMouseButton(),
      mouseDown: Input.getMouseButtonDown(),
      mouseDeltaX: Input.mouseDelta.x,
      scrollY: Input.mouseScrollDelta.y,
      mouseX: Input.mousePosition.x,
    };
  },
});

describe("input reaches only Worlds that take it (T3)", () => {
  // Through an Engine, whose World configs say which Worlds take input (`WorldConfig.input`).
  it("shows nothing pressed and no movement in a World that doesn't take input", async () => {
    // B steps first, so A's reads show that B's consumed nothing.
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "B", tags: ["server"], input: false }, { name: "A", tags: ["client"] }] } });
    try {
      Input.simulate("down", "space");
      Input.simulate("down", "mouse0");
      Input.simulateMouseMove(4, 2);
      Input.simulateScroll(0, 10);
      engine.step(1 / 60);
      expect(inputReads.A).toMatchObject({ keyDown: true, key: true, anyKeyDown: true, mouseDown: true, mouseDeltaX: 4, scrollY: 10 });
      expect(inputReads.B).toEqual({ keyDown: false, key: false, keyUp: false, anyKeyDown: false, mouse: false, mouseDown: false, mouseDeltaX: 0, scrollY: 0, mouseX: 0 });
      // The release next frame, in A only.
      Input.simulate("up", "space");
      engine.step(1 / 60);
      expect(inputReads.A.keyUp).toBe(true);
      expect(inputReads.B.keyUp).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
