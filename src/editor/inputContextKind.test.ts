// Input context assets in the editor (ADR 0336, 0233, 0152, 0433): the core `inputContext` kind's New… entry, opening in
// the Input dialog (not the Inspector, ADR 0433), edits through its asset document reaching a running World, and the InputContext component's
// `context` field offering the project's context files and the contexts registered in code.
import { afterEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, InputContext, InputPlayers, button, defineActions, defineInputContext, type InputContextSpec } from "../engine";
import { kindCreators } from "./assetKindHost";
import { registeredKind } from "./assetKindLookup";
import { inputDialog } from "./ui/dialogState";
import { fieldChoicesFor, listedChoices, loadFieldChoices } from "./fieldChoices";
import { useProjectAssets } from "./projects";
import { editor, openAssetDocument } from "./sdk";
import { closeTestProject, openTestProject, useCoreAssetKinds } from "./testing";
import type { ComponentInfo } from "../engine/editor";
import "./ui/inspectorSections.builtin";

useCoreAssetKinds();

defineActions("test.inputContextKind.Player", { honk: button(), jump: button("<Keyboard>/space") });
defineInputContext({ name: "test.inputContextKind.menu", mappings: [] });

afterEach(() => closeTestProject());

const CONTEXT = "input/vehicle.input.json";
const vehicle: InputContextSpec = { name: "vehicle", mappings: [{ action: "honk", control: "<Keyboard>/h" }] };

describe("the inputContext asset kind", () => {
  it("makes a new context in the input folder from New Input Context", async () => {
    const { project } = await openTestProject({ [CONTEXT]: JSON.stringify(vehicle) });
    const entry = kindCreators().find((c) => c.kind === "inputContext")!;
    expect(entry.label).toBe("New Input Context");
    expect(await entry.create("")).toBe("input/New Input Context.input.json");
    expect(project.assets.get("input/New Input Context.input.json")).toEqual({ name: "New Input Context", mappings: [] });
    expect(await entry.create("")).toBe("input/New Input Context 2.input.json");
  });

  it("opens a context in the Input dialog, and has no Inspector view (ADR 0433)", async () => {
    await openTestProject({ [CONTEXT]: JSON.stringify(vehicle) });
    inputDialog.value = null;
    expect(editor.assets.open(CONTEXT)).toBe(true);
    expect(inputDialog.value).toBe(CONTEXT);
    expect(registeredKind("inputContext")!.inspector).toBeUndefined();
    inputDialog.value = null;
  });

  it("writes edits through the asset document, with undo, and a running World uses the change", async () => {
    const { project } = await openTestProject({ [CONTEXT]: JSON.stringify(vehicle) });
    useProjectAssets(project);
    Input.reset();
    const engine = await Engine.create({ headless: true });
    try {
      const car = GameObject.create("Car");
      car.addBehavior(InputContext, { context: CONTEXT, priority: 10 });
      engine.step(1 / 60);
      Input.inject.keyDown("space");
      engine.step(1 / 60);
      expect(InputPlayers.get(0)!.held("jump")).toBe(true);
      Input.inject.keyUp("space");
      engine.step(1 / 60);

      const doc = openAssetDocument<InputContextSpec>(project, CONTEXT, "inputContext");
      doc.edit({ ...vehicle, mappings: [...vehicle.mappings, { action: "honk", control: "<Keyboard>/space" }] }, { label: "Add Mapping" });
      await doc.flush();
      expect((project.assets.get(CONTEXT) as InputContextSpec).mappings).toHaveLength(2);
      Input.inject.keyDown("space");
      engine.step(1 / 60);
      expect(InputPlayers.get(0)!.held("honk")).toBe(true);
      expect(InputPlayers.get(0)!.held("jump")).toBe(false); // the vehicle's mapping consumed Space
      Input.inject.keyUp("space");
      engine.step(1 / 60);

      doc.undo();
      await doc.flush();
      expect((project.assets.get(CONTEXT) as InputContextSpec).mappings).toHaveLength(1);
    } finally {
      Input.inject.releaseAll();
      engine.dispose();
    }
  });
});

describe("InputContext.context in the Inspector", () => {
  it("offers None, the project's context files and the contexts registered in code", async () => {
    await openTestProject({ [CONTEXT]: JSON.stringify(vehicle), "input/menu.input.json": "{}", "data.json": "{}" });
    const contribution = fieldChoicesFor("engine.InputContext", "context")!;
    const info = { type: "engine.InputContext", fields: [] } as unknown as ComponentInfo;
    const loaded = await loadFieldChoices(contribution, info);
    const listed = listedChoices(contribution, loaded, "", false)!;
    expect(listed[0]).toEqual({ label: "None", value: "" });
    expect(listed.map((c) => c.value)).toEqual(expect.arrayContaining(["input/menu.input.json", CONTEXT, "test.inputContextKind.menu"]));
    expect(listed.map((c) => c.value)).not.toContain("data.json");
    expect(listed.map((c) => c.value)).not.toContain("default");
    expect(listed.find((c) => c.value === "test.inputContextKind.menu")!.label).toBe("test.inputContextKind.menu (in code)");
  });
});
