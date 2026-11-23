// Stories (ADR 0219, 0349) for the Playlist panel: one per type, over the fixture playlists, each applying its edits
// locally so the controls work: a random Queue with weights, a Switch with labels, rules and the no-tempo lint, a 1D
// Blend with its lane and envelope, a 2D Blend's plane, a Clip, and a Sequence's timeline.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { PlaylistEditor } from "./PlaylistEditor";
import { FIXTURE_PARAMETERS, FIXTURE_PLAYLISTS, fixtureLints, loadFixture } from "./playlistFixture";
import { breadcrumb, filePath, playlistTitle } from "./playlistPaths";
import { factsOf } from "./playlistTree";
import "../../components/audioParts.css";
import "./playlists.css";

function Harness(props: { readonly path: string; readonly values?: Record<string, number> }) {
  const [body, setBody] = useState<PlaylistBody>(FIXTURE_PLAYLISTS[props.path]!);
  const [selected, setSelected] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, number>>(props.values ?? {});
  return (
    <div style={{ width: "760px", height: "640px", overflow: "auto" }}>
      <PlaylistEditor
        body={body}
        crumbs={breadcrumb(filePath(props.path), loadFixture)}
        title={playlistTitle(props.path)}
        renamable
        writable
        ctx={{ parameters: FIXTURE_PARAMETERS }}
        lints={fixtureLints(props.path)}
        where=""
        selected={selected}
        values={values}
        playlists={Object.keys(FIXTURE_PLAYLISTS)}
        facts={(e) => (e.kind === "linked" && loadFixture(e.playlist) ? factsOf(loadFixture(e.playlist)!) : null)}
        onEdit={(_label, edit) => {
          const r = edit(body);
          if ("next" in r) setBody(r.next);
        }}
        onSelect={setSelected}
        onOpen={fn()}
        onRemove={fn()}
        onMakeShared={fn()}
        onUnlink={fn()}
        onEditCurves={fn()}
        onCrumb={fn()}
        onRename={fn()}
        onAdd={fn()}
        onDropSample={fn()}
        onTestValue={(name, v) => setValues({ ...values, [name]: v })}
        onOpenSamples={fn()}
      />
    </div>
  );
}

const meta = { title: "Studio/Playlists/Playlist", component: Harness, args: { path: "audio/footsteps/dirt.playlist.json" } } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Queue: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("heading", { name: "dirt" })).toBeVisible();
    const weight = c.getByRole("textbox", { name: "Weight of dirt_03" });
    await userEvent.clear(weight);
    await userEvent.type(weight, "5{Enter}");
    await expect(c.getByRole("textbox", { name: "Weight of dirt_03" })).toHaveValue("5");
  },
};

export const Switch: Story = {
  args: { path: "audio/footsteps/footsteps.playlist.json" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("table", { name: "Labels" })).toBeVisible();
    await expect(c.getAllByText(/beat or bar|tempo/i).length).toBeGreaterThan(0);
    await userEvent.click(c.getByRole("button", { name: "Add rule" }));
    await expect(c.getByRole("combobox", { name: "Rule 2: from" })).toBeVisible();
  },
};

export const Blend1D: Story = { args: { path: "audio/vehicles/engine.playlist.json", values: { rpm: 4000 } } };

export const Blend2D: Story = { args: { path: "audio/ambience/wind.playlist.json" } };

/** ADR 0350: a 1D entry's region: select it, nudge its start handle (making the region custom), shape a fade, reset. */
export const Blend1DRegion: Story = {
  args: { path: "audio/vehicles/engine.playlist.json", values: { rpm: 4000 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText("engine_mid"));
    await expect(c.getByText("Automatic (from its neighbours)")).toBeVisible();
    const start = c.getByRole("slider", { name: "engine_mid region start" });
    start.focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expect(c.getByText("Custom")).toBeVisible();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "engine_mid fade-in shape" }), "sCurve");
    await expect(c.getByRole("combobox", { name: "engine_mid fade-in shape" })).toHaveValue("sCurve");
    await userEvent.click(c.getByRole("button", { name: "Reset to automatic" }));
    await expect(c.getByText("Automatic (from its neighbours)")).toBeVisible();
  },
};

/** ADR 0350: a 2D entry's weight curve preset (the plane tints each entry's influence). */
export const Blend2DWeightCurve: Story = {
  args: { path: "audio/ambience/wind.playlist.json" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText("wind_gust"));
    await userEvent.selectOptions(c.getByRole("combobox", { name: "wind_gust weight curve" }), "narrow40");
    await expect(c.getByRole("combobox", { name: "wind_gust weight curve" })).toHaveValue("narrow40");
    await expect(c.getByRole("button", { name: "Reset" })).toBeEnabled();
  },
};

/** ADR 0350: a Switch rule's fade shapes and its tail toggle. */
export const SwitchFades: Story = {
  args: { path: "audio/footsteps/footsteps.playlist.json" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Rule 1: fade-out shape" }), "log2");
    await expect(c.getByRole("combobox", { name: "Rule 1: fade-out shape" })).toHaveValue("log2");
    const tail = c.getByRole("checkbox", { name: "Rule 1: let the tail ring" });
    await expect(tail).toBeChecked();
    await userEvent.click(tail);
    await expect(c.getByRole("checkbox", { name: "Rule 1: let the tail ring" })).not.toBeChecked();
  },
};

export const ClipPlaylist: Story = {
  args: { path: "audio/ui/boom.playlist.json" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("boom")).toBeVisible();
    await expect(c.getByRole("button", { name: "Replace sample…" })).toBeVisible();
  },
};

export const Sequence: Story = {
  args: { path: "music/theme.playlist.json" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("toolbar", { name: "Sequence tools" })).toBeVisible();
  },
};
