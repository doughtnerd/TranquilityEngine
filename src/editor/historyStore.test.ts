import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { MemoryStorage } from "../engine/platform/Storage";
import { CommandStack, SceneDocument, SetField, type HistoryFile } from "./document";
import { attachHistory, slotsFor } from "./historyPersistence";
import { HistoryStore, projectSlots, readSlot, userSlots, type SlotBackend } from "./historyStore";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile, saveOpenScene } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, sampleProject } from "./testing";

/** A slot backend in memory, optionally tearing the next write (simulating a crash mid-write). */
function memorySlots(): SlotBackend & { slots: Record<string, string>; tearNext: boolean } {
  return {
    where: "memory",
    slots: {},
    tearNext: false,
    async read(slot) {
      return this.slots[slot] ?? null;
    },
    async write(slot, text) {
      if (this.tearNext) {
        this.tearNext = false;
        this.slots[slot] = text.slice(0, Math.floor(text.length / 2)); // half a file
        throw new Error("crashed mid-write");
      }
      this.slots[slot] = text;
    },
  };
}

const historyOf = (n: number): HistoryFile => ({ format: "myco.history@1", scene: "s", root: 0, current: n, saved: 0, nextSeq: n + 1, states: [] });

describe("history slots (ADR 0027)", () => {
  it("rejects torn and tampered slots", () => {
    expect(readSlot(null)).toBeNull();
    expect(readSlot('{"format":"myco.history-slot@1","gen')).toBeNull();
    const good = JSON.stringify({ format: "myco.history-slot@1", generation: 1, checksum: "x", history: historyOf(1) });
    expect(readSlot(good)).toBeNull(); // wrong checksum
  });

  it("alternates between the two slots and loads the newest", async () => {
    const backend = memorySlots();
    const store = new HistoryStore(backend);
    await store.save(historyOf(1));
    await store.save(historyOf(2));
    await store.save(historyOf(3));
    expect(readSlot(backend.slots.a)!.generation).toBe(3);
    expect(readSlot(backend.slots.b)!.generation).toBe(2);
    expect((await new HistoryStore(backend).load())!.current).toBe(3);
  });

  it("a crash mid-write leaves the previous generation intact", async () => {
    const backend = memorySlots();
    const store = new HistoryStore(backend);
    await store.save(historyOf(1));
    await store.save(historyOf(2));
    backend.tearNext = true;
    await expect(store.save(historyOf(3))).rejects.toThrow(/mid-write/);
    expect(readSlot(backend.slots.a)).toBeNull(); // the torn slot
    expect((await new HistoryStore(backend).load())!.current).toBe(2); // the other slot survives
  });

  it("keeps saving in alternation after loading", async () => {
    const backend = memorySlots();
    await new HistoryStore(backend).save(historyOf(1));
    const store = new HistoryStore(backend);
    await store.load();
    await store.save(historyOf(2));
    expect(readSlot(backend.slots.b)!.generation).toBe(2); // didn't overwrite generation 1
  });
});

describe("history files on disk", () => {
  let fs: MemoryFileSystem;
  let project: EditorProject;

  async function open(): Promise<void> {
    project = await openFolderProject(fs, ROOT); // reads the files as they are now
    useProjectAssets(project);
    currentProject.value = project;
    Input.reset();
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, project.mainScene!);
  }

  const setY = (y: number) => openScene.value!.stack.execute(new SetField("bird", "engine.Transform", "position", [-4, y, 0]));
  const birdY = () => (openScene.value!.doc.fieldValue("bird", "engine.Transform", "position") as number[])[1];
  const platform = () => ({ fs, userStorage: new MemoryStorage() });

  beforeEach(async () => {
    fs = demoFolder();
    await open();
  });

  it("goes in the project folder by default, per user when asked or when the project is read-only", () => {
    expect(slotsFor(project, "scenes/main.scene.json", "project", platform()).where).toBe(joinPath(ROOT, ".myco/history"));
    expect(slotsFor(project, "scenes/main.scene.json", "user", platform()).where).toBe("per-user storage");
    expect(slotsFor(sampleProject(), "scenes/main.scene.json", "project", platform()).where).toBe("per-user storage");
  });

  it("survives the editor closing with unsaved changes, and offers them back", async () => {
    let history = await attachHistory(openScene.value!.stack, "scenes/main.scene.json", projectSlots(fs, ROOT, "scenes/main.scene.json"));
    setY(2);
    await saveOpenScene(); // the file on disk now has y = 2
    setY(3);
    setY(4); // unsaved when the editor "crashes"
    await history.flush();
    expect(fs.files.has(joinPath(ROOT, ".myco/history/scenes/main.scene.json.history.a.json"))).toBe(true);

    await open(); // a fresh editor reading the files from disk
    history = await attachHistory(openScene.value!.stack, "scenes/main.scene.json", projectSlots(fs, ROOT, "scenes/main.scene.json"));
    expect(birdY()).toBe(2); // the saved file
    expect(history.restorable?.label).toBe("Set position");
    openScene.value!.stack.jumpTo(history.restorable!.seq);
    expect(birdY()).toBe(4);
    expect(openScene.value!.stack.dirty).toBe(true);
    openScene.value!.stack.undo();
    openScene.value!.stack.undo();
    openScene.value!.stack.undo();
    expect(birdY()).toBe(1); // all the way back to before the first edit
  });

  it("sets aside history that no longer matches the file", async () => {
    await attachHistory(openScene.value!.stack, "scenes/main.scene.json", projectSlots(fs, ROOT, "scenes/main.scene.json"));
    setY(2);
    await new Promise((r) => setTimeout(r, 0));
    // Someone edits the scene outside the editor.
    const path = joinPath(ROOT, "scenes/main.scene.json");
    fs.files.set(path, (fs.files.get(path) as string).replace('"Ceiling"', '"Roof"'));
    await open();
    const history = await attachHistory(openScene.value!.stack, "scenes/main.scene.json", projectSlots(fs, ROOT, "scenes/main.scene.json"));
    expect(history.mismatched).toBe(true);
    expect(history.restorable).toBeNull();
    expect(openScene.value!.stack.allStates).toHaveLength(1);
  });

  it("can move to per-user storage mid-session", async () => {
    const user = new MemoryStorage();
    const history = await attachHistory(openScene.value!.stack, "scenes/main.scene.json", projectSlots(fs, ROOT, "scenes/main.scene.json"));
    await history.relocate(userSlots(user, ROOT, "scenes/main.scene.json"));
    setY(5);
    await history.flush();
    const stack2 = new CommandStack(new SceneDocument(openScene.value!.doc.toJSON()));
    const loaded = await new HistoryStore(userSlots(user, ROOT, "scenes/main.scene.json")).load();
    expect(stack2.load(loaded!)).not.toBeNull();
    expect(history.where).toBe("per-user storage");
  });
});
