import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameBehavior, GameObject, Input, SceneManager, Vector2, behavior, getComponentClass, getFields } from "../index";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../ui/components";
import { UIDocument, loadUIDocumentSupport } from "../ui/UIDocument";
import { World } from "../core/World";
import { DomInput } from "./domInput";
import { buildUI, byId } from "./uiMarkup";

// ADR 0069: UI components in a headless World, and Input without UI. ADR 0417: only UI documents make
// them. Layout, pointer routing and editor picking are tested on the renderer-neutral core
// (uiCore.test.ts, ADR 0076) and on Babylon (babylonUI.test.ts); the three.js runtime was removed with
// its backend (ADR 0081).

const FROM_DOCUMENTS = "UI elements come from a UIView's Svelte component or a UI document (ADR 0417, 0419): write the element in the component (or a *.ui.xml document), or use ui.list() for rows made at runtime.";

const DT = 1 / 60;
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
  await loadUIDocumentSupport();
});

afterEach(() => {
  engine.dispose();
  Assets.clearSources();
  Input.reset();
  vi.restoreAllMocks();
});

function world(): World {
  return World.require();
}

/** A 1280×720 screen canvas with a column of fixed-size buttons. */
function menu() {
  const doc = buildUI(`<Canvas id="Canvas">
    <Panel id="Menu" flex-direction="column" padding="20" gap="10" width="100%" height="100%">
      <Button id="Play" width="200" height="50" padding="0"/>
      <Button id="Quit" width="200" height="50" padding="0"/>
    </Panel>
  </Canvas>`);
  return { doc, canvas: byId(doc, "Canvas", UICanvas), column: byId(doc, "Menu", UIPanel), play: byId(doc, "Play", UIButton), quit: byId(doc, "Quit", UIButton) };
}

describe("UI components (ADR 0069)", () => {
  it("register with stable ids and declare their fields", () => {
    expect(getComponentClass("engine.UICanvas")).toBe(UICanvas);
    expect(getComponentClass("engine.UIPanel")).toBe(UIPanel);
    expect(getComponentClass("engine.UIText")).toBe(UIText);
    expect(getComponentClass("engine.UIImage")).toBe(UIImage);
    expect(getComponentClass("engine.UIButton")).toBe(UIButton);
    expect(getComponentClass("engine.UIInputField")).toBe(UIInputField);
    const button = getFields(UIButton).map((f) => f.name);
    for (const name of ["flexDirection", "justifyContent", "alignItems", "gap", "padding", "margin", "width", "height", "positionType", "top", "right", "bottom", "left", "flexGrow", "backgroundColor", "borderRadius", "borderWidth", "borderColor", "opacity", "visible", "display", "hoverColor", "pressedColor", "interactable"]) {
      expect(button).toContain(name);
    }
    expect(getFields(UICanvas).map((f) => f.name)).toEqual(["mode", "referenceResolution", "matchHeight", "sortOrder", "pixelSize", "modal", "autoFocus", "firstSelected", "player"]);
    expect(getFields(UIInputField).map((f) => f.name)).toEqual(expect.arrayContaining(["value", "placeholder", "maxLength"]));
  });

  it("hold data in a headless World without building anything: with no UI core, nothing clicks or submits", () => {
    const { play } = menu();
    const field = byId(buildUI(`<Canvas><InputField id="Name" placeholder="Your name"/></Canvas>`), "Name", UIInputField);
    expect(world().render).toBeNull();
    engine.step(DT);
    // A press and release where Play would be laid out (uiCore.test.ts clicks it with a core).
    DomInput.attach().click(0, 100, 40);
    engine.step(DT);
    expect(play.hovered).toBe(false);
    expect(play.clicked).toBe(false);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true); // the game gets the press: no UI claimed it
    engine.step(DT);
    expect(play.clicked).toBe(false);

    field.focused = true;
    expect(field.focused).toBe(true);
    engine.step(DT);
    expect(field.submitted).toBe(false);
    expect(Input.keyboardOverUI).toBe(false); // no core routes, so no field claims the keyboard
  });
});

