// Node edits from the Inspector's header (nodeEdits.ts) on the sample's main scene in a writable folder
// project: `bird` (with its child `bird-sprite`) and `ceiling` are plain nodes; `bg-a` and `bg-b` are
// instances of the background prefab (bg-b overrides its position); `pipe` is a pipe-pair instance added
// here, whose inner nodes are `pipe/top`, `pipe/bottom` and `pipe/gate`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { AddNode, SetField, type NodePath, type SceneFile } from "./document";
import {
  applyPrefabOverrides,
  createPrefabFrom,
  nodeHeader,
  nodeIdProblem,
  prefabActions,
  renameNode,
  renameNodeId,
  revertAllOverrides,
  revertNameAndActive,
  setNodesActive,
} from "./nodeEdits";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { readOnlyMessage } from "./readOnly";
import { currentProject, openScene, playState, sceneCamera, selectedKeys, selection, status } from "./state";
import { inspectorTarget, select } from "./inspectorTarget";
import { MemoryFileSystem, ROOT, closeTestProject, demoFolder, sampleProject } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  scene().stack.execute(new AddNode({ id: "pipe", prefab: "prefabs/pipe-pair.prefab.json" }));
});

afterEach(closeTestProject);

const scene = () => openScene.value!;
const fileOf = (path: string) => JSON.parse(fs.files.get(joinPath(ROOT, path)) as string) as SceneFile;
const TOP: NodePath = ["pipe", "top"];
const live = (path: NodePath) => scene().sync.nodeFor(path)!;
/** The pipe-pair's overrides other than the ones it was added with (none). */
const pipeOverrides = () => scene().doc.node("pipe").overrides ?? [];

describe("which selected nodes exist", () => {
  it("the Inspector keeps top-level nodes and inner nodes the scene still has, as paths (ADR 0242)", () => {
    select(["bird", "gone", "pipe/top", "pipe/nope", "bird/bird-sprite"]);
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["bird"], ["pipe", "top"]] });
    select([]);
  });
});

describe("the header", () => {
  it("names the nodes and says whether they're on, off or mixed", () => {
    expect(nodeHeader(scene(), [["bird"], TOP])).toEqual({ names: ["Bird", "Top"], active: true, inner: true, nameOverridden: false, activeOverridden: false });
    expect(nodeHeader(scene(), [["bg-a"]]).names).toEqual(["bg-a"]); // no name of its own: its id
    setNodesActive(scene(), [["bird"]], false);
    expect(nodeHeader(scene(), [["bird"], ["ceiling"]]).active).toBe("mixed");
    expect(nodeHeader(scene(), [["bird"]]).active).toBe(false);
  });
});

describe("switching nodes on and off", () => {
  it("switches several nodes as one undo step, leaving ones already so alone", () => {
    const { doc, stack } = scene();
    setNodesActive(scene(), [["ceiling"]], false);
    expect(setNodesActive(scene(), [["bird"], ["ceiling"], ["bg-a"]], false)).toBe(2);
    expect(stack.undoLabel).toBe("Deactivate 2 nodes");
    expect(doc.node("bird").active).toBe(false);
    expect(live(["bird"]).active).toBe(false);
    stack.undo();
    expect(doc.node("bird").active).not.toBe(false);
    expect(doc.node("ceiling").active).toBe(false); // the earlier step
    expect(setNodesActive(scene(), [["bird"]], true)).toBe(0);
  });

  it("switches a node inside an instance as an override, which goes when it matches the prefab again", () => {
    setNodesActive(scene(), [TOP], false);
    expect(pipeOverrides()).toHaveLength(1);
    expect(nodeHeader(scene(), [TOP])).toMatchObject({ active: false, activeOverridden: true });
    expect(live(TOP).active).toBe(false);
    setNodesActive(scene(), [TOP], true);
    expect(pipeOverrides()).toEqual([]);
    expect(nodeHeader(scene(), [TOP]).activeOverridden).toBe(false);
  });
});

