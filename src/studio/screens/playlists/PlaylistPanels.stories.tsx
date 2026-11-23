// Stories (ADR 0219, 0349) for the Playlists screen's other panels and dialogs: the Inspector (an entry, playback,
// output, effects, spatial, local parameters, used by), the Add dialog (filters with counts, cycles disabled), the
// Library, Plays now / Voices with a log, and the delete confirmation with its choices.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AddDialog } from "./AddDialog";
import { addItems } from "./addDialogModel";
import { LibraryList } from "./LibraryList";
import { DeleteDialog } from "./PlaylistDialogs";
import { PlaylistInspector } from "./PlaylistInspector";
import { FIXTURE_FILES, FIXTURE_PARAMETERS, FIXTURE_PLAYLISTS, loadFixture } from "./playlistFixture";
import { VoicesView } from "./VoicesView";
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
        onEdit={fn()}
        onEditCurves={fn()}
        onOpenBus={fn()}
        onOpenPlaylist={fn()}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText(/Entry · engine_mid/)).toBeVisible();
    await expect(c.getByRole("combobox", { name: "Output bus" })).toHaveValue("");
  },
};

const add = fn();
export const Add: Story = {
  render: () => <AddDialog items={addItems(FIXTURE_FILES, "audio/footsteps/dirt.playlist.json", "queue", loadFixture)} title="Add to dirt" single={false} onAdd={add} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Add to dirt" });
    await expect(within(dialog).getByText("footsteps already contains dirt")).toBeVisible();
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
export const Voices: Story = {
  render: () => (
    <div style={{ width: "760px", height: "260px" }}>
      <VoicesView
        now={[{ id: 3, instance: 7, clip: "audio/vehicles/engine_mid.wav", bus: "Vehicles", status: "playing", gain: 0.7, gainDb: -3.1 }, { id: 4, instance: 7, clip: "audio/vehicles/engine_high.wav", bus: "Vehicles", status: "playing", gain: 0.3, gainDb: -10.5 }]}
        log={[
          { key: "v1:6", kind: "voice", instance: 6, clip: "audio/vehicles/engine_idle.wav", bus: "Vehicles", start: t0, end: t0 + 1.2, status: "finished", gainDb: -6 },
          { key: "r11.1", kind: "refused", instance: 0, clip: "cooldown", bus: "", start: t0 + 1.1, end: t0 + 1.1, status: "refused", gainDb: -120 },
          { key: "v3:7", kind: "voice", instance: 7, clip: "audio/vehicles/engine_mid.wav", bus: "Vehicles", start: t0 + 1.4, end: null, status: "playing", gainDb: -3.1 },
          { key: "v4:7", kind: "voice", instance: 7, clip: "audio/vehicles/engine_high.wav", bus: "Vehicles", start: t0 + 1.4, end: null, status: "playing", gainDb: -10.5 },
        ]}
        cursor={t0 + 1.5}
        time={t0 + 3}
        onClear={fn()}
        onSeek={fn()}
      />
    </div>
  ),
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
