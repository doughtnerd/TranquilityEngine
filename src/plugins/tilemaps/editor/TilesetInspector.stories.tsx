// Stories (ADR 0219, 0235) for the Tileset inspector (ADR 0103): a `*.tileset.json` selected in the Assets panel. Each
// edit goes through the tileset's asset document, so each story checks the file it writes and its Undo and Redo.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { fileJson, withEditor, type EditorStoryParameters } from "../../../editor/stories/editorStory";
import type { TilesetData } from "../runtime/tileset";
import { TilesetInspector } from "./TilesetInspector";

const TILESET = "tiles/ground.tileset.json";

const ground = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  terrains: [{ name: "Ground", color: "#7cb342" }],
  tiles: [
    { id: 1, name: "Ground 0", sprite: "asset:images/tiles.png#ground_0", collision: "full", terrain: "Ground", pattern: "0*0*0*0*" },
    { id: 2, name: "Ground 1", sprite: "asset:images/tiles.png#ground_1", collision: "full", terrain: "Ground", pattern: "1*0*0*0*" },
  ],
};

const saved = () => fileJson<TilesetData>(TILESET);
const tile = async (id: number) => (await saved()).tiles.find((t) => t.id === id)!;

const meta = {
  title: "Tilemaps/Tileset inspector",
  component: TilesetInspector,
  beforeEach: withEditor,
  parameters: { editor: { files: { [TILESET]: ground } } satisfies EditorStoryParameters },
  args: { path: TILESET },
} satisfies Meta<typeof TilesetInspector>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TileSize: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const width = c.getByLabelText("Tile Width") as HTMLInputElement;
    expect(width.value).toBe("16");
    fireEvent.change(width, { target: { value: "32" } });
    await waitFor(async () => expect((await saved()).tileSize).toEqual([32, 16]));
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await saved()).tileSize).toEqual([16, 16]));
    await userEvent.click(c.getByRole("button", { name: "Redo" }));
    await waitFor(async () => expect((await saved()).tileSize).toEqual([32, 16]));
  },
};

export const EditATile: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    expect(c.getByRole("listbox", { name: "Tiles" })).toBeVisible();
    // Let the first render's effects run (one clears the picked tile when the path changes), as a frame does for a user.
    await new Promise((r) => setTimeout(r, 50));
    expect(c.queryByRole("group", { name: "Collision presets" })).toBeNull();
    await step("picking a tile shows its properties", async () => {
      await userEvent.click(c.getByRole("option", { name: /Ground 1/ }));
      expect(c.getByRole("option", { name: /Ground 1/ })).toHaveAttribute("aria-selected", "true");
      expect(c.getByRole("button", { name: "Full cell" })).toHaveAttribute("aria-pressed", "true");
      expect(c.getByLabelText("Terrain")).toHaveValue("Ground");
    });
    await step("collision: one way, then exact points typed under the disclosure", async () => {
      await userEvent.click(c.getByRole("button", { name: "One-way cell" }));
      await waitFor(async () => expect((await tile(2)).collision).toBe("oneWay"));
      const points = c.getByLabelText("Polygon points") as HTMLInputElement;
      expect(points.value).toBe("0,0 1,0 1,1 0,1");
      fireEvent.change(points, { target: { value: "0,0 1,0 1,0.5" } });
      await waitFor(async () => expect((await tile(2)).collision).toEqual({ polygon: [[0, 0], [1, 0], [1, 0.5]], oneWay: true }));
    });
    await step("a neighbour button cycles same terrain, other, either", async () => {
      const north = () => c.getByRole("group", { name: "Neighbour pattern" }).querySelector<HTMLButtonElement>('[aria-label^="Neighbour N:"]')!;
      expect(north()).toHaveAccessibleName("Neighbour N: same terrain");
      await userEvent.click(north());
      expect(north()).toHaveAccessibleName("Neighbour N: other");
      await waitFor(async () => expect((await tile(2)).pattern).toBe("0*0*0*0*"));
      await userEvent.click(north());
      await waitFor(async () => expect((await tile(2)).pattern).toBe("**0*0*0*"));
    });
    await step("leaving the terrain removes the tile's terrain; the other tile keeps it", async () => {
      await userEvent.selectOptions(c.getByLabelText("Terrain"), "");
      await waitFor(async () => expect((await tile(2)).terrain).toBeUndefined());
      expect((await tile(1)).terrain).toBe("Ground");
    });
  },
};