describe("renaming", () => {
  it("renames a plain node as one undo step, and does nothing for the same name", () => {
    const { doc, stack } = scene();
    expect(renameNode(scene(), ["bird"], "Bird")).toBe(false);
    expect(stack.canUndo).toBe(true); // the pipe added in beforeEach
    expect(stack.undoLabel).not.toMatch(/Rename/);
    expect(renameNode(scene(), ["bird"], "Hero")).toBe(true);
    expect(doc.node("bird").name).toBe("Hero");
    expect(live(["bird"]).name).toBe("Hero");
    stack.undo();
    expect(doc.node("bird").name).toBe("Bird");
  });

  it("renames a node inside an instance as an override; Revert takes name and active back in one undo step", () => {
    const { stack } = scene();
    renameNode(scene(), TOP, "Upper");
    setNodesActive(scene(), [TOP], false);
    expect(nodeHeader(scene(), [TOP])).toMatchObject({ names: ["Upper"], nameOverridden: true, activeOverridden: true });
    expect(revertNameAndActive(scene(), [TOP])).toBe(2);
    expect(stack.undoLabel).toBe("Revert name and active");
    expect(nodeHeader(scene(), [TOP])).toMatchObject({ names: ["Top"], active: true, nameOverridden: false, activeOverridden: false });
    expect(pipeOverrides()).toEqual([]);
    stack.undo();
    expect(nodeHeader(scene(), [TOP]).names).toEqual(["Upper"]);
    expect(revertNameAndActive(scene(), [["bird"]])).toBe(0);
  });

  it("renaming an inner node back to the prefab's name drops the override", () => {
    renameNode(scene(), TOP, "Upper");
    renameNode(scene(), TOP, "Top");
    expect(pipeOverrides()).toEqual([]);
  });
});

describe("which prefab actions are offered, and why one can't run", () => {
  const offered = (a: ReturnType<typeof prefabActions>) => Object.fromEntries((["create", "apply", "revertAll", "open"] as const).map((k) => [k, a[k]?.whyNot ?? (a[k] ? "ok" : "-")]));

  it("a plain node: Create Prefab", () => {
    expect(offered(prefabActions(scene(), project, [["bird"]]))).toEqual({ create: "ok", apply: "-", revertAll: "-", open: "-" });
  });

  it("an instance: its override count, Apply and Revert All when it has overrides, and Open Prefab", () => {
    const bgB = prefabActions(scene(), project, [["bg-b"]]);
    expect(bgB).toMatchObject({ prefab: "prefabs/background.prefab.json", overrides: 1 });
    expect(offered(bgB)).toEqual({ create: "-", apply: "ok", revertAll: "ok", open: "ok" });
    expect(offered(prefabActions(scene(), project, [["bg-a"]]))).toEqual({ create: "-", apply: "This instance has no overrides.", revertAll: "This instance has no overrides.", open: "ok" });
  });

  it("a node inside an instance: Open Prefab, naming the prefab", () => {
    const a = prefabActions(scene(), project, [TOP]);
    expect(a.prefab).toBe("prefabs/pipe-pair.prefab.json");
    expect(offered(a)).toEqual({ create: "-", apply: "-", revertAll: "-", open: "ok" });
  });

  it("several nodes: Create Prefab for plain siblings, Apply for instances with overrides, nothing with an inner node", () => {
    expect(offered(prefabActions(scene(), project, [["bird"], ["ceiling"]]))).toEqual({ create: "ok", apply: "-", revertAll: "-", open: "-" });
    expect(prefabActions(scene(), project, [["ceiling"], ["bird-sprite"]]).create?.whyNot).toBe("The nodes must share a parent to become one prefab.");
    expect(offered(prefabActions(scene(), project, [["bg-a"], ["bg-b"]]))).toEqual({ create: "-", apply: "ok", revertAll: "-", open: "-" });
    expect(offered(prefabActions(scene(), project, [["bg-a"], ["ground-a"]]))).toEqual({ create: "-", apply: "-", revertAll: "-", open: "-" });
    expect(offered(prefabActions(scene(), project, [["bird"], TOP]))).toEqual({ create: "-", apply: "-", revertAll: "-", open: "-" });
  });

  it("a read-only project refuses the actions that write files, with the one read-only message", () => {
    const sample = sampleProject();
    expect(prefabActions(scene(), sample, [["bird"]]).create?.whyNot).toBe(readOnlyMessage(sample, "create prefabs"));
    expect(prefabActions(scene(), sample, [["bg-b"]]).apply?.whyNot).toBe(readOnlyMessage(sample, "apply overrides"));
    expect(prefabActions(scene(), sample, [["bg-b"]]).revertAll?.whyNot).toBeNull(); // edits only the scene
    expect(prefabActions(scene(), null, [["bird"]]).create?.whyNot).toBe("No project is open.");
  });
});

