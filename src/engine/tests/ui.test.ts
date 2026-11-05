import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Color, Engine, GameBehavior, GameObject, Input, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, Vector2, getComponentClass, getFields, type UILength } from "../index";
import { World } from "../core/World";
import { UIRuntime, canvasScale, uiLength } from "../ui/UIRuntime";
import { PerspectiveCamera, Scene } from "three";

// ADR 0069: UI components, layout through uikit (Yoga runs in Node), and UI-first pointer routing.
// No WebGL: the runtime lays out and routes without a renderer, as a headless World would draw nothing.

const DT = 1 / 60;
let engine: Engine;
let runtimes: UIRuntime[] = [];

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  for (const r of runtimes.splice(0)) r.dispose();
  engine.dispose();
  Input.reset();
  vi.restoreAllMocks();
});

function world(): World {
  return World.require();
}

function runtime(): UIRuntime {
  const r = new UIRuntime({ interactive: true });
  runtimes.push(r);
  return r;
}

/** Yoga loads asynchronously the first time; lay out until the canvas has a size. */
async function layout(r: UIRuntime, canvas: UICanvas, width = 1280, height = 720): Promise<void> {
  for (let i = 0; i < 50; i++) {
    r.sync(world(), width, height, DT);
    if (r.rectOf(canvas)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  r.sync(world(), width, height, DT);
}

function node<T extends UIPanel | UIText | UIImage | UICanvas>(name: string, parent: GameObject | null, type: new () => T, init: Partial<T> = {}): T {
  const n = GameObject.create(name, { parent });
  return n.addBehavior(type as never, init as never) as T;
}

/** A 1280×720 screen canvas with a column of fixed-size buttons. */
function menu() {
  const canvas = node("Canvas", null, UICanvas);
  const column = node("Menu", canvas.node, UIPanel, { flexDirection: "column", padding: 20, gap: 10, width: "100%", height: "100%" } as Partial<UIPanel>);
  const play = node("Play", column.node, UIButton, { width: 200 as UILength, height: 50 as UILength, padding: 0 } as Partial<UIButton>);
  const quit = node("Quit", column.node, UIButton, { width: 200 as UILength, height: 50 as UILength, padding: 0 } as Partial<UIButton>);
  return { canvas, column, play, quit };
}

/** Press (or release) the left mouse button at canvas pixels and step a frame. */
function mouse(type: "down" | "up", x: number, y: number): void {
  Input.simulatePointer(x, y);
  Input.simulate(type, "mouse0");
  engine.step(DT);
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
    for (const name of ["flexDirection", "justifyContent", "alignItems", "gap", "padding", "margin", "width", "height", "positionType", "top", "right", "bottom", "left", "flexGrow", "backgroundColor", "borderRadius", "borderWidth", "borderColor", "opacity", "visible", "hoverColor", "pressedColor", "interactable"]) {
      expect(button).toContain(name);
    }
    expect(getFields(UICanvas).map((f) => f.name)).toEqual(["mode", "referenceResolution", "matchHeight", "sortOrder", "pixelSize"]);
    expect(getFields(UIInputField).map((f) => f.name)).toEqual(expect.arrayContaining(["value", "placeholder", "maxLength"]));
  });

  it("hold data in a headless World without building anything; clicks are simulated", () => {
    const { play } = menu();
    const field = node("Name", null, UIInputField, { placeholder: "Your name" } as Partial<UIInputField>);
    expect(world().render).toBeNull();
    engine.step(DT);
    expect(play.clicked).toBe(false);
    play._simulateClick(); // between frames: scripts see it next frame
    expect(play.clicked).toBe(false);
    engine.step(DT);
    expect(play.clicked).toBe(true);
    engine.step(DT);
    expect(play.clicked).toBe(false);

    field.focused = true;
    expect(field.focused).toBe(true);
    field._simulateSubmit();
    engine.step(DT);
    expect(field.submitted).toBe(true);
    engine.step(DT);
    expect(field.submitted).toBe(false);
  });

  it("a click simulated inside a frame is seen by scripts that frame", () => {
    const { play } = menu();
    const seen: boolean[] = [];
    class Clicker extends GameBehavior {
      update() {
        if (this.time.frameCount === 2) play._simulateClick();
        seen.push(play.clicked);
      }
    }
    GameObject.create("Script").addBehavior(Clicker);
    engine.step(DT);
    engine.step(DT);
    engine.step(DT);
    expect(seen).toEqual([false, true, false]);
  });

  it("a disabled button never reports a click", () => {
    const { play } = menu();
    play.interactable = false;
    play._simulateClick();
    engine.step(DT);
    expect(play.clicked).toBe(false);
  });
});

