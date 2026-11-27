// Action set assets in the editor (ADR 0433): the core `actionSet` kind's New Action Set (a valid set under a free id,
// listed in project.json's `input.actionSets`, opened in the Input dialog with its name selected), opening a set file
// in the dialog, and its format's problems.
import { afterEach, describe, expect, it } from "vitest";
import { actionSetProblems, type ActionSetFile } from "../engine/input/actionAssets";
import { kindCreators } from "./assetKindHost";
import { assetKind } from "./assetKindLookup";
import { readAsset } from "./assetDocuments";
import { editor } from "./sdk";
import { closeTestProject, openTestProject, useCoreAssetKinds } from "./testing";
import { inputDialog } from "./ui/dialogState";
import { inputDialogRename } from "./ui/input/inputDialogIntent";

useCoreAssetKinds();

afterEach(() => {
  inputDialog.value = null;
  inputDialogRename.value = null;
  closeTestProject();
});

const PROJECT = `{\n  "name": "Game",\n  "input": { "join": "single" }\n}\n`;

describe("the actionSet asset kind", () => {
  it("is the kind of *.actions.json files, not plain JSON", async () => {
    expect(assetKind("input/player.actions.json")).toBe("actionSet");
  });

  it("makes a set with one button under a free id, lists it in project.json and opens it in the Input dialog to be named", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT, "input/new.actions.json": JSON.stringify({ id: "game.New", actions: [] }) });
    const entry = kindCreators().find((c) => c.kind === "actionSet")!;
    expect([entry.label, entry.category]).toEqual(["New Action Set", "Input"]);
    const path = await entry.create("");
    expect(path).toBe("input/new2.actions.json");
    const value = project.assets.get(path!) as ActionSetFile;
    expect(value).toEqual({ id: "game.New2", actions: [{ name: "action", type: "button" }] });
    expect(actionSetProblems(value)).toEqual([]);
    const settings = JSON.parse(project.textOf("project.json")!);
    expect(settings.input).toEqual({ join: "single", actionSets: [path] });
    expect(settings.name).toBe("Game"); // the rest of the file is kept
    expect(inputDialog.value).toBe(path);
    expect(inputDialogRename.value).toBe(path);
  });

  it("opens a set file in the Input dialog", async () => {
    await openTestProject({ "input/player.actions.json": JSON.stringify({ id: "game.Player", actions: [] }) });
    expect(editor.assets.open("input/player.actions.json")).toBe(true);
    expect(inputDialog.value).toBe("input/player.actions.json");
  });

  it("reports a file's problems as the boot would", async () => {
    const { project } = await openTestProject({ "input/bad.actions.json": JSON.stringify({ id: "bad", actions: [{ name: "x", type: "button", control: "<Keyboard>/x" }] }) });
    const read = readAsset<ActionSetFile>(project, "input/bad.actions.json");
    expect(read.problems.map((p) => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^id: /), expect.stringMatching(/Controls go in a context/)]));
  });
});
