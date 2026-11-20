import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import type { SettingsDraft } from "./projectSettingsModel";
import { editorSettings, useProjectAssets, type EditorProject } from "./projects";
import type { NamedList } from "./sdk/contributions";
import { settingsNames, withReferences } from "./settingsNames";
import { openScene, sceneCamera } from "./state";
import { closeTestProject, openTestProject } from "./testing";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

// The settings names module (ADR 0262) over a fake project: two named lists declared as data (a "tags" list that
// component fields, prefab overrides, a nested list path and "*.cue.json" files name, and a "kinds" list), scenes, a
// prefab and a cue file. Renames are found from drafts, users listed and confirmed, files rewritten, undo moves back.

const scene = (...nodes: unknown[]) => ({ format: "myco.scene@1", nodes });
const node = (id: string, components: unknown[], extra: Record<string, unknown> = {}) => ({ id, name: id, components, ...extra });
const tagged = (tag: string) => ({ type: "game.Tagged", data: { tag } });

/** Cue files name tags in `"tag"` members at any depth (a pure rename, as an asset format declares it). */
const renameCue = (json: unknown, from: string, to: string): unknown => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "tag" && x === from ? to : walk(x)]));
  };
  return JSON.stringify(json).includes(JSON.stringify(from)) ? walk(json) : json;
};

const TAGS: NamedList = {
  id: "game.tags",
  noun: "tag",
  names: (d) => ((d.game as { tags?: string[] } | undefined)?.tags ?? ["Default"]),
  fields: [{ component: ["game.Tagged", "game.Marker"], field: "tag" }, { component: "game.Group", field: "members.*.tag" }],
  assets: [{ extensions: [".cue.json"], rename: renameCue }],
};
const KINDS: NamedList = { id: "game.kinds", noun: "kind", names: (d) => ((d.game as { kinds?: string[] } | undefined)?.kinds ?? []), fields: [{ field: "kind" }] };

const draft = (tags: string[], kinds: string[] = ["A"], extra: Record<string, unknown> = {}): SettingsDraft => ({ game: { tags, kinds, ...extra } });

const FILES = {
  "a.scene.json": JSON.stringify(scene(node("n", [tagged("Ground"), { type: "game.Other", data: { tag: "Ground" } }, { type: "game.Group", data: { members: [{ tag: "Ground" }, { tag: "Default" }] } }]))),
  "b.prefab.json": JSON.stringify(scene(node("i", [], { prefab: "c.prefab.json", overrides: [{ target: ["x"], component: "game.Marker", field: "tag", value: "Ground" }, { target: ["x"], component: "game.Other", field: "tag", value: "Ground" }] }))),
  "c.prefab.json": JSON.stringify(scene(node("x", [tagged("Default")]))),
  "sfx/hit.cue.json": JSON.stringify({ steps: [{ tag: "Ground" }, { tag: "Default" }] }),
  "notes.json": JSON.stringify({ tag: "Ground" }),
};

afterEach(() => {
  openScene.value = null;
  closeTestProject();
});

function names(answer = true, lists: readonly NamedList[] = [TAGS, KINDS]) {
  const asked: ConfirmOptions[] = [];
  const confirm = vi.fn(async (q: ConfirmOptions) => (asked.push(q), answer));
  return { names: settingsNames({ lists: () => lists, confirm }), asked, confirm };
}

const json = (project: EditorProject, path: string) => JSON.parse(project.textOf(path)!);

