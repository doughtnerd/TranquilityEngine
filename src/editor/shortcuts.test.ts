// The editor's keyboard shortcuts, through what they do: keys go to a window `installShortcuts`
// listens on, and the test reads the open demo scene, its history, the tool and the event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SetField } from "./document";
import { nodeClipboard } from "./hierarchyActions";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { installShortcuts } from "./shortcuts";
import { openScene, openScenes, pickTool, sceneCamera, select, selectedKeys, tool } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

type Mods = Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string }>;

let keys: EventTarget;
let stop: () => void;

/** Press `key` on the window the shortcuts listen on; returns whether the editor claimed it (preventDefault). */
function press(key: string, mods: Mods = {}, target: object | null = null): boolean {
  const e = Object.assign(new Event("keydown"), {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    preventDefault: vi.fn(),
  });
  Object.defineProperty(e, "target", { value: target });
  keys.dispatchEvent(e);
  return e.preventDefault.mock.calls.length > 0;
}

beforeEach(async () => {
  Input.reset();
  const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, DEMO_SCENE);
  select([]);
  keys = new EventTarget();
  stop = installShortcuts(keys as unknown as Window);
});

afterEach(() => stop());

const birdY = () => (openScene.value!.doc.fieldValue("bird", "engine.Transform", "position") as number[])[1];
const setBirdY = (y: number) => openScene.value!.stack.execute(new SetField("bird", "engine.Transform", "position", [-4, y, 0]));

describe("tool shortcuts", () => {
  it("Q/W/E/R pick the tools; modified keys don't", () => {
    pickTool("move");
    press("q");
    expect(tool.value).toBe("select");
    press("w");
    expect(tool.value).toBe("move");
    press("E");
    expect(tool.value).toBe("rotate");
    press("r");
    expect(tool.value).toBe("scale");
    press("q", { altKey: true });
    press("q", { shiftKey: true });
    press("w", { ctrlKey: true, shiftKey: true });
    expect(tool.value).toBe("scale");
  });
});

describe("history shortcuts", () => {
  it("Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo, plain Z does nothing", () => {
    const y0 = birdY();
    setBirdY(7);
    expect(press("z")).toBe(false);
    expect(birdY()).toBe(7);
    expect(press("z", { ctrlKey: true })).toBe(true);
    expect(birdY()).toBe(y0);
    press("Z", { ctrlKey: true, shiftKey: true });
    expect(birdY()).toBe(7);
    press("z", { metaKey: true });
    expect(birdY()).toBe(y0);
    press("y", { ctrlKey: true });
    expect(birdY()).toBe(7);
  });

  it("Ctrl/Cmd+Alt(+Shift)+Z steps through states in creation order, across branches", () => {
    const y0 = birdY();
    setBirdY(1);
    press("z", { ctrlKey: true }); // back at the start…
    setBirdY(2); // …and a second branch
    press("z", { ctrlKey: true, altKey: true }); // the state made before this one: the first branch
    expect(birdY()).toBe(1);
    press("z", { ctrlKey: true, altKey: true, shiftKey: true });
    expect(birdY()).toBe(2);
    // Alt changes `key` on macOS; the key code still says Z.
    press("Ω", { metaKey: true, altKey: true, code: "KeyZ" });
    expect(birdY()).toBe(1);
    press("z", { ctrlKey: true });
    expect(birdY()).toBe(y0);
  });

  it("a text field keeps its own undo", () => {
    setBirdY(7);
    const field = Object.assign(Object.create(null), { nodeType: 1, tagName: "INPUT", type: "text", isContentEditable: false, closest: () => null });
    press("z", { ctrlKey: true }, field);
    expect(birdY()).toBe(7);
  });
});

describe("node shortcuts", () => {
  it("Ctrl/Cmd+D duplicates the selected node, Delete removes the copy (now selected)", async () => {
    const count = () => openScene.value!.doc.nodes.length;
    const n = count(), bird = openScene.value!.doc.subtree("bird").length;
    select(["bird"]);
    expect(press("d", { ctrlKey: true })).toBe(true);
    expect(count()).toBe(n + bird);
    press("d", { ctrlKey: true, shiftKey: true });
    expect(count()).toBe(n + bird);
    const copy = selectedKeys.value[0];
    expect(copy).not.toBe("bird");
    expect(press("Delete")).toBe(true);
    await vi.waitFor(() => expect(openScene.value!.doc.has(copy)).toBe(false));
    expect(count()).toBe(n);
  });

  it("Ctrl/Cmd+C copies and Ctrl/Cmd+V pastes", () => {
    nodeClipboard.value = null;
    const n = openScene.value!.doc.nodes.length, bird = openScene.value!.doc.subtree("bird").length;
    select(["bird"]);
    press("c", { metaKey: true });
    expect(nodeClipboard.peek()?.subtrees).toHaveLength(1);
    press("v", { metaKey: true });
    expect(openScene.value!.doc.nodes.length).toBe(n + bird);
  });
});

describe("play, pause, step, save and close keys", () => {
  it("claims Ctrl/Cmd+P, Ctrl/Cmd+Shift+P, F10, Ctrl/Cmd+Alt+P and Ctrl/Cmd+S from the browser", () => {
    expect(press("p", { ctrlKey: true })).toBe(true); // play, not print
    expect(press("P", { ctrlKey: true, shiftKey: true })).toBe(true); // pause
    expect(press("p", { metaKey: true, shiftKey: true })).toBe(true);
    expect(press("F10")).toBe(true); // step
    expect(press("p", { ctrlKey: true, altKey: true })).toBe(true);
    expect(press("s", { ctrlKey: true })).toBe(true);
    expect(press("F10", { shiftKey: true })).toBe(false);
  });

  it("Ctrl/Cmd+W closes the scene tab; plain W is the move tool", async () => {
    pickTool("select");
    press("w");
    expect(tool.value).toBe("move");
    expect(openScenes.value).toHaveLength(1);
    expect(press("w", { ctrlKey: true })).toBe(true);
    await vi.waitFor(() => expect(openScenes.value).toHaveLength(0));
  });
});
