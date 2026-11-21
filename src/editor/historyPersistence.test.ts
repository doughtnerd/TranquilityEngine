import { signal, type Signal } from "@preact/signals";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage, type StorageNamespace, type StorageValue } from "../engine/platform/Storage";
import { CommandStack, SceneDocument, SetField, TextHistory, type SceneFile } from "./document";
import { deleteAssetHistories, moveAssetHistories, persistHistory, sceneHistory, type HistoryLocation, type HistoryOptions, type PersistedTree } from "./historyPersistence";
import type { EditorPlatform } from "./projectPlace";
import { joinPath, openFolderProject, type EditorProject } from "./projects";
import { DEMO_SCENE, MemoryFileSystem, ROOT, demoFolder, sampleProject } from "./testing";

// Edit history on disk (ADR 0027, 0141, 0316), through the one persistence interface both hosts use, over an
// in-memory platform: the project folder in a MemoryFileSystem, per-user storage in memory.

/** Per-user storage in memory that counts writes and can fail them. */
class CountingStorage extends MemoryStorage {
  saves = 0;
  fail = false;
  override async save(ns: StorageNamespace, key: string, value: StorageValue): Promise<void> {
    this.saves++;
    if (this.fail) throw new Error("disk full");
    return super.save(ns, key, value);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const HISTORY_DIR = joinPath(ROOT, ".myco/history");

describe("edit history persistence (ADR 0316)", () => {
  let fs: MemoryFileSystem;
  let project: EditorProject;
  let user: CountingStorage;
  let platform: EditorPlatform;
  let location: Signal<HistoryLocation>;
  let failures: unknown[];

  beforeEach(async () => {
    fs = demoFolder();
    project = await openFolderProject(fs, ROOT);
    user = new CountingStorage();
    platform = { fs: null, userStorage: user };
    location = signal<HistoryLocation>("project");
    failures = [];
  });

  const sceneFile = () => JSON.parse(fs.files.get(joinPath(ROOT, DEMO_SCENE).replace(/\//g, "\\")) as string) as SceneFile;
  /** Open a history, wait for its load (and first write), and stop it. */
  const openAndStop = async (tree: PersistedTree, path: string) => {
    const h = persist(tree, path);
    await h.loaded;
    await h.stop();
  };
  const persist = (tree: PersistedTree, path: string, extra: Partial<HistoryOptions> = {}) =>
    persistHistory({ project, kind: "scene", tree, path: () => path, location, platform: async () => platform, pruneDays: () => 0, saveFailed: (err) => failures.push(err), ...extra });
  const setY = (stack: CommandStack, y: number) => stack.execute(new SetField("bird", "engine.Transform", "position", [-4, y, 0]));
  const historyFiles = () => [...fs.files.keys()].filter((k) => k.startsWith(HISTORY_DIR));

  it("writes into the project folder by default, per user when asked, and per user for a read-only project", async () => {
    const stack = new CommandStack(new SceneDocument(sceneFile(), DEMO_SCENE));
    const inFolder = persist(sceneHistory(stack, DEMO_SCENE), DEMO_SCENE);
    expect(await inFolder.loaded).toEqual({ kind: "new" });
    await inFolder.stop();
    expect(historyFiles()).toEqual([joinPath(ROOT, ".myco/history/scenes/main.scene.json.history.a.json").replace(/\//g, "\\")]);
    expect(await user.list("cache")).toEqual([]);

    location.value = "user";
    await openAndStop(sceneHistory(stack, DEMO_SCENE), DEMO_SCENE);
    expect(await user.list("cache")).toHaveLength(1);

    location.value = "project";
    project = sampleProject();
    await openAndStop(sceneHistory(stack, "scenes/other.scene.json"), "scenes/other.scene.json");
    expect(await user.list("cache")).toHaveLength(2);
  });

  it("adopts a matching history, saying where it was ahead of the file (unsaved changes when the editor closed)", async () => {
    const stack = new CommandStack(new SceneDocument(sceneFile(), DEMO_SCENE));
    const history = persist(sceneHistory(stack, DEMO_SCENE), DEMO_SCENE);
    stack.subscribe(() => history.save());
    await history.loaded;
    setY(stack, 2);
    stack.markSaved(); // the file on disk now has y = 2
    const onDisk = stack.doc.toJSON();
    setY(stack, 3);
    setY(stack, 4);
    await history.stop();

    const reopened = new CommandStack(new SceneDocument(onDisk, DEMO_SCENE));
    const again = persist(sceneHistory(reopened, DEMO_SCENE), DEMO_SCENE);
    const outcome = await again.loaded;
    expect(outcome.kind).toBe("adopted");
    const ahead = outcome.kind === "adopted" ? outcome.ahead : null;
    expect(reopened.allStates.find((s) => s.seq === ahead)?.label).toBe("Set position");
    reopened.jumpTo(ahead!);
    expect((reopened.doc.fieldValue("bird", "engine.Transform", "position") as number[])[1]).toBe(4);
    await again.stop();
  });

  it("sets aside a history that no longer matches the file, and writes a new one over it", async () => {
    const stack = new CommandStack(new SceneDocument(sceneFile(), DEMO_SCENE));
    const history = persist(sceneHistory(stack, DEMO_SCENE), DEMO_SCENE);
    stack.subscribe(() => history.save());
    setY(stack, 2);
    await history.stop();

    // Someone edits the scene outside the editor.
    const changed = JSON.parse(JSON.stringify(sceneFile()).replace('"Ceiling"', '"Roof"')) as SceneFile;
    const other = new CommandStack(new SceneDocument(changed, DEMO_SCENE));
    const again = persist(sceneHistory(other, DEMO_SCENE), DEMO_SCENE);
    expect(await again.loaded).toEqual({ kind: "set aside", why: "changed" });
    expect(other.allStates).toHaveLength(1);
    await again.stop();
  });

  it("lets edits made before the saved history loaded win: the history is set aside as edited, not 'changed'", async () => {
    const tree = new TextHistory("a", "notes/a.txt");
    const first = persist(tree, "notes/a.txt", { kind: "asset" });
    tree.record("Type", "ab");
    first.save();
    await first.stop();

    const slow = deferred<EditorPlatform>();
    const reopened = new TextHistory("a", "notes/a.txt");
    const second = persist(reopened, "notes/a.txt", { kind: "asset", platform: () => slow.promise });
    reopened.record("Type", "ac"); // edited while the history loads
    second.save();
    slow.resolve(platform);
    expect(await second.loaded).toEqual({ kind: "set aside", why: "edited" });
    expect(reopened.text).toBe("ac");
    await second.stop();

    const third = new TextHistory("ac", "notes/a.txt");
    const after = persist(third, "notes/a.txt", { kind: "asset" });
    expect((await after.loaded).kind).toBe("adopted"); // the edits' history is the one on disk now
    await after.stop();
  });

  it("writes a burst of changes together, and reports a failing streak once", async () => {
    location.value = "user";
    const tree = new TextHistory("", "notes/a.txt");
    const history = persist(tree, "notes/a.txt", { kind: "asset" });
    await history.written();
    const before = user.saves;
    for (let i = 1; i <= 20; i++) {
      tree.record("Type", "x".repeat(i));
      history.save();
    }
    await history.written();
    expect(user.saves - before).toBe(1);

    user.fail = true;
    for (let i = 0; i < 3; i++) {
      tree.record("Type", `fail ${i}`);
      history.save();
      await history.written();
    }
    expect(failures).toHaveLength(1);
    user.fail = false;
    tree.record("Type", "ok");
    history.save();
    await history.written();
    user.fail = true;
    tree.record("Type", "fail again");
    history.save();
    await history.written();
    expect(failures).toHaveLength(2); // a new streak
    user.fail = false;
    await history.stop();
  });

  it("follows the location setting while open, writing the whole tree in the new place", async () => {
    const stack = new CommandStack(new SceneDocument(sceneFile(), DEMO_SCENE));
    const history = persist(sceneHistory(stack, DEMO_SCENE), DEMO_SCENE);
    stack.subscribe(() => history.save());
    setY(stack, 2);
    await history.written();
    expect(await user.list("cache")).toEqual([]);
    location.value = "user";
    await history.written();
    expect(await user.list("cache")).toHaveLength(1);
    await history.stop();
    location.value = "project"; // stopped: no longer followed
    const files = historyFiles().length;
    await new Promise((r) => setTimeout(r, 0));
    expect(historyFiles()).toHaveLength(files);
  });

  it("moves and removes an asset's history with its file, in order with the saves", async () => {
    const tree = new TextHistory("a", "notes/a.txt");
    const history = persist(tree, "notes/a.txt", { kind: "asset" });
    tree.record("Type", "ab");
    history.save();
    const moved = moveAssetHistories(project, [["notes", "docs"]], async () => platform);
    tree.path = "docs/a.txt";
    history.relocate();
    await Promise.all([moved, history.stop()]);
    const assetFiles = () => [...fs.files.keys()].filter((k) => k.includes("asset-history")).map((k) => k.slice(ROOT.length + 1).replace(/\\/g, "/"));
    expect(assetFiles().every((f) => f.startsWith(".myco/asset-history/docs/a.txt.history."))).toBe(true);
    const reopened = persist(new TextHistory("ab", "docs/a.txt"), "docs/a.txt", { kind: "asset" });
    expect((await reopened.loaded).kind).toBe("adopted");
    await reopened.stop();

    await deleteAssetHistories(project, ["docs/a.txt"], async () => platform);
    expect(assetFiles()).toEqual([]);
  });
});