describe("running the prefab actions", () => {
  it("Create Prefab turns one node into an instance of a new file, keeps it selected and says so; undo is one step", async () => {
    const { doc, stack } = scene();
    const path = await createPrefabFrom(scene(), project, [["ceiling"]]);
    expect(path).toBe("prefabs/ceiling.prefab.json");
    expect(fileOf(path!).nodes[0]).toMatchObject({ name: "Ceiling" });
    expect(doc.node("ceiling").prefab).toBe(path);
    expect(selection.value).toBe("ceiling");
    expect(status.value).toEqual({ kind: "info", text: `Created ${path}. Undo turns the node back; the file stays on disk.` });
    stack.undo();
    expect(doc.node("ceiling").prefab).toBeUndefined();
  });

  it("Create Prefab says how many references out of the prefab became instance overrides (ADR 0401)", async () => {
    const path = await createPrefabFrom(scene(), project, [["game"]]);
    expect(status.value).toEqual({
      kind: "info",
      text: `Created ${path}. 3 references to nodes outside the prefab became instance overrides; the prefab file leaves them empty. Undo turns the node back; the file stays on disk.`,
    });
    expect(scene().doc.node("game").overrides).toHaveLength(3);
  });

  it("Create Prefab saves several siblings under one Group root", async () => {
    const { doc } = scene();
    const path = await createPrefabFrom(scene(), project, [["ceiling"], ["ground-collider"]]);
    expect(fileOf(path!).nodes[0]).toMatchObject({ name: "Group" });
    expect(doc.has("ceiling") || doc.has("ground-collider")).toBe(false);
    expect(status.value?.text).toBe(`Created ${path}. Undo turns the nodes back; the file stays on disk.`);
  });

  it("a refused action says why in the status bar and writes nothing", async () => {
    const sample = sampleProject();
    const before = fs.files.size;
    expect(await createPrefabFrom(scene(), sample, [["bird"]])).toBeNull();
    expect(status.value).toEqual({ kind: "info", text: readOnlyMessage(sample, "create prefabs") });
    expect(await createPrefabFrom(scene(), project, [["ceiling"], ["bird-sprite"]])).toBeNull();
    expect(status.value?.text).toBe("The nodes must share a parent to become one prefab.");
    expect(await applyPrefabOverrides(scene(), project, [["bg-a"]])).toBeNull();
    expect(status.value?.text).toBe("This instance has no overrides.");
    expect(fs.files.size).toBe(before);
    expect(scene().doc.node("bird").prefab).toBeUndefined();
  });

  it("an action that fails shows the error", async () => {
    // The game manager references the bird, which would move into the prefab.
    expect(await createPrefabFrom(scene(), project, [["bird"], ["ceiling"]])).toBeNull();
    expect(status.value).toMatchObject({ kind: "error", text: expect.stringContaining("references") });
    expect(scene().doc.has("bird")).toBe(true);
  });

  it("Apply writes one instance's overrides into its prefab and says where", async () => {
    scene().stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "color", "#ff0000"));
    expect(await applyPrefabOverrides(scene(), project, [["bg-a"]])).toBe(1);
    expect(fileOf("prefabs/background.prefab.json").nodes[0].components!.find((c) => c.type === "engine.SpriteRenderer")?.data).toMatchObject({ color: "#ff0000" });
    expect(scene().doc.node("bg-a").overrides).toBeUndefined();
    expect(status.value?.text).toBe("Applied 1 override to prefabs/background.prefab.json. Undo restores them here; the prefab file keeps the change.");
  });

  it("Apply on several instances writes the ones with overrides", async () => {
    scene().stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "color", "#00ff00"));
    expect(await applyPrefabOverrides(scene(), project, [["bg-a"], ["bg-b"], ["ground-a"]])).toBe(2);
    expect(status.value?.text).toBe("Applied 2 overrides from 2 instances.");
  });

  it("Revert All removes every override of the instance as one undo step", () => {
    const { doc, stack } = scene();
    scene().stack.execute(new SetField("bg-b", "engine.SpriteRenderer", "color", "#ff0000"));
    expect(revertAllOverrides(scene(), [["bg-b"]])).toBe(2);
    expect(doc.node("bg-b").overrides).toBeUndefined();
    expect(stack.undoLabel).toBe("Revert all overrides");
    stack.undo();
    expect(doc.node("bg-b").overrides).toHaveLength(2);
    expect(revertAllOverrides(scene(), [["bg-a"]])).toBe(0);
  });
});

