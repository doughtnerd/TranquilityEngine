// The Studio asset library (ADR 0433) driven through its interface, as the screens drive it, over a project in memory:
// moves and renames with and without the editor holding the project (ADR 0341: references rewritten, or left for the
// editor in pending-moves.json), names checked and extensions kept, companions moving, copying and deleting with
// their file, the open file following and closing, deletes into the trash and folder deletes moving the contents up,
// each with Undo on the toast, collisions numbered, and imports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAssetDocument, type AssetDocument } from "../../editor/assetDocuments";
import { acquireLock, parsePendingMoves } from "../../editor/projectLocks";
import { joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../../editor/projects";
import { assetKinds, type AssetKindContribution } from "../../editor/sdk/contributions";
import { currentProject, status } from "../../editor/state";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "../../editor/testing";
import { toasts } from "../shell/studioServices";
import { studioLibrary, type LibraryKind } from "./studioLibrary";

useCoreAssetKinds();

interface Thing {
  n: number;
  clip?: string;
}

const THING = "things/a.thing.json";
const SCENE = "main.scene.json";
const TAKE = "recordings/run.take";
const NOTES = "recordings/run.take.notes.json";
const sceneText = JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "a", name: "Music", components: { "engine.AudioSource": { clip: "music/town.mp3" } } }] }, null, 2);

let fs: MemoryFileSystem;
let project: EditorProject;
let unregister: () => void;
const opened = new Set<AssetDocument<Thing>>();
const at = (path: string) => joinPath(ROOT, path);
const onDisk = (path: string) => fs.files.get(at(path));

/** What the screen saw: the file it has open, and each call the library made back into it. */
let open: string | null;
let calls: string[];

/** A kind like the run files': a take's notes go with it; the open file follows and closes. */
function kind(extra: Partial<LibraryKind> = {}): LibraryKind {
  return {
    noun: "take",
    companions: (files, path) => (files.includes(`${path}.notes.json`) ? [path, `${path}.notes.json`] : [path]),
    openPaths: () => (open ? [open] : []),
    open: (path) => (calls.push(`open ${path}`), (open = path)),
    follow: (from, to) => (calls.push(`follow ${from} → ${to}`), (open = to)),
    closed: (path) => (calls.push(`closed ${path}`), (open = null)),
    imports: { defaultFolder: "recordings", whyNotFile: (name) => (name.endsWith(".take") ? null : `${name} isn't a take file.`) },
    ...extra,
  };
}

/** Press Undo on the newest toast; what it does finishes later. */
function undoLastToast(): void {
  const t = toasts.toasts.peek().at(-1);
  expect(t?.undoLabel).toBe("Undo");
  toasts.undo(t!.id);
}
const lastToast = () => toasts.toasts.peek().at(-1)?.text;

beforeEach(async () => {
  unregister = assetKinds.register(<AssetKindContribution<Thing>>{
    id: "thing",
    extensions: [".thing.json"],
    label: "Thing",
    icon: "",
    format: {
      parse: (raw) => {
        const o = (raw ?? {}) as { n?: unknown; clip?: unknown };
        return { value: { n: typeof o.n === "number" ? o.n : 0, ...(typeof o.clip === "string" ? { clip: o.clip } : {}) }, problems: [] };
      },
      format: (value) => `${JSON.stringify(value)}\n`,
      empty: () => ({ n: 0 }),
      writeDelay: 10,
    },
  });
  fs = new MemoryFileSystem();
  fs.files.set(at("project.json"), "{}");
  fs.files.set(at(THING), '{ "n": 1, "clip": "music/town.mp3" }');
  fs.files.set(at(SCENE), sceneText);
  fs.files.set(at("music/town.mp3"), new Uint8Array([1, 2, 3]));
  fs.files.set(at(TAKE), new Uint8Array([4, 5]));
  fs.files.set(at(NOTES), '{"markers":[]}');
  fs.files.set(at("sfx/door.wav"), new Uint8Array([6]));
  fs.files.set(at("sfx/door.wav.meta.json"), "{}");
  fs.files.set(at("sfx/inner/step.wav"), new Uint8Array([7]));
  fs.files.set(at("door.wav"), new Uint8Array([8]));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  open = null;
  calls = [];
});

afterEach(async () => {
  await Promise.all([...opened].map((d) => d.flush()));
  opened.clear();
  for (const t of toasts.toasts.peek()) toasts.dismiss(t.id);
  currentProject.value = null;
  status.value = null;
  unregister();
});