describe("UI layout (ADR 0069)", () => {
  it("scales the reference resolution to the canvas like Unity's Canvas Scaler", () => {
    expect(canvasScale(1280, 720, 1280, 720, 1)).toBeCloseTo(1);
    expect(canvasScale(2560, 1440, 1280, 720, 0.5)).toBeCloseTo(2);
    expect(canvasScale(1920, 720, 1280, 720, 1)).toBeCloseTo(1); // matches height
    expect(canvasScale(1920, 720, 1280, 720, 0)).toBeCloseTo(1.5); // matches width
    expect(canvasScale(1920, 720, 1280, 720, 0.5)).toBeCloseTo(Math.sqrt(1.5));
    expect(canvasScale(0, 0, 1280, 720, 1)).toBe(1);
  });

  it("reads lengths as pixels, percentages or auto", () => {
    expect(uiLength(120)).toBe(120);
    expect(uiLength("120")).toBe(120);
    expect(uiLength("120px")).toBe(120);
    expect(uiLength("50%")).toBe("50%");
    expect(uiLength("auto")).toBe("auto");
    expect(uiLength("")).toBeUndefined();
    expect(uiLength("wide")).toBeUndefined();
  });

  it("lays children out with flexbox inside their parent", async () => {
    const { canvas, column, play, quit } = menu();
    const r = runtime();
    await layout(r, canvas);
    expect(r.rectOf(canvas)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(r.rectOf(column)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(r.rectOf(play)).toEqual({ x: 20, y: 20, width: 200, height: 50 });
    expect(r.rectOf(quit)).toEqual({ x: 20, y: 80, width: 200, height: 50 });
  });

  it("scales the layout with the canvas, and centres with justify and align", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const box = node("Box", canvas.node, UIPanel, { width: "100%", height: "100%", justifyContent: "center", alignItems: "center" } as Partial<UIPanel>);
    const inner = node("Inner", box.node, UIPanel, { width: 100, height: 40 } as Partial<UIPanel>);
    const r = runtime();
    await layout(r, canvas, 640, 360); // half the reference size: scale 0.5
    const rect = r.rectOf(inner)!;
    expect(rect.width).toBeCloseTo(50);
    expect(rect.height).toBeCloseTo(20);
    expect(rect.x + rect.width / 2).toBeCloseTo(320);
    expect(rect.y + rect.height / 2).toBeCloseTo(180);
  });

  it("follows field changes, absolute positions and inactive nodes each sync", async () => {
    const { canvas, play, quit } = menu();
    const r = runtime();
    await layout(r, canvas);
    play.width = 300;
    play.height = "60";
    r.sync(world(), 1280, 720, DT);
    expect(r.rectOf(play)).toEqual({ x: 20, y: 20, width: 300, height: 60 });
    expect(r.rectOf(quit)!.y).toBe(90);

    play.node.setActive(false); // takes no space
    r.sync(world(), 1280, 720, DT);
    expect(r.rectOf(quit)!.y).toBe(20);

    quit.positionType = "absolute";
    quit.right = 10;
    quit.bottom = "10";
    r.sync(world(), 1280, 720, DT);
    expect(r.rectOf(quit)).toEqual({ x: 1280 - 10 - 200, y: 720 - 10 - 50, width: 200, height: 50 });
  });

  it("lays out reordered and reparented nodes in their new place, and drops removed ones", async () => {
    const { canvas, column, play, quit } = menu();
    const r = runtime();
    await layout(r, canvas);
    quit.node.setParent(canvas.node); // out of the column: beside it in the canvas's row
    r.sync(world(), 1280, 720, DT);
    expect(r.rectOf(play)).toEqual({ x: 20, y: 20, width: 200, height: 50 });
    const col = r.rectOf(column)!;
    expect(r.rectOf(quit)).toEqual({ x: col.x + col.width, y: 0, width: expect.any(Number), height: 50 });
    GameObject.destroy(play.node);
    engine.step(DT);
    r.sync(world(), 1280, 720, DT);
    expect(r.rectOf(play)).toBeNull();
  });

  it("skips nodes without UI components but lays out their UI children", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const group = GameObject.create("Group", { parent: canvas.node });
    const panel = node("Panel", group, UIPanel, { width: 30, height: 30, margin: 5 } as Partial<UIPanel>);
    const r = runtime();
    await layout(r, canvas);
    expect(r.rectOf(panel)).toEqual({ x: 5, y: 5, width: 30, height: 30 });
  });

  it("warns about elements outside a canvas and does not draw them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = node("Canvas", null, UICanvas);
    const loose = node("Loose", null, UIPanel, { width: 10, height: 10 } as Partial<UIPanel>);
    const r = runtime();
    await layout(r, canvas);
    expect(r.rectOf(loose)).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Loose"))).toBe(true);
  });
});

