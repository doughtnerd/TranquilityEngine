import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../demo/flappy/game";
import { GameManager } from "../../demo/flappy/behaviors/GameManager";
import { Assets, BoxCollider2D, Color, Engine, SpriteRenderer } from "../../engine";
import { getDataComponentDef } from "../../engine/core/data";
import {
  AddComponent,
  AddNode,
  CommandStack,
  RemoveComponent,
  RemoveNode,
  RenameNode,
  ReparentNode,
  SceneDocument,
  SetActive,
  SetField,
  WorldSync,
  type Command,
  type SceneFile,
} from "./index";

// The Flappy demo's scene and prefabs, keyed by asset path ("scenes/main.scene.json").
const files = Object.fromEntries(
  Object.entries(import.meta.glob("../../demo/flappy/{scenes,prefabs}/*.json", { eager: true, import: "default" })).map(([k, v]) => [k.replace("../../demo/flappy/", ""), v]),
);
const raw = files["scenes/main.scene.json"] as SceneFile;
const original = JSON.stringify(raw);

let engine: Engine;
let doc: SceneDocument;
let stack: CommandStack;
let sync: WorldSync;

/** World node for a document path. */
const at = (...path: string[]) => sync.nodeFor(path)!;

beforeEach(async () => {
  engine = await Engine.create({ headless: true, kind: "editor", assets: Assets.fromObject(files) });
  doc = new SceneDocument(raw, "scenes/main.scene.json");
  stack = new CommandStack(doc);
  sync = new WorldSync(engine.world, doc);
  sync.build();
  sync.attach(stack);
});
afterEach(() => Assets.clearSources());

/** Execute, check, undo, check the document is byte-identical again, redo, check again. */
function roundTrip(command: Command, check: () => void, checkUndone: () => void): void {
  stack.execute(command);
  check();
  expect(stack.undo()).toBe(true);
  expect(JSON.stringify(doc.toJSON())).toBe(original);
  checkUndone();
  expect(stack.redo()).toBe(true);
  check();
  stack.undo();
}

describe("SceneDocument", () => {
  it("round-trips the scene file exactly, key order included", () => {
    expect(JSON.stringify(doc.toJSON())).toBe(original);
    expect(doc.toJSON()).not.toBe(raw);
  });

  it("indexes nodes and answers read queries", () => {
    expect(doc.roots()).toContain("bird");
    expect(doc.children("bird")).toEqual(["bird-sprite"]);
    expect(doc.parentOf("bird-sprite")).toBe("bird");
    expect(doc.subtree("bird")).toEqual(["bird", "bird-sprite"]);
    expect(doc.isPrefabInstance("bg-b")).toBe(true);
    expect(doc.fieldValue("bird", "engine.Transform", "position")).toEqual([-4, 1, 0]);
    expect(doc.overrideValue("bg-b", [], "engine.Transform", "position")).toEqual([32, 3, 0]);
    expect(doc.references().filter((r) => r.path[0] === "game").map((r) => r.to)).toEqual(["bird", "spawner", "score", "message"]);
  });

  it("never modifies the caller's JSON", () => {
    stack.execute(new RenameNode("bird", "Player"));
    expect(JSON.stringify(raw)).toBe(original);
  });
});

describe("WorldSync build", () => {
  it("mirrors the document in an edit-mode scene node and maps nodes back", () => {
    expect(sync.sceneNode!.isSceneNode).toBe(true);
    expect(at("bird").name).toBe("Bird");
    expect(at("bird-sprite").parent).toBe(at("bird"));
    expect(sync.nodeIdOf(at("bird-sprite"))).toBe("bird-sprite");
    // Nodes inside a prefab instance map to the instance, with the inner path available.
    expect(sync.nodeIdOf(at("ground-b"))).toBe("ground-b");
    expect(at("ground-b").transform!.position.toArray()).toEqual([32, -13, 0]);
    expect(sync.sceneNode!.children.map((n) => sync.nodeIdOf(n))).toEqual(doc.roots());
  });

  it("keeps the scene still: no scripts, scrolling or physics", () => {
    const groundX = at("ground-a").transform!.position.x;
    const birdY = at("bird").transform!.position.y;
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(at("ground-a").transform!.position.x).toBe(groundX);
    expect(at("bird").transform!.position.y).toBe(birdY);
    expect(engine.world.physics2D).toBeNull();
  });
});