describe("settings names: an edit that renames a list entry", () => {
  it("asks first, listing the files that name it, then renames the declared fields, overrides, nested lists and asset files", async () => {
    const { project } = await openTestProject(FILES);
    const { names: n, asked } = names();
    const before = draft(["Default", "Ground"]), next = draft(["Default", "Floor"]);
    await expect(n.editing(project, before, next)).resolves.toEqual(next);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: "Rename tag", confirmLabel: "Rename and update", message: 'Rename the tag "Ground" to "Floor"? 3 files use it; they will be updated.' });
    expect([...asked[0].items!].sort()).toEqual(["a.scene.json", "b.prefab.json", "sfx/hit.cue.json"]);

    expect((await n.moved(project, before, next)).sort()).toEqual(["a.scene.json", "b.prefab.json", "sfx/hit.cue.json"]);
    const a = json(project, "a.scene.json").nodes[0].components;
    expect(a[0].data.tag).toBe("Floor");
    expect(a[1].data.tag).toBe("Ground"); // not a declared component type
    expect(a[2].data.members).toEqual([{ tag: "Floor" }, { tag: "Default" }]);
    expect(json(project, "b.prefab.json").nodes[0].overrides.map((o: { value: string }) => o.value)).toEqual(["Floor", "Ground"]);
    expect(json(project, "sfx/hit.cue.json").steps).toEqual([{ tag: "Floor" }, { tag: "Default" }]);
    expect(json(project, "notes.json").tag).toBe("Ground"); // no declaration reads it
  });

  it("drops the edit when the user cancels, and leaves the files alone", async () => {
    const { project } = await openTestProject(FILES);
    const { names: n } = names(false);
    await expect(n.editing(project, draft(["Default", "Ground"]), draft(["Default", "Floor"]))).resolves.toBeNull();
    expect(json(project, "a.scene.json").nodes[0].components[0].data.tag).toBe("Ground");
  });

  it("goes ahead at once when nothing names the entry, and treats adds, reorders and duplicates as no rename", async () => {
    const { project } = await openTestProject(FILES);
    const { names: n, confirm } = names();
    const before = draft(["Default", "Ground", "Sky"]);
    const sky = draft(["Default", "Ground", "Air"]);
    expect(n.editing(project, before, sky)).toBe(sky); // not a promise: nothing to ask
    for (const after of [draft(["Default", "Ground", "Sky", "Tag"]), draft(["Ground", "Default", "Sky"]), draft(["Default", "Sky", "Sky"]), draft(["Default", "", "Sky"]), draft(["Default", "Floor", "Sea"])]) {
      expect(n.editing(project, before, after)).toBe(after);
      expect(await n.moved(project, before, after)).toEqual([]);
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it("puts the references other settings hold into the pushed draft, merged from every declaration of the list", async () => {
    const { project } = await openTestProject();
    const rename = (key: string) => (d: SettingsDraft, from: string, to: string): SettingsDraft => {
      const game = d.game as Record<string, unknown>;
      return game[key] === from ? { ...d, game: { ...game, [key]: to } } : d;
    };
    const list = withReferences(TAGS, [{ settings: rename("spawnTag") }, { settings: rename("deathTag"), fields: [{ field: "extra" }] }]);
    expect(list.fields).toHaveLength(3);
    const { names: n } = names(true, [list]);
    const pushed = n.editing(project, draft(["Default", "Ground"], [], { spawnTag: "Ground", deathTag: "Ground" }), draft(["Default", "Floor"], [], { spawnTag: "Ground", deathTag: "Ground" }));
    expect(pushed).toEqual(draft(["Default", "Floor"], [], { spawnTag: "Floor", deathTag: "Floor" }));
  });
});

describe("settings names: undo and redo", () => {
  it("move the references back and forth, found from the drafts", async () => {
    const { project } = await openTestProject(FILES);
    const { names: n } = names();
    const before = draft(["Default", "Ground"]), after = draft(["Default", "Floor"]);
    await n.moved(project, before, after);
    expect(await n.moved(project, after, before)).toHaveLength(3); // undo
    expect(json(project, "a.scene.json").nodes[0].components[0].data.tag).toBe("Ground");
    expect(json(project, "sfx/hit.cue.json").steps[0].tag).toBe("Ground");
    await n.moved(project, before, after); // redo
    expect(json(project, "b.prefab.json").nodes[0].overrides[0].value).toBe("Floor");
  });

  it("renames in two lists at once, and the open scene as one undo step", async () => {
    const { project } = await openTestProject({ ...FILES, "o.scene.json": JSON.stringify(scene(node("o", [tagged("Ground"), { type: "game.Any", data: { kind: "A" } }]))) });
    useProjectAssets(project);
    Input.reset();
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, "o.scene.json");
    const { names: n, asked } = names();
    const before = draft(["Default", "Ground"], ["A"]), after = draft(["Default", "Floor"], ["B"]);
    await n.editing(project, before, after);
    expect(asked[0].items![0]).toBe("o.scene.json"); // the open scene first
    expect(asked[0].message).toBe('Rename the tag "Ground" to "Floor" and the kind "A" to "B"? 4 files use them; they will be updated.');
    const done = await n.moved(project, before, after);
    expect(done).toContain("o.scene.json (unsaved)");
    expect(project.textOf("o.scene.json")).toContain('"Ground"'); // unsaved: the document changed, not the file
    const open = openScene.value!;
    expect(JSON.stringify(open.doc.toJSON())).toMatch(/"tag":"Floor".*"kind":"B"/);
    expect(open.stack.undo()).toBe(true);
    expect(JSON.stringify(open.doc.toJSON())).toMatch(/"tag":"Ground".*"kind":"A"/);
    engine.stop();
  });
});