describe("world canvases (ADR 0069)", () => {
  it("join the World's scene at their node and take the pointer through the view camera", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 100); // at the origin, looking down -z
    camera.updateMatrixWorld();
    const r = new UIRuntime({ interactive: true, host: { scene, camera: () => camera } });
    runtimes.push(r);
    // 200×100 UI pixels at 0.01 units each: a 2×1 panel, 5 units in front of the camera.
    const canvas = node("Sign", null, UICanvas, { mode: "world", referenceResolution: new Vector2(200, 100), pixelSize: 0.01 } as Partial<UICanvas>);
    canvas.node.transform!.position.set(0, 0, -5);
    const button = node("Button", canvas.node, UIButton, { width: "100%", height: "100%" } as Partial<UIButton>);
    engine.step(DT); // propagate the transform
    for (let i = 0; i < 50 && r.hitTest(640, 360) === null; i++) {
      r.sync(world(), 1280, 720, DT);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(scene.children.length).toBe(1); // the canvas's uikit root
    expect(r.hitTest(640, 360)).toBe(button);
    expect(r.hitTest(20, 20)).toBeNull(); // the panel covers only the middle of the view
    expect(r.rectOf(button)).toBeNull(); // rectangles are for screen canvases

    mouse("down", 640, 360);
    mouse("up", 640, 360);
    expect(button.clicked).toBe(true);

    canvas.node.transform!.position.set(10, 0, -5); // moved out of view
    engine.step(DT);
    r.sync(world(), 1280, 720, DT);
    expect(r.hitTest(640, 360)).toBeNull();
  });
});

