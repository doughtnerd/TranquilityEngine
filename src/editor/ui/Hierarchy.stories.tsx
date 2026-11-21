// Stories (ADR 0219, 0235, 0278) for the Hierarchy panel's scene adapter over the tree view, with a scene open in a
// headless Editor World: arrow keys select scene nodes, F2 and the menu's Rename rename a node in place as one
// undoable document edit, and a node inside a prefab instance renames as an override. Every edit is checked in the
// scene document (`editor.scene.open`) and undone through its stack, as Ctrl+Z does.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../sdk";
import { PanelStory, withEditor, type EditorStoryParameters } from "../stories/editorStory";

const SCENE = "scenes/level.scene.json";
const PREFAB = "prefabs/cart.prefab.json";

const scene = {
  format: "myco.scene@4",
  nodes: [
    { id: "cam", name: "Camera", components: [{ type: "engine.Transform" }] },
    { id: "a", name: "Crate A", components: [{ type: "engine.Transform" }] },
    { id: "b", name: "Crate B", parent: "a", components: [{ type: "engine.Transform" }] },
    { id: "cart", name: "Cart", prefab: PREFAB },
  ],
};
const cart = {
  format: "myco.scene@4",
  nodes: [
    { id: "root", name: "Cart", components: [{ type: "engine.Transform" }] },
    { id: "wheel", name: "Wheel", parent: "root", components: [{ type: "engine.Transform" }] },
  ],
};

const meta = {
  title: "Editor/Hierarchy",
  beforeEach: withEditor,
  parameters: { editor: { files: { [SCENE]: scene, [PREFAB]: cart }, scene: SCENE } satisfies EditorStoryParameters },
  render: () => <PanelStory id="hierarchy" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const doc = () => editor.scene.open!.doc;
const undo = () => editor.scene.open!.stack.undo();
const rowName = (root: HTMLElement, name: string) => within(root).findByText(name, { selector: ".tree .name" }, { timeout: 30000 });
const itemOf = (el: HTMLElement) => el.closest<HTMLElement>("[role=treeitem]")!;

export const ArrowKeysSelect: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await rowName(canvasElement, "Camera"));
    expect(editor.scene.selection.keys).toEqual(["cam"]);
    await userEvent.keyboard("{ArrowDown}");
    expect(editor.scene.selection.keys).toEqual(["a"]);
    await userEvent.keyboard("{ArrowDown}");
    expect(editor.scene.selection.keys).toEqual(["b"]);
    expect(itemOf(await rowName(canvasElement, "Crate B"))).toHaveAttribute("aria-level", "2");
    await userEvent.keyboard("{ArrowLeft}"); // a leaf: to its parent
    expect(editor.scene.selection.keys).toEqual(["a"]);
    await userEvent.keyboard("{End}");
    expect(editor.scene.selection.keys).toEqual(["cart"]);
    // A prefab instance starts closed; Right shows its inner nodes, and Right again steps in.
    expect(itemOf(await rowName(canvasElement, "Cart"))).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(editor.scene.selection.keys).toEqual(["cart/wheel"]);
  },
};

export const RenameWithF2: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await rowName(canvasElement, "Crate A"));
    await userEvent.keyboard("{F2}");
    const field = within(canvasElement).getByRole("textbox", { name: "Node name" });
    expect(field).toHaveFocus();
    await userEvent.keyboard("{Control>}a{/Control}Box{Enter}");
    expect(doc().node("a").name).toBe("Box");
    expect(await rowName(canvasElement, "Box")).toBeInTheDocument();
    // An empty name changes nothing; Escape neither.
    await userEvent.keyboard("{F2}{Backspace}{Enter}");
    expect(doc().node("a").name).toBe("Box");
    await userEvent.keyboard("{F2}Other{Escape}");
    expect(doc().node("a").name).toBe("Box");
    undo();
    expect(doc().node("a").name).toBe("Crate A");
  },
};

export const RenameFromTheMenu: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.pointer({ keys: "[MouseRight]", target: await rowName(canvasElement, "Camera") });
    const item = c.getByRole("menuitem", { name: /^Rename/ });
    expect(item).toBeEnabled();
    await userEvent.click(item);
    expect(c.getByRole("textbox", { name: "Node name" })).toHaveFocus();
    await userEvent.keyboard("{Control>}a{/Control}Main Camera{Enter}");
    expect(doc().node("cam").name).toBe("Main Camera");
    undo();
    expect(doc().node("cam").name).toBe("Camera");
  },
};

export const RenameInsideAnInstance: Story = {
  play: async ({ canvasElement }) => {
    const cartItem = itemOf(await rowName(canvasElement, "Cart"));
    await userEvent.click(cartItem.querySelector<HTMLElement>(":scope > .row > .caret")!);
    await userEvent.click(await rowName(canvasElement, "Wheel"));
    await userEvent.keyboard("{F2}{Control>}a{/Control}Front Wheel{Enter}");
    // An override on the instance, not a change to the prefab.
    await waitFor(() => expect(doc().node("cart").overrides).toEqual([{ target: ["wheel"], name: "Front Wheel" }]));
    expect(await rowName(canvasElement, "Front Wheel")).toBeInTheDocument();
    undo();
    expect(doc().node("cart").overrides ?? []).toEqual([]);
  },
};