describe("UI comes only from UI documents (ADR 0417)", () => {
  const types = [UICanvas, UIPanel, UIText, UIImage, UIButton, UIInputField];

  it("refuses every UI component from addComponent, addBehavior and addChildBehavior, adding nothing", () => {
    const n = GameObject.create("Hand-built");
    for (const type of types) {
      expect(() => n.addComponent(type as never)).toThrow(FROM_DOCUMENTS);
      expect(() => n.addBehavior(type as never, {} as never)).toThrow(FROM_DOCUMENTS);
      expect(() => n.addChildBehavior(type as never)).toThrow(FROM_DOCUMENTS);
    }
    expect(n.getComponents(UIPanel as never)).toEqual([]);
    expect(n.children).toEqual([]);
  });

  it("refuses a script's subclass of a UI component too", () => {
    class FancyButton extends UIButton {}
    expect(() => GameObject.create("Fancy").addComponent(FancyButton)).toThrow(FROM_DOCUMENTS);
  });

  it("still makes them in a document's build, as element types scripts read and write", () => {
    const { doc, play } = menu();
    expect(doc.query("#Play")!.node.getComponent(UIButton)).toBe(play);
    play.interactable = false;
    expect(byId(doc, "Play", UIButton).interactable).toBe(false);
    expect(GameObject.findObjectsOfType(UIButton)).toHaveLength(2);
  });

  @behavior("test.ui417.Marker")
  class Marker extends GameBehavior {}

  const fromFile = (components: unknown[]) => ({
    format: "myco.scene@5",
    nodes: [
      { id: "root", name: "Menu", components: [{ type: "test.ui417.Marker" }] },
      { id: "title", name: "Title", parent: "root", components },
    ],
  });

  it("fails to load a scene or prefab that saves a UI component, naming the file, the node and ADR 0417", async () => {
    Assets.addSource(Assets.fromObject({
      "scenes/menu.scene.json": fromFile([{ type: "engine.UIText", data: { text: "Hi" } }]),
      "prefabs/hud.prefab.json": fromFile([{ type: "engine.UIPanel" }]),
      "prefabs/added.prefab.json": { format: "myco.scene@5", nodes: [{ id: "i", name: "Instance", prefab: "prefabs/plain.prefab.json", overrides: [{ addComponent: { type: "engine.UIButton" } }] }] },
      "prefabs/plain.prefab.json": { format: "myco.scene@5", nodes: [{ id: "p", name: "Plain" }] },
    }));
    await expect(SceneManager.load("scenes/menu.scene.json")).rejects.toThrow(`scenes/menu.scene.json: node "/menu/Menu/Title" saves a UI component ("engine.UIText"). ${FROM_DOCUMENTS}`);
    expect(() => GameObject.instantiate("prefabs/hud.prefab.json")).toThrow(`prefabs/hud.prefab.json: node "/Menu/Title" saves a UI component ("engine.UIPanel"). ${FROM_DOCUMENTS}`);
    expect(() => GameObject.instantiate("prefabs/added.prefab.json")).toThrow(/prefabs\/added\.prefab\.json: node "\/Instance" saves a UI component \("engine\.UIButton"\)\. UI elements come from a UIView's Svelte component or a UI document \(ADR 0417, 0419\)/);
    expect(engine.world.root.children.map((c) => c.name)).toEqual([]); // nothing half-built stays
    expect(GameObject.findObjectsOfType(Marker)).toEqual([]);
  });

  it("fails to load the removed screen Text and LocalizedText, by id or bare name, with the same message", () => {
    const removed = ["engine.Text", "engine.LocalizedText", "Text", "LocalizedText"];
    Assets.addSource(Assets.fromObject(Object.fromEntries(removed.map((type, i) => [`prefabs/old${i}.prefab.json`, fromFile([{ type, data: { text: "Score" } }])]))));
    removed.forEach((type, i) => {
      expect(() => GameObject.instantiate(`prefabs/old${i}.prefab.json`)).toThrow(`prefabs/old${i}.prefab.json: node "/Menu/Title" saves "${type}", which was removed. ${FROM_DOCUMENTS}`);
    });
  });

  it("loads a scene whose UI is a UIDocument, and builds it", async () => {
    Assets.addSource(Assets.fromObject({
      "ui/hud.ui.xml": `<Canvas><Text id="score">0</Text></Canvas>`,
      "scenes/game.scene.json": { format: "myco.scene@5", nodes: [{ id: "hud", name: "HUD", components: [{ type: "engine.UIDocument", data: { document: "asset:ui/hud.ui.xml" } }] }] },
    }));
    await SceneManager.load("scenes/game.scene.json");
    const doc = GameObject.findObjectOfType(UIDocument)!;
    await doc.ready;
    expect(doc.query("#score")!.as(UIText).text).toBe("0");
  });
});

describe("Input without UI (ADR 0069 keeps the old behaviour)", () => {
  it("reports presses, holds and releases as before when nothing claims them", () => {
    const dom = DomInput.attach();
    dom.pointerDown(0, 10, 10);
    Input.beginFrame();
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.getMouseButton(0)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(10, 10));
    dom.pointerUp(0);
    Input.beginFrame();
    expect(Input.getMouseButtonUp(0)).toBe(true);
  });
});

describe("UI colours", () => {
  it("panel colours are plain Color fields", () => {
    const { play } = menu();
    play.backgroundColor = new Color(1, 0, 0, 0.5);
    expect(play.backgroundColor.a).toBe(0.5);
  });
});