describe("commands keep the document and World in step", () => {
  it("SetField on a plain node", () => {
    roundTrip(
      new SetField("bird", "engine.Transform", "position", [2, 5, 0]),
      () => expect(at("bird").transform!.position.toArray()).toEqual([2, 5, 0]),
      () => expect(at("bird").transform!.position.toArray()).toEqual([-4, 1, 0]),
    );
  });

  it("SetField on a field the file doesn't set (undo restores the default)", () => {
    const color = () => at("bird-sprite").getBehavior(SpriteRenderer)!.color.toHex();
    const white = color();
    roundTrip(
      new SetField("bird-sprite", "engine.SpriteRenderer", "color", "#ff0000"),
      () => expect(color()).toBe(Color.from("#ff0000").toHex()),
      () => expect(color()).toBe(white),
    );
  });

  it("SetField adds a Transform entry to a node without one, and undo removes it", () => {
    roundTrip(
      new SetField("ceiling", "engine.Transform", "scale", [2, 2, 1]),
      () => expect(at("ceiling").transform!.scale.toArray()).toEqual([2, 2, 1]),
      () => expect(at("ceiling").transform!.scale.toArray()).toEqual([1, 1, 1]),
    );
    stack.execute(new SetField("camera", "engine.Camera", "orthographicSize", 12));
    expect(doc.components("camera").map((c) => c.type)).toEqual(["engine.Transform", "engine.Camera"]);
  });

  it("SetField on a prefab instance replaces an existing override", () => {
    roundTrip(
      new SetField("bg-b", "engine.Transform", "position", [40, 3, 0]),
      () => {
        expect(doc.overrides("bg-b")).toHaveLength(1);
        expect(at("bg-b").transform!.position.toArray()).toEqual([40, 3, 0]);
      },
      () => expect(at("bg-b").transform!.position.toArray()).toEqual([32, 3, 0]),
    );
  });

  it("SetField on a prefab instance adds an override, targeting the instance root or an inner node", () => {
    roundTrip(
      new SetField("bg-a", "game.Scroller", "speed", 3),
      () => {
        expect(doc.node("bg-a").overrides).toEqual([{ component: "game.Scroller", field: "speed", value: 3 }]);
        expect((at("bg-a").getData(sceneScroller())! as { speed: number }).speed).toBe(3);
      },
      () => expect((at("bg-a").getData(sceneScroller())! as { speed: number }).speed).toBe(0.5),
    );
    roundTrip(
      new SetField("bg-a", "engine.SpriteRenderer", "color", "#00ff00", { target: ["tile"] }),
      () => {
        expect(doc.node("bg-a").overrides).toEqual([{ target: ["tile"], component: "engine.SpriteRenderer", field: "color", value: "#00ff00" }]);
        expect(at("bg-a", "tile").getBehavior(SpriteRenderer)!.color.toHex()).toBe(Color.from("#00ff00").toHex());
      },
      () => expect(at("bg-a", "tile").getBehavior(SpriteRenderer)!.color.toHex()).toBe(Color.white.toHex()),
    );
  });

  it("RenameNode", () => {
    roundTrip(
      new RenameNode("bird", "Player"),
      () => expect(at("bird").name).toBe("Player"),
      () => expect(at("bird").name).toBe("Bird"),
    );
    roundTrip(
      new RenameNode("bg-a", "Sky"),
      () => expect(at("bg-a").name).toBe("Sky"),
      () => expect(at("bg-a").name).toBe("BackgroundTile"),
    );
  });

  it("SetActive", () => {
    roundTrip(
      new SetActive("bird", false),
      () => {
        expect(doc.node("bird").active).toBe(false);
        expect(at("bird-sprite").activeInHierarchy).toBe(false);
      },
      () => expect(at("bird-sprite").activeInHierarchy).toBe(true),
    );
  });

  it("AddNode (a subtree, at a sibling index)", () => {
    roundTrip(
      new AddNode(
        [
          { id: "marker", name: "Marker", components: [{ type: "engine.Transform", data: { position: [0, 2, 0] } }] },
          { id: "marker-child", name: "MarkerChild", parent: "marker" },
        ],
        { parent: "bird", index: 0 },
      ),
      () => {
        expect(doc.children("bird")).toEqual(["marker", "bird-sprite"]);
        expect(Object.keys(doc.node("marker"))).toEqual(["id", "name", "parent", "components"]);
        expect(at("bird").children.map((n) => n.name)).toEqual(["Marker", "Sprite"]);
        expect(at("marker-child").parent).toBe(at("marker"));
        expect(at("marker").transform!.worldPosition.toArray()).toEqual([-4, 3, 0]);
      },
      () => {
        expect(sync.nodeFor(["marker"])).toBeNull();
        expect(at("bird").children.map((n) => n.name)).toEqual(["Sprite"]);
      },
    );
  });

  it("RemoveNode restores the subtree and its position, and re-points references to it", () => {
    const manager = () => at("game").getBehavior(GameManager)!;
    roundTrip(
      new RemoveNode("bird"),
      () => {
        expect(doc.has("bird") || doc.has("bird-sprite")).toBe(false);
        expect(sync.nodeFor(["bird"])).toBeNull();
        expect(manager().bird?.isValid ?? false).toBe(false);
      },
      () => {
        expect(at("bird-sprite").parent).toBe(at("bird"));
        expect(manager().bird).toBe(at("bird"));
        expect(sync.sceneNode!.children.map((n) => sync.nodeIdOf(n))).toEqual(doc.roots());
      },
    );
  });

  it("ReparentNode (into another node at an index, and back to the top level)", () => {
    roundTrip(
      new ReparentNode("ceiling", "bird", 0),
      () => {
        expect(doc.children("bird")).toEqual(["ceiling", "bird-sprite"]);
        expect(at("ceiling").parent).toBe(at("bird"));
        expect(at("bird").children[0]).toBe(at("ceiling"));
        expect(at("ceiling").transform!.position.toArray()).toEqual([0, 11, 0]); // local transform kept
      },
      () => {
        expect(at("ceiling").parent).toBe(sync.sceneNode);
        expect(sync.sceneNode!.children.map((n) => sync.nodeIdOf(n))).toEqual(doc.roots());
      },
    );
    roundTrip(
      new ReparentNode("bird-sprite", null),
      () => {
        expect(doc.roots().at(-1)).toBe("bird-sprite");
        expect(at("bird-sprite").parent).toBe(sync.sceneNode);
      },
      () => expect(at("bird-sprite").parent).toBe(at("bird")),
    );
    expect(() => stack.execute(new ReparentNode("bird", "bird-sprite"))).toThrow(/descendant/);
  });

  it("AddComponent and RemoveComponent", () => {
    roundTrip(
      new AddComponent("ceiling", { type: "engine.SpriteRenderer", data: { color: "#0000ff" } }),
      () => expect(at("ceiling").getBehavior(SpriteRenderer)!.color.toHex()).toBe(Color.from("#0000ff").toHex()),
      () => expect(at("ceiling").getBehavior(SpriteRenderer)).toBeNull(),
    );
    roundTrip(
      new RemoveComponent("ceiling", 1),
      () => {
        expect(doc.components("ceiling").map((c) => c.type)).toEqual(["engine.Transform"]);
        expect(at("ceiling").getBehavior(BoxCollider2D)).toBeNull();
      },
      () => expect(at("ceiling").getBehavior(BoxCollider2D)!.size.toArray()).toEqual([40, 1]),
    );
  });
});

