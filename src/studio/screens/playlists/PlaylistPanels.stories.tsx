// Stories (ADR 0219, 0349) for the Playlists screen's other panels and dialogs: the Inspector (an entry, playback,
// output, effects, spatial, local parameters, used by), the Add dialog (filters with counts, cycles disabled), the
// Library, Plays now (the next trigger's preview, then live cards with paths), Voices (newest first, status chips), and
// the delete confirmation with its choices.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { signal } from "@preact/signals";
import type { AssetDocument } from "../../../editor/assetDocuments";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { AddDialog } from "./AddDialog";
import { PlaylistHistoryScope } from "./PlaylistHistoryScope";
import { addItems } from "./addDialogModel";
import { LibraryList } from "./LibraryList";
import { DeleteDialog } from "./PlaylistDialogs";
import { PlaylistInspector } from "./PlaylistInspector";
import { FIXTURE_FILES, FIXTURE_PARAMETERS, FIXTURE_PLAYLISTS, loadFixture } from "./playlistFixture";
import { PlaysNowView, VoicesLogView } from "./VoicesView";
import "../../components/audioParts.css";
import "./playlists.css";

const meta = { title: "Studio/Playlists/Panels" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Inspector: Story = {
  render: () => (
    <div style={{ width: "340px", height: "720px", overflow: "auto" }}>
      <PlaylistInspector
        body={FIXTURE_PLAYLISTS["audio/vehicles/engine.playlist.json"]!}
        selected={1}
        writable
        ctx={{ parameters: FIXTURE_PARAMETERS }}
        buses={["Master", "SFX", "Vehicles", "Music"]}
        output={{ bus: "Vehicles", own: false, from: "car" }}
        presets={["audio/attenuation/near.attenuation.json"]}
        usedBy={["audio/vehicles/car.playlist.json"]}
        name="engine"
        cards={[{ badge: "S", label: "rpm", value: "0.4", rows: [{ name: "engine_idle", weight: 0.2 }, { name: "engine_mid", weight: 0.8 }] }, { badge: "T", label: "Voice time", value: "—", sub: "Trigger to run it" }]}
        onEdit={fn()}
        onEditCurves={fn()}
        onOpenBus={fn()}
        onOpenPlaylist={fn()}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // The header names it once with its type summary (I1); the "this voice" cards show the blend's weights (I2).
    await expect(c.getByText("engine", { selector: ".pl-ph b" })).toBeVisible();
    await expect(c.getByText("engine_mid", { selector: ".pl-wr .pl-nm" })).toBeVisible();
    await expect(c.getByRole("group", { name: "Entry engine_mid" })).toBeVisible();
    // Playback is collapsed to its summary (I5); opening it shows Output inside it.
    await expect(c.getByText("Every trigger plays")).toBeVisible();
    await userEvent.click(c.getByText("Playback"));
    await expect(c.getByRole("combobox", { name: "Output bus" })).toHaveValue("");
    // The effects chain keeps the 8px gutter every field row has (I6): its caption doesn't touch the panel's edge.
    const chain = c.getByRole("region", { name: "Playlist effects" });
    const panel = canvasElement.querySelector(".pl-inspector")!;
    const caption = within(chain).getByText(/Playlist effects/i, { selector: ".studio-chain-title" });
    await expect(caption.getBoundingClientRect().left - panel.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);
  },
};

const add = fn();
export const Add: Story = {
  render: () => <AddDialog items={addItems(FIXTURE_FILES, "audio/footsteps/dirt.playlist.json", "queue", loadFixture)} title="Add to dirt" single={false} onAdd={add} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Add to dirt" });
    await expect(within(dialog).getByText("footsteps already contains dirt")).toBeVisible();
    // The search field is one 24px line, not stretched down the dialog's column (A1).
    await expect(within(dialog).getByRole("searchbox", { name: "Search" }).getBoundingClientRect().height).toBeLessThanOrEqual(26);
    await userEvent.click(within(dialog).getByText("engine_idle"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await expect(add).toHaveBeenCalledWith(["audio/vehicles/engine_idle.wav"], "link");
  },
};

export const ChooseSample: Story = {
  render: () => <AddDialog items={addItems(FIXTURE_FILES, "audio/ui/boom.playlist.json", "clip", loadFixture)} title="Replace sample…" single onAdd={fn()} onClose={fn()} />,
};

export const Library: Story = {
  render: () => (
    <div style={{ width: "280px", height: "420px" }}>
      <LibraryList files={FIXTURE_FILES} addTo="dirt" previewing="audio/footsteps/dirt_02.wav" onPreview={fn()} onAdd={fn()} onOpenSamples={fn()} onCreatePlaylist={fn()} writable />
    </div>
  ),
};

const t0 = 10;
export const PlaysNow: Story = {
  render: () => (
    <div style={{ width: "320px", height: "260px" }}>
      <PlaysNowView
        now={[]}
        preview={[{ name: "Random pick · 1 of 5", kind: "queue", weight: 1, gainDb: -1, path: ["Bike impact", "Metal impact"] }, { name: "metal_thud", kind: "sample", weight: 0.53, gainDb: -5, path: ["Bike impact", "Metal impact", "metal_thud"] }]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText(/next trigger · current parameters/)).toBeVisible();
    await expect(c.getByText("Bike impact › Metal impact › metal_thud")).toBeVisible();
  },
};

export const Voices: Story = {
  render: () => (
    <div style={{ width: "320px", height: "360px" }}>
      <VoicesLogView
        log={[
          { key: "v1:6", kind: "voice", instance: 6, clip: "audio/vehicles/engine_idle.wav", bus: "Vehicles", start: t0, end: t0 + 1.2, status: "finished", gainDb: -6 },
          { key: "r11.1", kind: "refused", instance: 0, clip: "cooldown", bus: "", start: t0 + 1.1, end: t0 + 1.1, status: "refused", gainDb: -120 },
          { key: "v3:7", kind: "voice", instance: 7, clip: "audio/vehicles/engine_mid.wav", bus: "Vehicles", start: t0 + 1.4, end: null, status: "playing", gainDb: -3.1 },
        ]}
        cursor={t0 + 1.5}
        time={t0 + 3}
        lengthOf={() => 4}
        pathOf={(clip) => ["engine", clip.slice(clip.lastIndexOf("/") + 1, -4)]}
        onClear={fn()}
        onSeek={fn()}
        onRule={fn()}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // Newest first (P3): the playing voice heads the list; status chips carry an icon and a word, not colour only.
    const items = c.getAllByRole("listitem");
    await expect(items[0]).toHaveTextContent(/Playing.*engine_mid/);
    await expect(items[items.length - 1]).toHaveTextContent(/Ended.*engine_idle/);
    await expect(c.getByText("2.40 s left")).toBeVisible();
    await expect(c.getByRole("button", { name: "Rule ›" })).toBeVisible();
  },
};

/** H3: a click anywhere in a Playlists panel (here a tree row) makes Undo, Redo and History act on the open playlist. */
const openDoc = {
  path: "audio/footsteps/dirt.playlist.json",
  readOnly: false,
  value: signal({}),
  problems: signal([]),
  canUndo: signal(true),
  canRedo: signal(false),
  undoLabel: signal<string | null>("Add entry"),
  redoLabel: signal<string | null>(null),
  edit: fn(),
  undo: fn(),
  redo: fn(),
  flush: async () => {},
  history: { version: signal(0), states: [], current: 0, saved: -1, jumpTo: fn(), back: fn(), forward: fn() },
} as unknown as AssetDocument<unknown>;
export const HistoryFollowsOpenPlaylist: Story = {
  render: () => (
    <div>
      <HistoryPopover none="Click into a document to undo its edits" />
      <PlaylistHistoryScope doc={openDoc}>
        <button type="button">dirt (a tree row)</button>
      </PlaylistHistoryScope>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "dirt (a tree row)" }));
    await expect(c.getByRole("button", { name: "Undo" })).toBeEnabled();
    await expect(c.getByRole("button", { name: "Undo" }).title).toMatch(/^Undo Add entry/);
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await expect(openDoc.undo).toHaveBeenCalled();
  },
};

export const DeleteWithChoices: Story = {
  render: () => (
    <DeleteDialog plan={{ target: { kind: "file", path: "audio/footsteps/dirt.playlist.json" }, name: "dirt", children: 3, embedded: 3, linkedBy: ["audio/footsteps/footsteps.playlist.json"] }} onConfirm={fn()} onCancel={fn()} />
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("alertdialog", { name: "Delete dirt?" });
    await expect(within(dialog).getByText("Delete all 3 inside")).toBeVisible();
    await expect(within(dialog).getByText(/Unlink the copies/)).toBeVisible();
  },
};