describe("moves and renames (ADR 0341)", () => {
  it("with no editor holding the project, rewrites every reference itself, scenes included", async () => {
    const lib = studioLibrary(kind());
    expect(await lib.move(["music/town.mp3"], "audio")).toBe(true);
    expect(project.files).toContain("audio/town.mp3");
    expect(onDisk(SCENE)).toContain('"clip": "audio/town.mp3"');
    expect(JSON.parse(onDisk(THING) as string)).toMatchObject({ clip: "audio/town.mp3" });
    expect(onDisk(".myco/locks/pending-moves.json")).toBeUndefined();
    expect(lastToast()).toBe("town.mp3 → audio");
  });

  it("with the editor holding it, leaves the moves for the editor and rewrites only the Studio's own files", async () => {
    await acquireLock(fs, ROOT, "editor", 7);
    const doc = openAssetDocument<Thing>(project, THING, "thing");
    opened.add(doc);
    expect(await studioLibrary(kind()).renameFile("music/town.mp3", "theme")).toBe(true);
    expect(parsePendingMoves(onDisk(".myco/locks/pending-moves.json") as string).moves).toEqual([{ from: "music/town.mp3", to: "music/theme.mp3" }]);
    expect(onDisk("music/town.mp3")).toBeUndefined();
    expect(onDisk(SCENE)).toBe(sceneText); // the editor's to rewrite
    expect(doc.value.value).toMatchObject({ clip: "music/theme.mp3" }); // an open document follows in its history
    expect(status.value?.text).toMatch(/^Renamed music\/town\.mp3 to music\/theme\.mp3\. .*The editor has the project open/);
  });

  it("with the editor holding it, a folder delete's moves up are left for it too", async () => {
    await acquireLock(fs, ROOT, "editor", 7);
    expect(await studioLibrary(kind()).deleteFolder("music")).toBe(true);
    expect(parsePendingMoves(onDisk(".myco/locks/pending-moves.json") as string).moves).toEqual([{ from: "music/town.mp3", to: "town.mp3" }]);
    expect(onDisk(SCENE)).toBe(sceneText);
  });

  it("refuses a move onto an existing file, leaving nothing for the editor", async () => {
    await acquireLock(fs, ROOT, "editor", 7);
    expect(await studioLibrary(kind()).renameFile("music/town.mp3", "../door.wav")).toBe(false); // "/" isn't a name
    expect(status.value?.text).toMatch(/^Can't rename town\.mp3: a name can't contain/);
    expect(await studioLibrary(kind()).move(["sfx/door.wav"], "")).toBe(false);
    expect(status.value?.text).toMatch(/already exists/);
    expect(onDisk(".myco/locks/pending-moves.json")).toBeUndefined();
  });

  it("a typed name keeps the file's extension; the same name does nothing", async () => {
    const lib = studioLibrary(kind({ extension: () => ".take" }));
    expect(await lib.renameFile(TAKE, "run.take")).toBe(false);
    expect(await lib.renameFile(TAKE, "  ")).toBe(false);
    expect(await lib.renameFile(TAKE, " boss.take ")).toBe(true);
    expect(project.files).toEqual(expect.arrayContaining(["recordings/boss.take", "recordings/boss.take.notes.json"]));
  });

  it("a folder's typed name turns / into -, and the open file inside follows", async () => {
    open = TAKE;
    expect(await studioLibrary(kind()).renameFolder("recordings", "Boss/fight")).toBe(true);
    expect(project.folders).toContain("Boss-fight");
    expect(calls).toEqual([`follow ${TAKE} → Boss-fight/run.take`]);
  });

  it("a file moves with its companions; a folder whole; nothing into where it is or into itself", async () => {
    open = TAKE;
    const lib = studioLibrary(kind());
    expect(await lib.move(["sfx", "sfx/inner"], "sfx/inner")).toBe(false);
    expect(await lib.move(["sfx/inner/step.wav"], "sfx/inner")).toBe(false);
    expect(await lib.move([TAKE], "sfx")).toBe(true);
    expect(project.files).toEqual(expect.arrayContaining(["sfx/run.take", "sfx/run.take.notes.json"]));
    expect(calls).toEqual([`follow ${TAKE} → sfx/run.take`]);
    // What's inside another moved folder goes with it.
    expect(await lib.move(["sfx", "sfx/inner/step.wav"], "music")).toBe(true);
    expect(project.files).toEqual(expect.arrayContaining(["music/sfx/inner/step.wav", "music/sfx/run.take.notes.json"]));
    expect(lastToast()).toBe("sfx → music");
  });

  it("whatever else follows a move hears every move the library made", async () => {
    const heard: string[] = [];
    const lib = studioLibrary(kind({ afterMove: (moves) => void heard.push(...moves.map(([f, t]) => `${f}>${t}`)) }));
    await lib.renameFolder("sfx", "fx");
    await lib.deleteFolder("fx");
    expect(heard).toEqual(["sfx>fx", "fx/inner>inner", "fx/door.wav>door 2.wav"]);
  });
});