describe("CommandStack", () => {
  it("groups commands into one undo step", () => {
    stack.beginGroup("Drag");
    for (const x of [1, 2, 3]) stack.execute(new SetField("bird", "engine.Transform", "position", [x, 1, 0]));
    expect(stack.canUndo).toBe(false); // group still open
    stack.endGroup();
    expect(at("bird").transform!.position.x).toBe(3);
    expect(stack.undoLabel).toBe("Drag");
    stack.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(original);
    expect(at("bird").transform!.position.x).toBe(-4);
    expect(stack.canUndo).toBe(false);
    stack.redo();
    expect(at("bird").transform!.position.x).toBe(3);
  });

  it("tracks dirty state against the save point and notifies listeners", () => {
    const events: string[] = [];
    stack.subscribe((e) => events.push(`${e.reason}:${e.label}`));
    expect(stack.dirty).toBe(false);
    stack.execute(new RenameNode("bird", "A"));
    expect(stack.dirty).toBe(true);
    stack.markSaved();
    expect(stack.dirty).toBe(false);
    stack.undo();
    expect(stack.dirty).toBe(true);
    stack.redo();
    expect(stack.dirty).toBe(false);
    stack.execute(new RenameNode("bird", "B")); // clears redo
    expect(stack.canRedo).toBe(false);
    expect(events).toEqual(["execute:Rename", "save:Save", "undo:Rename", "redo:Rename", "execute:Rename"]);
  });
});

/** The demo's Scroller data component definition, looked up through the registry. */
function sceneScroller() {
  return getDataComponentDef("game.Scroller")!;
}

