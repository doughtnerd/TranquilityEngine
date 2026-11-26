// Stories (ADR 0219, 0348) for the Captures panel's view, the run-file tree Takes shares: captures by folder (editor and
// game-build captures and a take, one folder and one extension, ADR 0409) with bare names and durations, the open one selected, a click opening another, search
// with each match's folders in its meta, the toolbar's add menu (Open capture file…, New folder) and Collapse all, the
// file and folder menus (Duplicate, Move to…, Move to top level, Delete folder), F2 renaming in place, Delete, a drag
// onto a folder, and the empty state saying where captures come from.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { CaptureList, type CaptureListProps } from "./CaptureList";
import "./profiler.css";

const FILES = ["recordings/canyon_run_03.sporesample", "recordings/boss_mix_check.sporesample", "recordings/Test PC/slot 07.sporesample", "recordings/Tablet/slot 06.sporesample", "recordings/take_01.sporesample", "sfx/boom.wav", "project.json"];
const FOLDERS = ["recordings", "recordings/Test PC", "recordings/Tablet"];
const SECONDS: Record<string, number> = { "recordings/canyon_run_03.sporesample": 32, "recordings/Test PC/slot 07.sporesample": 108, "recordings/Tablet/slot 06.sporesample": 55 };

const meta = {
  title: "Studio/Profiler/Captures",
  component: CaptureList,
  args: {
    files: FILES, folders: FOLDERS, openPath: "recordings/canyon_run_03.sporesample", writable: true, duration: (p: string) => SECONDS[p] ?? null,
    onOpen: fn(), onImport: fn(), onRename: fn(), onMove: fn(), onDelete: fn(), onDuplicate: fn(), onRenameFolder: fn(), onDeleteFolder: fn(), onFolder: fn(),
    onNewFolder: fn(async (parent: string) => `${parent ? `${parent}/` : ""}New Folder`),
  },
  decorators: [(Story) => <div style={{ width: "280px", height: "420px" }}>{Story()}</div>],
} satisfies Meta<CaptureListProps>;
export default meta;
type Story = StoryObj<typeof meta>;

const rowOf = (item: HTMLElement) => item.querySelector<HTMLElement>(".row")!;
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));

export const ByFolder: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const tree = c.getByRole("tree", { name: "Captures" });
    const labels = within(tree).getAllByRole("treeitem").map((r) => r.querySelector(".name")?.textContent?.trim());
    // Bare names (no extension), folders first; files that aren't recordings stay out.
    await expect(labels).toEqual(expect.arrayContaining(["Test PC", "slot 07", "canyon_run_03"]));
    await expect(within(tree).queryByText("boom")).toBeNull();
    // The duration is the row's meta.
    await expect(rowOf(c.getByRole("treeitem", { name: /slot 07/ })).textContent).toContain("1:48");
    await expect(rowOf(c.getAllByRole("treeitem", { name: /canyon_run_03/ })[0]!).textContent).toContain("32.0 s");
    await expect(c.getAllByRole("treeitem", { name: /canyon_run_03/ })[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.click(c.getByText("boss_mix_check"));
    await expect(args.onOpen).toHaveBeenCalledWith("recordings/boss_mix_check.sporesample");
  },
};

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // The search field uses the editor's field tokens, not the browser's inset default.
    const field = getComputedStyle(c.getByRole("searchbox", { name: "Search captures" }));
    await expect([field.borderTopWidth, field.borderTopStyle, field.fontSize]).toEqual(["1px", "solid", "12px"]);
    await userEvent.type(c.getByRole("searchbox", { name: "Search captures" }), "slot");
    const tree = c.getByRole("tree", { name: "Matching captures" });
    const rows = within(tree).getAllByRole("treeitem");
    await expect(rows.map((r) => r.querySelector(".name")?.textContent)).toEqual(["slot 06", "slot 07"]);
    // Each match names its folders in its meta.
    await expect(rows[1]!.textContent).toContain("recordings › Test PC · 1:48");
    await userEvent.clear(c.getByRole("searchbox", { name: "Search captures" }));
    await userEvent.type(c.getByRole("searchbox", { name: "Search captures" }), "zzz");
    await expect(c.getByText("No matches")).toBeVisible();
  },
};

export const RenameAndDelete: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const row = c.getByRole("treeitem", { name: /boss_mix_check/ });
    row.focus();
    await userEvent.keyboard("{F2}");
    const field = await waitFor(() => c.getByRole("textbox", { name: "Capture name" }));
    await expect(field).toHaveValue("boss_mix_check");
    await userEvent.clear(field);
    await userEvent.type(field, "boss_final{Enter}");
    // The extension is kept.
    await expect(args.onRename).toHaveBeenCalledWith("recordings/boss_mix_check.sporesample", "boss_final.sporesample");
    c.getByRole("treeitem", { name: /slot 06/ }).focus();
    await userEvent.keyboard("{Delete}");
    await expect(args.onDelete).toHaveBeenCalledWith("recordings/Tablet/slot 06.sporesample");
  },
};

