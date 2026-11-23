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
        busPath={(b) => (b === "Vehicles" ? "SFX › Vehicles" : b)}
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
    await expect(canvasElement.querySelector(".pl-pbh .pl-u")!.textContent).toMatch(/\S/);
    await expect(c.getByRole("combobox", { name: "Output bus" })).not.toBeVisible();
    await userEvent.click(c.getByText("Playback"));
    await expect(c.getByRole("combobox", { name: "Output bus" })).toHaveValue("");
    // J8.2: the buses by their routing paths, in tree order (Master, then each branch).
    const output = c.getByRole("combobox", { name: "Output bus" }) as HTMLSelectElement;
    await expect([...output.options].map((o) => o.textContent)).toEqual(["Inherit · SFX › Vehicles", "Master", "Music", "SFX", "SFX › Vehicles"]);
    // V9: Priority and When full line up with the slider rows (Cooldown).
    const left = (name: string) => c.getByText(name, { selector: ".kit-field-label, .studio-field-label" }).getBoundingClientRect().left;
    await expect(left("Priority")).toBe(left("Cooldown"));
    await expect(left("When full")).toBe(left("Cooldown"));
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

/** J3.2: in a multi-pick a click toggles a row, as its checkbox shows (three clicks: three picked; again: two). */
const addMany = fn();
export const AddClicksToggle: Story = {
  render: () => <AddDialog items={addItems(FIXTURE_FILES, "audio/footsteps/dirt.playlist.json", "queue", loadFixture)} title="Add to dirt" single={false} onAdd={addMany} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Add to dirt" }));
    const rows = dialog.getAllByRole("option").filter((o) => o.getAttribute("aria-disabled") !== "true").slice(0, 3);
    for (const r of rows) await userEvent.click(r);
    await expect(dialog.getByText("3 picked")).toBeVisible();
    for (const r of rows) await expect(r.querySelector("input[type=checkbox]")).toBeChecked();
    await userEvent.click(rows[1]!);
    await expect(dialog.getByText("2 picked")).toBeVisible();
    await expect(rows[1]!.querySelector("input[type=checkbox]")).not.toBeChecked();
  },
};

/** A single pick (a Clip's sample) shows no checkboxes: a click picks that one. */
export const ChooseSample: Story = {
  render: () => <AddDialog items={addItems(FIXTURE_FILES, "audio/ui/boom.playlist.json", "clip", loadFixture)} title="Replace sample…" single onAdd={fn()} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Replace sample…" }));
    await expect(canvasElement.ownerDocument.body.querySelectorAll(".pl-add input[type=checkbox]")).toHaveLength(0);
    const rows = dialog.getAllByRole("option").filter((o) => o.getAttribute("aria-disabled") !== "true");
    await userEvent.click(rows[0]!);
    await userEvent.click(rows[1]!);
    await expect(dialog.getByText("1 picked")).toBeVisible();
  },
};

export const Library: Story = {
  render: () => (
    <div style={{ width: "280px", height: "420px" }}>
      <LibraryList files={FIXTURE_FILES} addTo="dirt" previewing="audio/footsteps/dirt_02.wav" onPreview={fn()} onAdd={fn()} onOpenSamples={fn()} onCreatePlaylist={fn()} writable />
    </div>
  ),
};

/** J6.2: a search result is named by its name; its folder sits on the meta line, not before the name. */
export const LibrarySearch: Story = {
  render: () => (
    <div style={{ width: "280px", height: "420px" }}>
      <LibraryList files={FIXTURE_FILES} addTo="dirt" previewing={null} onPreview={fn()} onAdd={fn()} onOpenSamples={fn()} onCreatePlaylist={fn()} writable />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByRole("searchbox", { name: "Search samples" }), "dirt_0");
    const names = [...canvasElement.querySelectorAll(".pl-lib-name")].map((n) => n.textContent);
    await expect(names).toEqual(["dirt_01", "dirt_02", "dirt_03"]);
    await expect(canvasElement.querySelector(".pl-lib-meta")!.textContent).toMatch(/^audio\/footsteps/);
  },
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