describe("during play (ADR 0257)", () => {
  it("leaves the scene document alone: every header action is refused through the edit gate, with its one wording", () => {
    playState.value = "playing";
    try {
      const states = scene().stack.allStates.length;
      expect(renameNode(scene(), ["bird"], "Robin")).toBe(false);
      expect(setNodesActive(scene(), [["bird"]], false)).toBe(0);
      expect(status.value?.text).toBe("Stop playing to edit the scene.");
      expect(prefabActions(scene(), project, [["bird"]]).create?.whyNot).toBe("Stop playing to create prefabs.");
      expect(prefabActions(scene(), project, [["bg-b"]]).revertAll?.whyNot).toBe("Stop playing to revert overrides.");
      expect(revertAllOverrides(scene(), [["bg-b"]])).toBe(0);
      expect(scene().stack.allStates).toHaveLength(states);
    } finally {
      playState.value = "edit";
    }
  });
});

describe("changing a node's id", () => {
  it("refuses an empty id, one with a slash, and one another node has", () => {
    const { doc } = scene();
    expect(nodeIdProblem(doc, "bird", "  ")).toMatch(/empty/);
    expect(nodeIdProblem(doc, "bird", "a/b")).toMatch(/"\/"/);
    expect(nodeIdProblem(doc, "bird", "ceiling")).toMatch(/already/);
    expect(nodeIdProblem(doc, "bird", "bird")).toBeNull();
    expect(nodeIdProblem(doc, "bird", " hero ")).toBeNull();
  });

  it("renames the entry, children's parents and references as one undo step, and follows the selection", () => {
    const { doc, stack } = scene();
    stack.execute(new AddNode({ id: "child" }, { parent: "bird" }));
    stack.execute(new AddNode({ id: "watcher", components: [{ type: "t.Watch", data: { target: { $node: "bird" }, list: [{ $node: "bird" }, { $node: "ceiling" }] } }] }));
    select(["bird/x", "watcher"], "bird/x");
    expect(renameNodeId(scene(), "bird", "hero")).toBeNull();
    expect(stack.undoLabel).toBe("Change Id");
    expect(doc.has("bird")).toBe(false);
    expect(doc.node("hero").name).toBe("Bird");
    expect(doc.node("child").parent).toBe("hero");
    expect(doc.node("watcher").components![0].data).toEqual({ target: { $node: "hero" }, list: [{ $node: "hero" }, { $node: "ceiling" }] });
    expect(selectedKeys.value).toEqual(["watcher", "hero/x"]);
    stack.undo();
    expect(doc.has("bird")).toBe(true);
    expect(doc.node("child").parent).toBe("bird");
    expect(doc.node("watcher").components![0].data).toMatchObject({ target: { $node: "bird" } });
    select([]);
  });

  it("changes nothing and reports why when the id isn't allowed", () => {
    const before = scene().stack.undoLabel;
    expect(renameNodeId(scene(), "bird", "ceiling")).toMatch(/already/);
    expect(renameNodeId(scene(), "bird", "")).toMatch(/empty/);
    expect(renameNodeId(scene(), "bird", "bird")).toBeNull();
    expect(scene().doc.has("bird")).toBe(true);
    expect(scene().stack.undoLabel).toBe(before);
  });
});
