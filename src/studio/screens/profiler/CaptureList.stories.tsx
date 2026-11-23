// Stories (ADR 0219, 0348) for the Captures panel's view: captures by folder (editor and game-build captures and a
// take), the open one selected, a click opening another, search by path, the context menu's Move to… dialog, F2
// renaming in place, Delete, and the empty state saying where captures come from.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { CaptureList, type CaptureListProps } from "./CaptureList";
import "./profiler.css";

const FILES = ["captures/canyon_run_03.mycap", "captures/boss_mix_check.mycap", "captures/Test PC/slot 07.mycap", "captures/Tablet/slot 06.mycap", "takes/canyon_run_03.mycotake", "sfx/boom.wav", "project.json"];
const FOLDERS = ["captures", "captures/Test PC", "captures/Tablet", "takes", "sfx"];

const meta = {
  title: "Studio/Profiler/Captures",
  component: CaptureList,
  args: { files: FILES, folders: FOLDERS, openPath: "captures/canyon_run_03.mycap", writable: true, onOpen: fn(), onImport: fn(), onRename: fn(), onMove: fn(), onDelete: fn() },
  decorators: [(Story) => <div style={{ width: "280px", height: "420px" }}>{Story()}</div>],
} satisfies Meta<CaptureListProps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ByFolder: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const tree = c.getByRole("tree", { name: "Captures" });
    // Each item's own row (an open folder's item holds the rows under it too).
    await expect(within(tree).getAllByRole("treeitem").map((r) => r.querySelector(".row")?.textContent?.trim())).toEqual(expect.arrayContaining(["Test PC", "slot 07.mycap", "canyon_run_03.mycotake"]));
    await expect(within(tree).queryByText("boom.wav")).toBeNull();
    await expect(c.getByRole("treeitem", { name: /canyon_run_03.mycap/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(c.getByText("boss_mix_check.mycap"));
    await expect(args.onOpen).toHaveBeenCalledWith("captures/boss_mix_check.mycap");
  },
};

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByRole("searchbox", { name: "Search captures" }), "slot");
    const tree = c.getByRole("tree", { name: "Matching captures" });
    await expect(within(tree).getAllByRole("treeitem").map((r) => r.textContent?.trim())).toEqual(["captures/Tablet/slot 06.mycap", "captures/Test PC/slot 07.mycap"]);
  },
};

export const RenameAndDelete: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const row = c.getByRole("treeitem", { name: /boss_mix_check.mycap/ });
    row.focus();
    await userEvent.keyboard("{F2}");
    const field = await waitFor(() => c.getByRole("textbox", { name: "Capture name" }));
    await userEvent.clear(field);
    await userEvent.type(field, "boss_final.mycap{Enter}");
    await expect(args.onRename).toHaveBeenCalledWith("captures/boss_mix_check.mycap", "boss_final.mycap");
    c.getByRole("treeitem", { name: /slot 06/ }).focus();
    await userEvent.keyboard("{Delete}");
    await expect(args.onDelete).toHaveBeenCalledWith("captures/Tablet/slot 06.mycap");
  },
};

export const MoveTo: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const row = c.getByRole("treeitem", { name: /slot 07/ });
    row.querySelector(".row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("menuitem", { name: "Move to…" }));
    const dialog = await body.findByRole("dialog");
    await userEvent.click(within(dialog).getByText("Tablet"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await expect(args.onMove).toHaveBeenCalledWith("captures/Test PC/slot 07.mycap", "captures/Tablet");
  },
};

export const Empty: Story = {
  args: { files: ["sfx/boom.wav"], openPath: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/record one from the editor's Play/)).toBeVisible();
  },
};

export const ReadOnly: Story = { args: { writable: false } };