describe("UI-first pointer routing (ADR 0069)", () => {
  it("hovers, presses and clicks a button, and the game doesn't see the press", async () => {
    const { canvas, play, quit } = menu();
    const r = runtime();
    await layout(r, canvas);
    const game: { down: boolean; held: boolean; up: boolean; over: boolean; clicked: boolean }[] = [];
    class Game extends GameBehavior {
      update() {
        game.push({ down: Input.getMouseButtonDown(0), held: Input.getMouseButton(0), up: Input.getMouseButtonUp(0), over: Input.pointerOverUI, clicked: play.clicked });
      }
    }
    GameObject.create("Game").addBehavior(Game);

    Input.simulatePointer(100, 40); // over Play
    engine.step(DT);
    expect(play.hovered).toBe(true);
    expect(quit.hovered).toBe(false);
    expect(game.at(-1)).toEqual({ down: false, held: false, up: false, over: true, clicked: false });

    mouse("down", 100, 40);
    expect(play.pressed).toBe(true);
    expect(game.at(-1)).toEqual({ down: false, held: false, up: false, over: true, clicked: false });

    engine.step(DT); // still held
    expect(game.at(-1)!.held).toBe(false);

    mouse("up", 100, 40);
    expect(play.pressed).toBe(false);
    expect(play.clicked).toBe(true);
    expect(game.at(-1)).toEqual({ down: false, held: false, up: false, over: true, clicked: true });

    engine.step(DT);
    expect(play.clicked).toBe(false);
    expect(quit.clicked).toBe(false);
  });

  it("gives the game presses away from UI", async () => {
    const { canvas, play } = menu();
    const r = runtime();
    await layout(r, canvas);
    mouse("down", 900, 500);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.getMouseButton(0)).toBe(true);
    expect(Input.anyKeyDown).toBe(true);
    // Dragged onto a button and released there: the press was the game's, so is the release, and nothing's clicked.
    mouse("up", 100, 40);
    expect(Input.pointerOverUI).toBe(true);
    expect(Input.getMouseButtonUp(0)).toBe(true);
    expect(play.clicked).toBe(false);
  });

  it("doesn't click when the press moves off the button before release", async () => {
    const { canvas, play, quit } = menu();
    const r = runtime();
    await layout(r, canvas);
    mouse("down", 100, 40);
    mouse("up", 100, 100); // over Quit now
    expect(play.clicked).toBe(false);
    expect(quit.clicked).toBe(false);
    expect(Input.getMouseButtonUp(0)).toBe(false); // the press began on UI, so its release is the UI's
  });

  it("a press and release in one frame clicks", async () => {
    const { canvas, play } = menu();
    const r = runtime();
    await layout(r, canvas);
    Input.simulatePointer(100, 40);
    Input.simulate("down", "mouse0");
    Input.simulate("up", "mouse0");
    engine.step(DT);
    expect(play.clicked).toBe(true);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    expect(Input.getMouseButtonUp(0)).toBe(false);
    expect(Input.getKey("mouse0")).toBe(false);
  });

  it("a non-interactable button blocks the pointer but isn't hovered or clicked", async () => {
    const { canvas, play } = menu();
    play.interactable = false;
    const r = runtime();
    await layout(r, canvas);
    mouse("down", 100, 40);
    expect(Input.pointerOverUI).toBe(true);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    expect(play.hovered).toBe(false);
    mouse("up", 100, 40);
    expect(play.clicked).toBe(false);
  });

  it("ignores hidden and inactive buttons", async () => {
    const { canvas, play, quit } = menu();
    const r = runtime();
    await layout(r, canvas);
    play.visible = false;
    quit.node.setActive(false);
    r.sync(world(), 1280, 720, DT);
    Input.simulatePointer(100, 40);
    engine.step(DT);
    expect(r.hitTest(100, 40)).toBeNull();
    expect(Input.pointerOverUI).toBe(false);
  });

  it("tests canvases from the highest sortOrder down", async () => {
    const back = node("Back", null, UICanvas, { sortOrder: 0 } as Partial<UICanvas>);
    const backButton = node("BackButton", back.node, UIButton, { width: 400, height: 400 } as Partial<UIButton>);
    const front = node("Front", null, UICanvas, { sortOrder: 5 } as Partial<UICanvas>);
    const frontButton = node("FrontButton", front.node, UIButton, { width: 100, height: 100 } as Partial<UIButton>);
    const r = runtime();
    await layout(r, back);
    await layout(r, front);
    expect(r.hitTest(50, 50)).toBe(frontButton);
    expect(r.hitTest(300, 300)).toBe(backButton);
    front.sortOrder = -1;
    r.sync(world(), 1280, 720, DT);
    expect(r.hitTest(50, 50)).toBe(backButton);
  });

  it("picks the topmost of overlapping siblings (later in node order)", async () => {
    const canvas = node("Canvas", null, UICanvas);
    const under = node("Under", canvas.node, UIButton, { width: 100, height: 100, positionType: "absolute", left: 0, top: 0 } as Partial<UIButton>);
    const over = node("Over", canvas.node, UIButton, { width: 100, height: 100, positionType: "absolute", left: 50, top: 0 } as Partial<UIButton>);
    const r = runtime();
    await layout(r, canvas);
    expect(r.hitTest(25, 50)).toBe(under);
    expect(r.hitTest(75, 50)).toBe(over);
  });

  it("routes only in a World that takes input, and not when non-interactive (the editor's World)", async () => {
    const { canvas, play } = menu();
    const editor = new UIRuntime({ interactive: false });
    runtimes.push(editor);
    await layout(editor, canvas);
    mouse("down", 100, 40);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(play.pressed).toBe(false);
    mouse("up", 100, 40);

    const r = runtime();
    await layout(r, canvas);
    world()._takesInput = false;
    mouse("down", 100, 40);
    expect(play.pressed).toBe(false);
    world()._takesInput = true;
  });

  it("stops routing once disposed", async () => {
    const { canvas } = menu();
    const r = runtime();
    await layout(r, canvas);
    r.dispose();
    mouse("down", 100, 40);
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
  });
});

