// ADR 0354 §9, 0357 §1, ADR 0341 "the engine's undo tree": the Dialogue screen's documents over a project folder — the
// project as the models read it, a Text column edit creating the translation file as one undo step, a line table edit
// undone and redone, and a languages edit writing only `languages` into project.json.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { ROOT, useCoreAssetKinds } from "../../../editor/testing";
import { formatLineTable } from "../../../engine/audio/localisation/lines/format";
import type { LineTable } from "../../../engine/audio/localisation/types";
import { languagesToJson, parseLanguages } from "../../../engine/localisation/languages";
import { formatStringTable } from "../../../engine/localisation/strings/format";
import { findLine } from "./dialogueData";
import { FIXTURE_LANGUAGES, fixtureStrings, fixtureTable, FR_PATH, STRINGS_PATH, TABLE_PATH } from "./dialogueFixture";
import { addLanguage } from "./languagesModel";
import { applyDocEdit, commitTo, dialogueData, LINES_KIND, openDoc, PROJECT_FILE, PROJECT_FILE_KIND, TRANSLATION_KIND } from "./dialogueProject";
import { setSpeaker, textEdit } from "./linesModel";

useCoreAssetKinds();

let project: EditorProject;
let fs: MemoryFileSystem;
/** A written file's JSON. */
const written = (path: string): Record<string, unknown> & { lines?: { speaker?: string }[] } => JSON.parse(String(fs.files.get(joinPath(ROOT, path))));

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), `${JSON.stringify({ name: "Game", languages: languagesToJson(FIXTURE_LANGUAGES) }, null, 2)}\n`);
  fs.files.set(joinPath(ROOT, "audio.json"), JSON.stringify({ localisation: { roots: ["audio/vo"] } }));
  fs.files.set(joinPath(ROOT, TABLE_PATH), formatLineTable(fixtureTable()));
  fs.files.set(joinPath(ROOT, STRINGS_PATH), formatStringTable(fixtureStrings()));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
});
afterEach(() => {
  currentProject.value = null;
});

describe("dialogue documents", () => {
  it("read the project as the models need it", () => {
    const data = dialogueData(project);
    expect(data.languages.list.map((l) => l.code)).toEqual(["en", "fr", "fr-CA", "de"]);
    expect(data.localisation.roots).toEqual(["audio/vo"]);
    expect(data.tables.map((t) => t.path)).toEqual([TABLE_PATH]);
    expect(data.strings(STRINGS_PATH)?.strings[0].key).toBe("intro_01");
    expect(data.translation(STRINGS_PATH, "fr")).toBeNull();
  });

  it("write a French text into a new translation file as one undo step", async () => {
    const data = dialogueData(project);
    const r = textEdit(data, findLine(data, "intro_01")!, "fr", "On est en retard.");
    if ("refused" in r) throw new Error(r.refused);
    applyDocEdit(project, r.next, "fr text of intro_01");
    const doc = openDoc(project, FR_PATH, TRANSLATION_KIND);
    await doc.flush();
    expect(written(FR_PATH)).toMatchObject({ format: "myco.translation@1", language: "fr", strings: { intro_01: { text: "On est en retard." } } });
    expect(dialogueData(project).translation(STRINGS_PATH, "fr")?.strings.intro_01?.text).toBe("On est en retard.");
    expect(doc.undoLabel.peek()).toBe("fr text of intro_01");
  });

  it("undo and redo a line edit through the table's history", async () => {
    const doc = openDoc<LineTable>(project, TABLE_PATH, LINES_KIND);
    expect(commitTo(doc, setSpeaker(doc.value.peek(), "intro_01", "Ava Grey"), "Speaker of intro_01")).toBe(true);
    expect(commitTo(doc, setSpeaker(doc.value.peek(), "nobody", "x"), "Speaker of nobody")).toBe(false);
    await doc.flush();
    expect(written(TABLE_PATH).lines?.[0].speaker).toBe("Ava Grey");
    doc.undo();
    expect(dialogueData(project).tables[0].table.lines[0].speaker).toBe("Ava");
    doc.redo();
    expect(dialogueData(project).tables[0].table.lines[0].speaker).toBe("Ava Grey");
  });

  it("edit languages in project.json, keeping its other keys", async () => {
    const doc = openDoc<Record<string, unknown>>(project, PROJECT_FILE, PROJECT_FILE_KIND);
    const r = addLanguage(dialogueData(project).languages, "es");
    if ("refused" in r) throw new Error(r.refused);
    doc.edit({ ...doc.value.peek(), languages: languagesToJson(r.next) }, { label: "Add language es" });
    await doc.flush();
    const file = written("project.json");
    expect(file.name).toBe("Game");
    expect(parseLanguages(file.languages).languages.list.map((l) => l.code)).toContain("es");
    expect(dialogueData(project).languages.list.at(-1)?.code).toBe("es");
  });
});
