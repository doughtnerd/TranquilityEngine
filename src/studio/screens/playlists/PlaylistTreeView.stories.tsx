// Stories (ADR 0219, 0349) for the Playlists panel's tree: playlists by folder with embedded ones nested and linked
// ones dashed, type badges and the output marker, the open one selected, search with paths, the row menu, F2 rename,
// and the empty state.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { PlaylistTreeView, type PlaylistTreeViewProps, type TreeActions } from "./PlaylistTreeView";
import { FIXTURE_FILES, FIXTURE_FOLDERS, loadFixture } from "./playlistFixture";
import { fileKey, playlistTree } from "./playlistTree";
import { planDrop } from "./treeDrop";
import "../../components/audioParts.css";
import "./playlists.css";

const actions = (): TreeActions => ({
  open: fn(), newPlaylist: fn(), newPlaylistInside: fn(), newSequence: fn(), newFolder: fn(), renameFile: fn(), renameFolder: fn(), duplicate: fn(), remove: fn(), removeMany: fn(), deleteFolder: fn(),
  unlink: fn(), makeShared: fn(), moveTo: fn(), planDrop: (s, t, z) => planDrop(s, t, z, loadFixture), drop: fn(), openSamples: fn(),
});

const meta = {
  title: "Studio/Playlists/Tree",
  component: PlaylistTreeView,
  args: { nodes: playlistTree(FIXTURE_FILES, FIXTURE_FOLDERS, loadFixture), folders: FIXTURE_FOLDERS, openKey: fileKey("audio/footsteps/footsteps.playlist.json"), writable: true, hasSamples: true, actions: actions() },
  decorators: [(Story) => <div style={{ width: "300px", height: "520px" }}>{Story()}</div>],
} satisfies Meta<PlaylistTreeViewProps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ByFolder: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const tree = c.getByRole("tree", { name: "Playlists" });
    await expect(within(tree).getByRole("treeitem", { name: /^Switch playlist footsteps/ })).toHaveAttribute("aria-selected", "true");
    await expect(within(tree).getAllByText("dirt").length).toBeGreaterThan(1); // the file, and its link in footsteps
    // T5: an output of its own is a "→" whose tooltip names the bus.
    await expect(within(tree).getByLabelText("Plays into SFX")).toHaveAttribute("title", expect.stringMatching(/plays into SFX/));
    await expect(within(tree).getByLabelText("Plays into SFX")).toHaveTextContent("→ SFX"); // named, not a bare arrow (J8.2)
    await userEvent.click(within(tree).getByText("engine"));
    await expect(args.actions.open).toHaveBeenCalled();
  },
};

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByRole("searchbox", { name: "Search playlists" }), "grass");
    const tree = c.getByRole("tree", { name: "Matching playlists" });
    await expect(within(tree).getByText("grass_01")).toBeVisible();
    await expect(within(tree).getAllByText(/footsteps ›/).length).toBeGreaterThan(0);
  },
};

export const MenuAndRename: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const row = c.getByRole("treeitem", { name: /playlist, one axis engine$/ });
    row.focus();
    await userEvent.keyboard("{F2}");
    const field = await waitFor(() => c.getByRole("textbox", { name: "Playlist name" }));
    await userEvent.clear(field);
    await userEvent.type(field, "motor{Enter}");
    await expect(args.actions.renameFile).toHaveBeenCalledWith("audio/vehicles/engine.playlist.json", "motor");
    within(c.getByRole("treeitem", { name: /two axes wind$/ })).getAllByText("wind")[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("menuitem", { name: /^Delete…/ }));
    await expect(args.actions.remove).toHaveBeenCalled();
  },
};

export const Empty: Story = {
  args: { nodes: [], hasSamples: false, openKey: null },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    // T15: one muted line; + makes a playlist straight away, ▾ has the rest.
    await expect(c.getByText(/No playlists or folders yet/)).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "New playlist" }));
    await expect(args.actions.newPlaylist).toHaveBeenCalled();
  },
};

export const ReadOnly: Story = { args: { writable: false } };

/** The tree over folders that grow: New folder makes one (named as the editor names it). */
function GrowingTree(props: PlaylistTreeViewProps) {
  const [folders, setFolders] = useState<readonly string[]>(FIXTURE_FOLDERS);
  const newFolder = async (parent: string) => {
    const path = parent ? `${parent}/New Folder` : "New Folder";
    setFolders((f) => [...f, path]);
    return path;
  };
  return <PlaylistTreeView {...props} nodes={playlistTree(FIXTURE_FILES, folders, loadFixture)} folders={folders} actions={{ ...props.actions, newFolder }} />;
}

/** J6.1: ▾ → New folder starts the new folder in rename mode, its name selected (as New playlist does). */
export const NewFolderRename: Story = {
  render: (args) => <GrowingTree {...args} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "More new items" }));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("menuitem", { name: /^New folder/ }));
    const field = (await c.findByRole("textbox", { name: "Folder name" })) as HTMLInputElement;
    await waitFor(() => expect(field).toHaveFocus());
    await expect([field.selectionStart, field.selectionEnd]).toEqual([0, "New Folder".length]);
  },
};