describe("UIInputField focus and keyboard routing (ADR 0069)", () => {
  async function form() {
    const canvas = node("Canvas", null, UICanvas);
    const field = node("Name", canvas.node, UIInputField, { width: 300, height: 40, placeholder: "Name" } as Partial<UIInputField>);
    const r = runtime();
    await layout(r, canvas);
    return { canvas, field, r };
  }

  it("focuses on a click, takes the keyboard, and unfocuses on a click elsewhere", async () => {
    const { field } = await form();
    const keys: boolean[] = [];
    class Game extends GameBehavior {
      update() {
        keys.push(Input.getKeyDown("w") || Input.getKey("w"));
      }
    }
    GameObject.create("Game").addBehavior(Game);

    mouse("down", 50, 20);
    expect(field.focused).toBe(true);
    expect(Input.getMouseButtonDown(0)).toBe(false);
    mouse("up", 50, 20);

    Input.simulate("down", "w");
    engine.step(DT);
    expect(Input.keyboardOverUI).toBe(true);
    expect(keys.at(-1)).toBe(false);
    expect(Input.anyKeyDown).toBe(false);
    Input.simulate("up", "w");
    engine.step(DT);

    mouse("down", 900, 500);
    expect(field.focused).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    mouse("up", 900, 500);

    Input.simulate("down", "w");
    engine.step(DT);
    expect(Input.keyboardOverUI).toBe(false);
    expect(keys.at(-1)).toBe(true);
  });

  it("a script can focus the field, and focus is the keyboard's while set", async () => {
    const { field } = await form();
    field.focused = true;
    Input.simulate("down", "space");
    engine.step(DT);
    expect(Input.getKeyDown("space")).toBe(false);
    field.focused = false;
    engine.step(DT);
    expect(Input.getKey("space")).toBe(true);
  });

  it("shows the value, or the placeholder when empty, laid out at its size", async () => {
    const { field, r } = await form();
    expect(r.rectOf(field)).toEqual({ x: 0, y: 0, width: 300, height: 40 });
    field.value = "Ada";
    r.sync(world(), 1280, 720, DT);
    expect(r.rectOf(field)!.width).toBe(300);
  });
});

describe("Input without UI (ADR 0069 keeps the old behaviour)", () => {
  it("reports presses, holds and releases as before when nothing claims them", () => {
    Input.simulatePointer(10, 10);
    Input.simulate("down", "mouse0");
    Input.beginFrame();
    expect(Input.pointerOverUI).toBe(false);
    expect(Input.getMouseButtonDown(0)).toBe(true);
    expect(Input.getMouseButton(0)).toBe(true);
    expect(Input.mousePosition).toEqual(new Vector2(10, 10));
    Input.simulate("up", "mouse0");
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
