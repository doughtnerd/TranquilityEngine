// The editor SDK's project and editor surface (ADR 0147): `editor.project`, `editor.assets`,
// `editor.messages` and `editor.scene` read and change the shell's state, and their getters track.
import { computed } from "@preact/signals";
import { afterEach, describe, expect, it } from "vitest";
import { status } from "../state";
import { closeTestProject, openTestProject, sampleProject, useCoreAssetKinds } from "../testing";
import { editor } from "./index";
import * as sdk from "./index";

useCoreAssetKinds();

afterEach(closeTestProject);

describe("editor.project", () => {
  it("is the open project, tracked like the signal it reads", async () => {
    const current = computed(() => editor.project.current);
    expect(current.value).toBeNull();
    const { project } = await openTestProject();
    expect(current.value).toBe(project);
    expect(editor.project.peek()).toBe(project);
  });

  it("bumps its version on changed(), so computeds reading it re-run", () => {
    let runs = 0;
    const seen = computed(() => (runs++, editor.project.version));
    const before = seen.value;
    editor.project.changed();
    expect(seen.value).toBe(before + 1);
    expect(editor.project.peekVersion()).toBe(before + 1);
    expect(runs).toBe(2);
  });

  it("creates a file under a free name, reports it and bumps the version", async () => {
    const { project, fs } = await openTestProject({ "skies/New Sky.sky.json": "{}" });
    const version = editor.project.version;
    const path = await editor.project.createFile({ folder: "skies", name: "New Sky.sky.json", what: "skies", write: (p, at) => p.writeText(at, '{"a":1}') });
    expect(path).toBe("skies/New Sky 2.sky.json");
    expect([...fs.files.values()]).toContain('{"a":1}');
    expect(project.files).toContain(path);
    expect(editor.project.version).toBe(version + 1);
    expect(status.value).toMatchObject({ kind: "info", text: "Created New Sky 2.sky.json." });
  });

  it("reports a failed write as an error and returns null", async () => {
    await openTestProject();
    const path = await editor.project.createFile({ folder: "", name: "x.json", what: "things", write: () => Promise.reject(new Error("disk full")) });
    expect(path).toBeNull();
    expect(status.value).toMatchObject({ kind: "error", text: "Couldn't create x.json: disk full" });
  });

  it("refuses in a read-only project with one message", async () => {
    const sample = sampleProject();
    expect(editor.project.refuseReadOnly(sample, "skies")).toBe(true);
    expect(status.value?.text).toBe("Flappy sample is read-only. Open a project folder (or copy the sample) to add skies.");
    expect(await editor.project.createFile({ folder: "", name: "a.json", what: "skies", write: async () => {} })).toBeNull(); // no project open
  });

  it("finds free paths and joins disk paths", async () => {
    const { project } = await openTestProject({ "a/b.json": "{}" });
    expect(editor.project.freePath(project, "a", "b.json")).toBe("a/b 2.json");
    expect(editor.project.freePath(project, "a", "b.json", true)).toBe("a/b copy.json");
    expect(editor.project.joinPath("C:\\Games\\x", "a/b.json")).toBe("C:\\Games\\x\\a\\b.json");
  });
});

describe("editor.assets", () => {
  it("names paths: kind, file name, folder, listed files, scenes", () => {
    expect(editor.assets.kindOf("scenes/main.scene.json")).toBe("scene");
    expect(editor.assets.kindOf("x.unknownext")).toBe("other");
    expect(editor.assets.fileName("images/bird.png")).toBe("bird.png");
    expect(editor.assets.folderOf("images/bird.png")).toBe("images");
    expect(editor.assets.folderOf("project.json")).toBe("");
    expect(editor.assets.isScene("a.prefab.json")).toBe(true);
    expect(editor.assets.listed(["a.png", "a.png.meta.json"])).toEqual(["a.png"]);
  });
});

describe("editor.messages", () => {
  it("shows info and errors in the status bar (the log follows it)", () => {
    editor.messages.info("Hello", "more");
    expect(status.value).toEqual({ kind: "info", text: "Hello", detail: "more" });
    editor.messages.failed("Couldn't bake", new Error("no chunk"));
    expect(status.value).toMatchObject({ kind: "error", text: "Couldn't bake: no chunk" });
    editor.messages.clear();
    expect(status.value).toBeNull();
  });
});

describe("editor.scene", () => {
  it("reads the selection and selects, tracked", () => {
    const active = computed(() => editor.scene.selection.active);
    editor.scene.selection.set(["a", "b"]);
    expect(editor.scene.selection.keys).toEqual(["a", "b"]);
    expect(active.value).toBe("b");
    editor.scene.selection.set(["a", "b"], "a");
    expect(editor.scene.selection.peekActive()).toBe("a");
    expect(editor.scene.selection.path()).toEqual(["a"]);
    expect(editor.scene.selection.node()).toBeNull(); // no scene open
    expect(editor.scene.open).toBeNull();
    expect(editor.scene.playState).toBe("edit");
  });

  it("makes node ids", () => {
    const doc = { has: (id: string) => id === "bird" } as unknown as sdk.SceneDocument;
    expect(editor.scene.idBase("images/flappyBird.png")).toBe("flappy-bird");
    expect(editor.scene.uniqueId(doc, "bird")).toBe("bird-2");
  });
});

describe("myco/editor", () => {
  it("exports the surface and the building blocks plugins use, not the shell's signals", () => {
    for (const name of ["editor", "openAssetDocument", "SetField", "pathKey", "sectionField", "LargePreview", "TextField", "NumberField", "theme", "persisted", "useGraphCanvas"]) expect(sdk).toHaveProperty(name);
    for (const name of ["currentProject", "docVersion", "status", "openScene", "selectedKeys"]) expect(sdk).not.toHaveProperty(name);
  });
});