export const Terrains: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: /Add terrain/i }));
    await waitFor(async () => expect((await saved()).terrains.map((t) => t.name)).toEqual(["Ground", "Terrain 2"]));
    // Removing a terrain takes it off its tiles too.
    await userEvent.click(c.getByRole("button", { name: "Remove Ground" }));
    await waitFor(async () => expect((await saved()).terrains.map((t) => t.name)).toEqual(["Terrain 2"]));
    expect((await saved()).tiles.every((t) => t.terrain === undefined)).toBe(true);
  },
};

export const UnreadableFile: Story = {
  parameters: { editor: { files: { [TILESET]: "{ not json" } } satisfies EditorStoryParameters },
  play: async ({ canvasElement }) => {
    expect(canvasElement.querySelector(".asset-inspector-problems")).not.toBeNull();
  },
};

export const CollisionShapes: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await new Promise((r) => setTimeout(r, 50));
    await userEvent.click(c.getByRole("option", { name: /Ground 0/ }));
    await step("a rectangle dragged over the tile adds a shape: one shape is the single-polygon form", async () => {
      await userEvent.click(c.getByRole("button", { name: "None" }));
      await waitFor(async () => expect((await tile(1)).collision).toBe("none"));
      await userEvent.click(c.getByRole("button", { name: "Add rectangle" }));
      const canvas = c.getByRole("img", { name: "Tile collision shapes" });
      const r = canvas.getBoundingClientRect();
      // The view is the 16-pixel cell with a 2-pixel margin: 20 pixels across.
      const at = (x: number, y: number) => ({ clientX: r.left + ((x + 2) / 20) * r.width, clientY: r.top + ((18 - y) / 20) * r.height, button: 0, pointerId: 1 });
      fireEvent.pointerDown(canvas, at(0, 0));
      fireEvent.pointerMove(canvas, at(16, 8));
      fireEvent.pointerUp(canvas, at(16, 8));
      await waitFor(async () => expect((await tile(1)).collision).toEqual({ polygon: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] }));
    });
    await step("a second shape, one way, makes the shapes form", async () => {
      await userEvent.click(c.getByRole("button", { name: "Add rectangle" }));
      const canvas = c.getByRole("img", { name: "Tile collision shapes" });
      const r = canvas.getBoundingClientRect();
      const at = (x: number, y: number) => ({ clientX: r.left + ((x + 2) / 20) * r.width, clientY: r.top + ((18 - y) / 20) * r.height, button: 0, pointerId: 1 });
      fireEvent.pointerDown(canvas, at(0, 12));
      fireEvent.pointerMove(canvas, at(16, 16));
      fireEvent.pointerUp(canvas, at(16, 16));
      await waitFor(async () => expect((await tile(1)).collision).toMatchObject({ shapes: [{}, { polygon: [[0, 0.75], [1, 0.75], [1, 1], [0, 1]] }] }));
      await userEvent.click(c.getByLabelText("Shape 2 one way"));
      await waitFor(async () => expect((await tile(1)).collision).toMatchObject({ shapes: [{}, { oneWay: true }] }));
      await userEvent.click(c.getByRole("button", { name: "Undo" }));
      await waitFor(async () => expect((await tile(1)).collision).toMatchObject({ shapes: [{}, { polygon: [[0, 0.75], [1, 0.75], [1, 1], [0, 1]] }] }));
    });
    await step("the shadow set: Same as collision is no occluder; None writes one", async () => {
      await userEvent.click(c.getByRole("radio", { name: "Shadow" }));
      expect(c.getByRole("button", { name: "Same as collision" })).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(c.getByRole("button", { name: "None" }));
      await waitFor(async () => expect((await tile(1)).occluder).toBe("none"));
      await userEvent.click(c.getByRole("button", { name: "Same as collision" }));
      await waitFor(async () => expect("occluder" in (await tile(1))).toBe(false));
      await userEvent.click(c.getByRole("radio", { name: "Collision" }));
    });
    await step("Ctrl+click selects another tile; Apply gives it this tile's collision", async () => {
      await userEvent.click(c.getByRole("option", { name: /Ground 1/ }));
      fireEvent.click(c.getByRole("option", { name: /Ground 0/ }), { ctrlKey: true });
      await userEvent.click(c.getByRole("button", { name: "Apply to 1 selected" }));
      await waitFor(async () => expect((await tile(2)).collision).toEqual((await tile(1)).collision));
    });
  },
};

export const PreviewGrid: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Preview Grid"), "isometric");
    await waitFor(async () => expect((await saved()).previewGrid).toBe("isometric"));
    await userEvent.selectOptions(c.getByLabelText("Preview Grid"), "square");
    await waitFor(async () => expect("previewGrid" in (await saved())).toBe(false));
  },
};
