// Stories (ADR 0219, 0349) for the Playlist panel: one per type, over the fixture playlists, each applying its edits
// locally so the controls work: a random Queue with weights, a Switch with labels, rules and the no-tempo lint, a 1D
// Blend with its lane and envelope, a 2D Blend's plane, a Clip, and a Sequence's timeline.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import type { ParameterDef } from "../../../engine/audio/parameters";
import type { EditContext } from "./playlistEdits";
import { PlaylistEditor } from "./PlaylistEditor";
import { FIXTURE_PARAMETERS, FIXTURE_PLAYLISTS, fixtureLints, loadFixture } from "./playlistFixture";
import { breadcrumb, filePath, playlistTitle } from "./playlistPaths";
import { factsOf } from "./playlistTree";
import "../../components/audioParts.css";
import "./playlists.css";

function Harness(props: { readonly path: string; readonly values?: Record<string, number>; readonly newParameter?: EditContext["newParameter"] }) {
  const [body, setBody] = useState<PlaylistBody>(FIXTURE_PLAYLISTS[props.path]!);
  const [selected, setSelected] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, number>>(props.values ?? {});
  // Parameters "+ New parameter…" made (the screen reads them back from audio.json).
  const [made, setMade] = useState<ParameterDef[]>([]);
  const ask = props.newParameter;
  const newParameter: EditContext["newParameter"] = ask && (async (kind) => {
    const d = await ask(kind);
    if (d) setMade((m) => [...m, d]);
    return d;
  });
  return (
    <div style={{ width: "760px", height: "640px", overflow: "auto" }}>
      <PlaylistEditor
        body={body}
        crumbs={breadcrumb(filePath(props.path), loadFixture)}
        title={playlistTitle(props.path)}
        renamable
        writable
        ctx={{ parameters: [...FIXTURE_PARAMETERS, ...made], newParameter }}
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
    await userEvent.tripleClick(weight); // select the old weight and type over it
    await userEvent.keyboard("5{Enter}");
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

/** J5.1: "+ New parameter…" ends the Switch's parameter select; the new labelled parameter is followed at once. */
export const SwitchNewParameter: Story = {
  args: { path: "audio/footsteps/footsteps.playlist.json", newParameter: fn(async () => ({ name: "Surface", labels: ["Wood", "Metal", "Water"], default: "Wood" })) },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Switch parameter" }) as HTMLSelectElement;
    await expect([...select.options].at(-1)!.textContent).toBe("+ New parameter…");
    await userEvent.selectOptions(select, "+ New parameter…");
    await expect(args.newParameter).toHaveBeenCalledWith("labelled");
    await expect(c.getByRole("combobox", { name: "Switch parameter" })).toHaveDisplayValue("Surface");
    await expect(within(c.getByRole("table", { name: "Labels" })).getByText("Metal")).toBeVisible();
  },
};

/** J4.1: a Blend axis offers "+ New parameter…" (numeric) besides Voice time, and the axis follows the new one. */
export const Blend1DNewParameter: Story = {
  args: { path: "audio/vehicles/engine.playlist.json", newParameter: fn(async () => ({ name: "speed", min: 0, max: 300, default: 0, seekSpeed: 0 })) },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Blend X axis" }), "+ New parameter…");
    await expect(args.newParameter).toHaveBeenCalledWith("numeric");
    await expect(c.getByRole("combobox", { name: "Blend X axis" })).toHaveDisplayValue("speed");
  },
};

export const Blend1D: Story = { args: { path: "audio/vehicles/engine.playlist.json", values: { rpm: 4000 } } };

/** BL2: the plane names its nodes and its axes (with ranges), and its influence is a smooth (blurred) field, not cells. */
export const Blend2D: Story = {
  args: { path: "audio/ambience/wind.playlist.json" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const plane = c.getByRole("group", { name: "Blend plane" });
    const texts = [...plane.querySelectorAll("text")].map((t) => t.textContent ?? "");
    for (const name of ["wind_soft", "wind_gust", "wind_storm", "wind_howl"]) await expect(texts.some((t) => t.startsWith(name))).toBe(true);
    // The axes are named beside the plane (X under it, Y up its side), with their ranges.
    await expect(canvasElement.querySelector(".pl-xname")!.textContent).toBe("wind");
    await expect(canvasElement.querySelector(".pl-ym")!.textContent).toBe("rain");
    await expect(plane.querySelector(".pl-influence-field")!.getAttribute("filter")).toMatch(/^url\(#/);
    // The Nodes list beside it: each node Playing or Silent with its weight.
    const nodes = c.getByRole("group", { name: "Nodes" });
    await expect(within(nodes).getAllByRole("button")).toHaveLength(4);
    await expect(nodes.textContent).toMatch(/Playing|Silent/);
  },
};

/** ADR 0350: a 1D entry's region: select it, nudge its start handle (making the region custom), shape a fade, reset. */
export const Blend1DRegion: Story = {
  args: { path: "audio/vehicles/engine.playlist.json", values: { rpm: 4000 } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getAllByText("engine_mid")[0]!); // its entry (the blend view names it too)
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
    await userEvent.click(c.getAllByText("wind_gust").find((el) => !el.closest("svg"))!); // its entry (the plane names it too)
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
    // A rule's fades sit in a popover off its row.
    await userEvent.click(c.getByRole("button", { name: "Rule 1: fades and transition" }));
    const pop = within(await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Rule 1: fades" }));
    await userEvent.selectOptions(pop.getByRole("combobox", { name: "Rule 1: fade-out shape" }), "log2");
    await expect(pop.getByRole("combobox", { name: "Rule 1: fade-out shape" })).toHaveValue("log2");
    const tail = pop.getByRole("checkbox", { name: "Let the tail ring" });
    await expect(tail).toBeChecked();
    await userEvent.click(tail);
    await expect(pop.getByRole("checkbox", { name: "Let the tail ring" })).not.toBeChecked();
  },
};

export const ClipPlaylist: Story = {
  args: { path: "audio/ui/boom.playlist.json" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("heading", { name: "boom" })).toBeVisible();
    await expect(c.getByTitle(/audio\/ui\/boom\.wav/)).toBeVisible();
    await expect(c.getByRole("button", { name: "Replace sample…" })).toBeVisible();
    // C1: the clip lanes: the Trim bar and the waveform with both edges draggable.
    await expect(c.getByText(/^Trim · /)).toBeVisible();
    await expect(c.getAllByRole("slider", { name: "Trim start" }).length).toBeGreaterThan(0);
  },
};

export const Sequence: Story = {
  args: { path: "music/theme.playlist.json" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("toolbar", { name: "Sequence tools" })).toBeVisible();
  },
};