export const MoveTo: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    rightClick(rowOf(c.getByRole("treeitem", { name: /slot 07/ })));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("menuitem", { name: "Move to…" }));
    const dialog = await body.findByRole("dialog");
    await userEvent.click(within(dialog).getByText("Tablet"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await expect(args.onMove).toHaveBeenCalledWith(["recordings/Test PC/slot 07.sporesample"], "recordings/Tablet");
  },
};

export const FileMenu: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    rightClick(rowOf(c.getByRole("treeitem", { name: /slot 07/ })));
    await expect((await body.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Open", "RenameF2", "Duplicate", "Move to…", "Move to top level", "Delete captureDel"]);
    await userEvent.click(body.getByRole("menuitem", { name: "Duplicate" }));
    await expect(args.onDuplicate).toHaveBeenCalledWith("recordings/Test PC/slot 07.sporesample");
    rightClick(rowOf(c.getByRole("treeitem", { name: /slot 07/ })));
    await userEvent.click(await body.findByRole("menuitem", { name: "Move to top level" }));
    await expect(args.onMove).toHaveBeenCalledWith(["recordings/Test PC/slot 07.sporesample"], "");
  },
};

export const FolderMenu: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const folder = c.getAllByRole("treeitem", { name: /Test PC/ })[0]!;
    rightClick(rowOf(folder));
    await expect((await body.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["RenameF2", "New folder", "Move to…", "Move to top level", "Delete folderDel"]);
    await userEvent.click(body.getByRole("menuitem", { name: /Delete folder/ }));
    await expect(args.onDeleteFolder).toHaveBeenCalledWith("recordings/Test PC");
    // F2 renames a folder in place.
    folder.focus();
    await userEvent.keyboard("{F2}");
    const field = await waitFor(() => c.getByRole("textbox", { name: "Folder name" }));
    await userEvent.clear(field);
    await userEvent.type(field, "Desk PC{Enter}");
    await expect(args.onRenameFolder).toHaveBeenCalledWith("recordings/Test PC", "Desk PC");
  },
};

export const AddMenuAndCollapse: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    // The open capture's folder is where new things go (the menu says so).
    await userEvent.click(c.getByRole("button", { name: "More ways to add captures" }));
    await expect((await body.findAllByRole("menuitem")).map((m) => m.textContent)).toEqual(["Open capture file…into captures", "New folderin captures"]);
    await userEvent.click(body.getByRole("menuitem", { name: /New folder/ }));
    await expect(args.onNewFolder).toHaveBeenCalledWith("recordings");
    // Collapse all closes every folder.
    await userEvent.click(c.getByRole("button", { name: "Collapse all" }));
    await waitFor(() => expect(c.queryByText("slot 07")).toBeNull());
    await expect(c.getAllByRole("treeitem").map((r) => r.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  },
};

export const DragOntoFolder: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const from = rowOf(c.getByRole("treeitem", { name: /boss_mix_check/ }));
    const to = rowOf(c.getAllByRole("treeitem", { name: /Tablet/ })[0]!);
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const at = (r: DOMRect) => ({ clientX: r.left + 20, clientY: r.top + r.height / 2, bubbles: true, button: 0, pointerId: 1, pointerType: "mouse" });
    from.dispatchEvent(new PointerEvent("pointerdown", at(a)));
    window.dispatchEvent(new PointerEvent("pointermove", { ...at(a), clientY: a.top + 30 }));
    // While dragging, the top-level strip shows.
    await waitFor(() => expect(c.getByText("Top level")).toBeVisible());
    window.dispatchEvent(new PointerEvent("pointermove", at(to.getBoundingClientRect())));
    await waitFor(() => expect(to.closest("[role=treeitem]")!.querySelector(".row")!.className).toMatch(/drop/));
    window.dispatchEvent(new PointerEvent("pointerup", at(to.getBoundingClientRect())));
    void b;
    await expect(args.onMove).toHaveBeenCalledWith(["recordings/boss_mix_check.sporesample"], "recordings/Tablet");
  },
};

export const Empty: Story = {
  args: { files: ["sfx/boom.wav"], folders: [], openPath: null },
  play: async ({ canvasElement }) => {
    // Sentence case, and the Studio's own Record first (UI pass T4).
    await expect(within(canvasElement).getByText(/^Record one here while a playlist or a take plays/)).toBeVisible();
  },
};

export const ReadOnly: Story = { args: { writable: false } };
