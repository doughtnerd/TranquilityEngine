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
    expect(c.queryByLabelText("Collision")).toBeNull();
    await step("picking a tile shows its properties", async () => {
      await userEvent.click(c.getByRole("option", { name: /Ground 1/ }));
      expect(c.getByRole("option", { name: /Ground 1/ })).toHaveAttribute("aria-selected", "true");
      expect(c.getByLabelText("Collision")).toHaveValue("full");
      expect(c.getByLabelText("Terrain")).toHaveValue("Ground");
    });
    await step("collision: one way, then a polygon typed as points", async () => {
      await userEvent.selectOptions(c.getByLabelText("Collision"), "oneWay");
      await waitFor(async () => expect((await tile(2)).collision).toBe("oneWay"));
      await userEvent.selectOptions(c.getByLabelText("Collision"), "polygon");
      await waitFor(async () => expect(typeof (await tile(2)).collision).toBe("object"));
      expect(c.getByLabelText("Polygon points")).toBeVisible();
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
