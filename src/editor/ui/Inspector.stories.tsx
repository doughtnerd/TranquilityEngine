// Stories (ADR 0219, 0235) for the Inspector panel as the dock renders it, over a scene open in a headless Editor World:
// the scene's own settings with nothing selected, a node's header (name, active), a component card's enabled box and
// remove button, several nodes at once, and an asset revealed from the Assets panel. Every edit is checked in the scene
// document (`editor.scene.open`) and undone through its stack, as Ctrl+Z does. Number fields' drags are left to the
// Inspector's own unit tests.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../sdk";
import { PanelStory, withEditor, type EditorStoryParameters } from "../stories/editorStory";

const SCENE = "scenes/level.scene.json";

const scene = {
  format: "myco.scene@4",
  nodes: [
    {
      id: "cam",
      name: "Camera",
      components: [
        { type: "engine.Transform", data: { position: [0, 0, -10] } },
        { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 5 } },
      ],
    },
    { id: "a", name: "Crate A", components: [{ type: "engine.Transform", data: { position: [1, 0, 0] } }] },
    { id: "b", name: "Crate B", components: [{ type: "engine.Transform", data: { position: [2, 0, 0] } }] },
  ],
};

const tileset = { format: "myco.tileset@1", tileSize: [16, 16], terrains: [], tiles: [] };
const PREFAB = "prefabs/crate.prefab.json";
const crate = { format: "myco.scene@4", nodes: [{ id: "crate", name: "Crate", components: [{ type: "engine.Transform", data: {} }] }] };

const meta = {
  title: "Editor/Inspector",
  beforeEach: withEditor,
  parameters: { editor: { files: { [SCENE]: scene, "tiles/ground.tileset.json": tileset, [PREFAB]: crate }, scene: SCENE } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const doc = () => editor.scene.open!.doc;
const undo = () => editor.scene.open!.stack.undo();
/** Wait for the lazy Inspector to load and show `text`. */
const shows = (canvasElement: HTMLElement, text: string | RegExp) => within(canvasElement).findByText(text, {}, { timeout: 30000 });

export const SceneSettings: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await shows(canvasElement, "Scene settings");
    // With nothing selected: the scene's preload list, which takes prefabs and materials.
    const field = c.getByRole("combobox", { name: "Add to the preload list" }) as HTMLInputElement;
    await userEvent.type(field, "tiles/ground.tileset.json{Enter}");
    expect(doc().preload).toEqual([]);
    await userEvent.type(field, PREFAB);
    await userEvent.click(c.getByRole("button", { name: "Add" }));
    expect(doc().preload).toEqual([PREFAB]);
    expect(field).toHaveValue("");
    await userEvent.click(c.getByRole("button", { name: `Remove ${PREFAB} from the preload list` }));
    expect(doc().preload).toEqual([]);
    undo();
    expect(doc().preload).toEqual([PREFAB]);
  },
};

export const NodeHeader: Story = {
  play: async ({ canvasElement, step }) => {
    editor.scene.selection.set(["a"]);
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole("textbox", { name: "Name" })).toHaveValue("Crate A"), { timeout: 30000 });
    // Not covered yet: Escape while typing a name should drop the draft, but the name field's blur commits the draft its
    // keydown handler was rendered with, so the typed name is saved (ADR 0235's notes).
    await step("renaming commits on Enter, one undo step", async () => {
      const name = c.getByRole("textbox", { name: "Name" });
      await userEvent.clear(name);
      await userEvent.type(name, "Barrel{Enter}");
      expect(doc().node("a").name).toBe("Barrel");
      undo();
      await waitFor(() => expect(c.getByRole("textbox", { name: "Name" })).toHaveValue("Crate A"));
    });
    await step("the Active box switches the node off and on", async () => {
      await userEvent.click(c.getByRole("checkbox", { name: "Active" }));
      expect(doc().node("a").active).toBe(false);
      await userEvent.click(c.getByRole("checkbox", { name: "Active" }));
      expect(doc().node("a").active ?? true).toBe(true);
    });
  },
};

export const ComponentCard: Story = {
  play: async ({ canvasElement, step }) => {
    editor.scene.selection.set(["cam"]);
    const c = within(canvasElement);
    const enabled = await c.findByRole("checkbox", { name: "Camera enabled" }, { timeout: 30000 });
    await step("Transform has no remove button and is always on", async () => {
      expect(c.queryByRole("button", { name: "Remove Transform" })).toBeNull();
      expect(c.getByRole("checkbox", { name: "Transform enabled" })).toBeDisabled();
    });
    await step("the enabled box disables the component in the scene", async () => {
      expect(enabled).toBeChecked();
      await userEvent.click(enabled);
      expect(doc().components("cam").find((x) => x.type === "engine.Camera")?.enabled).toBe(false);
      undo();
      await waitFor(() => expect(c.getByRole("checkbox", { name: "Camera enabled" })).toBeChecked());
    });
    await step("remove takes the component out; undo puts it back", async () => {
      await userEvent.click(c.getByRole("button", { name: "Remove Camera" }));
      expect(doc().components("cam").map((x) => x.type)).toEqual(["engine.Transform"]);
      await waitFor(() => expect(c.queryByRole("checkbox", { name: "Camera enabled" })).toBeNull());
      undo();
      await waitFor(() => expect(c.getByRole("checkbox", { name: "Camera enabled" })).toBeVisible());
    });
  },
};

export const SeveralNodes: Story = {
  play: async ({ canvasElement }) => {
    editor.scene.selection.set(["a", "b"]);
    await shows(canvasElement, "2 nodes selected");
    const c = within(canvasElement);
    // The Active box acts on every selected node, as one undo step.
    await userEvent.click(c.getByRole("checkbox", { name: "Active" }));
    expect([doc().node("a").active, doc().node("b").active]).toEqual([false, false]);
    undo();
    expect([doc().node("a").active ?? true, doc().node("b").active ?? true]).toEqual([true, true]);
  },
};

export const RevealedAsset: Story = {
  play: async ({ canvasElement }) => {
    editor.scene.selection.set(["a"]);
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole("textbox", { name: "Name" })).toHaveValue("Crate A"), { timeout: 30000 });
    // Revealing an asset shows its kind's inspector in place of the node's; selecting a node again brings it back.
    editor.assets.reveal("tiles/ground.tileset.json");
    expect(await c.findByLabelText("Tileset", {}, { timeout: 15000 })).toBeVisible();
    editor.scene.selection.set(["b"]);
    await waitFor(() => expect(c.getByRole("textbox", { name: "Name" })).toHaveValue("Crate B"));
  },
};