describe("duplicate and new folder", () => {
  it("a copy keeps its companions under its own name, and one copy opens", async () => {
    const made = await studioLibrary(kind()).duplicate([TAKE]);
    expect(made).toHaveLength(1);
    expect(project.files).toEqual(expect.arrayContaining([made[0]!, `${made[0]!}.notes.json`]));
    expect(calls).toEqual([`open ${made[0]!}`]);
  });

  it("makes New Folder, then New Folder 2", async () => {
    const lib = studioLibrary(kind());
    expect(await lib.newFolder("recordings")).toBe("recordings/New Folder");
    expect(await lib.newFolder("recordings")).toBe("recordings/New Folder 2");
  });
});

describe("delete into the trash", () => {
  it("takes the companions and the sidecar, closes the open file, and Undo brings them back and reopens it", async () => {
    open = "sfx/door.wav";
    const lib = studioLibrary(kind());
    expect(await lib.deleteFile("sfx/door.wav")).toBe(true);
    expect(project.files).not.toContain("sfx/door.wav");
    expect(project.files).not.toContain("sfx/door.wav.meta.json");
    expect(onDisk(".myco/trash/1/sfx/door.wav.meta.json")).toBe("{}");
    expect(lastToast()).toBe("Deleted door");
    expect(calls).toEqual(["closed sfx/door.wav"]);
    undoLastToast();
    await vi.waitFor(() => expect(project.files).toEqual(expect.arrayContaining(["sfx/door.wav", "sfx/door.wav.meta.json"])));
    expect(calls).toEqual(["closed sfx/door.wav", "open sfx/door.wav"]);
    expect(await lib.deleteFile(TAKE)).toBe(true);
    expect(project.files).not.toContain(NOTES);
  });

  it("Undo is refused when the name was taken meanwhile", async () => {
    await studioLibrary(kind()).deleteFile(TAKE);
    await project.writeBinary(TAKE, new Uint8Array([9]));
    undoLastToast();
    await vi.waitFor(() => expect(status.value?.text).toBe("Can't bring run.take back: run.take is there again."));
  });

  it("runs the kind's own steps around it, in order, and refuses what isn't there", async () => {
    const steps: string[] = [];
    const lib = studioLibrary(kind({ beforeDelete: (p) => void steps.push(`before ${p} ${project.files.includes(p)}`), afterDelete: (p) => void steps.push(`after ${p} ${project.files.includes(p)}`), deletedText: (p) => `Gone: ${p}` }));
    expect(await lib.deleteFile("recordings/none.take")).toBe(false);
    expect(status.value?.text).toBe("Can't delete none.take: it's gone already.");
    expect(await lib.deleteFile(TAKE)).toBe(true);
    expect(steps).toEqual([`before ${TAKE} true`, `after ${TAKE} false`]);
    expect(lastToast()).toBe(`Gone: ${TAKE}`);
  });
});

describe("delete a folder, contents up", () => {
  it("says what moves up, numbers a taken name before its extension, keeps the sidecar with its file, and references follow", async () => {
    const lib = studioLibrary(kind());
    expect(lib.folderDeletePlan("sfx")).toEqual({ items: 2, to: "" });
    expect(await lib.deleteFolder("sfx")).toBe(true);
    expect(project.folders).not.toContain("sfx");
    expect(project.files).toEqual(expect.arrayContaining(["door.wav", "door 2.wav", "door 2.wav.meta.json", "inner/step.wav"]));
    expect(project.files.some((f) => f.startsWith("sfx/"))).toBe(false);
    expect(lastToast()).toBe("Deleted folder sfx; 2 items moved to the top level");

    await lib.deleteFolder("music");
    expect(onDisk(SCENE)).toContain('"clip": "town.mp3"');
  });

  it("Undo puts the folder back with everything in it", async () => {
    await studioLibrary(kind()).deleteFolder("sfx");
    undoLastToast();
    await vi.waitFor(() => expect(project.files).toContain("sfx/inner/step.wav"));
    expect(project.files).toEqual(expect.arrayContaining(["sfx/door.wav", "sfx/door.wav.meta.json", "door.wav"]));
    expect(project.files).not.toContain("door 2.wav");
  });

  it("is refused where the engine's delete rule refuses it", async () => {
    expect(await studioLibrary(kind()).deleteFolder("nowhere")).toBe(false);
    expect(status.value?.text).toBe("Can't delete nowhere: it's gone already.");
  });
});

describe("import", () => {
  it("refuses a file of the wrong kind, and copies the rest into the kind's folder, opening the first", async () => {
    const lib = studioLibrary(kind());
    const file = (name: string) => new File([new Uint8Array([1])], name);
    expect(await lib.importFiles([file("x.wav")], null)).toBeNull();
    expect(status.value?.text).toBe("x.wav isn't a take file.");
    expect(await lib.importFiles([file("new.take")], null)).toBe("recordings/new.take");
    expect(calls).toEqual(["open recordings/new.take"]);
  });

  it("is refused for a kind that doesn't import", async () => {
    expect(await studioLibrary({ noun: "scene" }).importFiles([], null)).toBeNull();
    expect(status.value?.text).toBe("Can't import scenes: scenes aren't imported here.");
  });
});
