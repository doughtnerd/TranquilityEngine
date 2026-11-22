// Stories (ADR 0219, 0335) for the sound picker: playlists and samples with badges, searching, picking with the keys,
// samples only (a Clip playlist), a sound that can't be picked here, a slow list, and an empty project.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { SoundPicker } from "./SoundPicker";
import type { SoundItem } from "./soundPickerModel";

const SOUNDS: SoundItem[] = [
  { path: "audio/sfx/footsteps/dirt.playlist.json", kind: "playlist", badge: "QUE" },
  { path: "audio/sfx/footsteps/surface.playlist.json", kind: "playlist", badge: "SW" },
  { path: "audio/vehicles/engine.playlist.json", kind: "playlist", badge: "1D" },
  { path: "audio/vehicles/wind.playlist.json", kind: "playlist", badge: "2D" },
  { path: "audio/vehicles/boost.playlist.json", kind: "playlist", badge: "LAY", disabled: "it would contain itself" },
  { path: "audio/music/explore.playlist.json", kind: "playlist", badge: "SEQ" },
  { path: "audio/ui/click.playlist.json", kind: "playlist", badge: "CLP" },
  { path: "audio/sfx/footsteps/dirt_01.wav", kind: "sample", badge: "SMP" },
  { path: "audio/sfx/footsteps/dirt_02.wav", kind: "sample", badge: "SMP" },
  { path: "audio/vehicles/engine_loop.ogg", kind: "sample", badge: "SMP" },
];

function Demo(props: { list?: () => readonly SoundItem[] | Promise<readonly SoundItem[]>; only?: "sample" }) {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <div style={{ height: "460px" }}>
      <button ref={setAnchor} onClick={() => setOpen(!open)}>
        Add…
      </button>
      <p data-testid="picked">{picked ?? "nothing"}</p>
      {open && anchor && <SoundPicker at={anchor} title="Add to Footsteps" list={props.list ?? (() => SOUNDS)} only={props.only} onPick={setPicked} onClose={() => setOpen(false)} />}
    </div>
  );
}

const meta: Meta = { title: "Studio/SoundPicker", component: SoundPicker };
export default meta;

export const Everything: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const search = await c.findByRole("searchbox", { name: "Search sounds" });
    await userEvent.type(search, "dirt");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect(c.getByTestId("picked")).toHaveTextContent("audio/sfx/footsteps/dirt_01.wav");
  },
};

export const SamplesOnly: StoryObj = { render: () => <Demo only="sample" /> };

export const Loading: StoryObj = { render: () => <Demo list={() => new Promise(() => {})} /> };

export const EmptyProject: StoryObj = { render: () => <Demo list={() => []} /> };
