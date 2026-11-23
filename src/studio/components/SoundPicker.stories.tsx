// Stories (ADR 0219, 0349) for the sound picker: playlists and samples with badges, searching, picking with the keys,
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

function Demo(props: { list?: () => readonly SoundItem[] | Promise<readonly SoundItem[]>; only?: "sample"; focusableParent?: boolean }) {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <div style={{ height: "460px" }} tabIndex={props.focusableParent ? -1 : undefined}>
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
    const c = within(canvasElement.ownerDocument.body); // the picker floats at the page's root
    const search = await c.findByRole("searchbox", { name: "Search sounds" });
    await userEvent.type(search, "dirt");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect(c.getByTestId("picked")).toHaveTextContent("audio/sfx/footsteps/dirt_01.wav");
  },
};

export const SamplesOnly: StoryObj = { render: () => <Demo only="sample" /> };

export const Loading: StoryObj = { render: () => <Demo list={() => new Promise(() => {})} /> };

export const EmptyProject: StoryObj = { render: () => <Demo list={() => []} /> };

/**
 * J9.1: a mouse click picks, also inside a focusable panel (the Spatial Inspector's document wrapper has tabIndex -1, so a
 * press on an option moved focus there and the popover closed on that focus move before the click landed).
 */
export const ClickToPick: StoryObj = {
  render: () => <Demo focusableParent />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body); // the picker floats at the page's root
    await c.findByRole("searchbox", { name: "Search sounds" });
    await userEvent.click(await c.findByRole("option", { name: /engine_loop/ }));
    await expect(c.getByTestId("picked")).toHaveTextContent("audio/vehicles/engine_loop.ogg");
    await expect(c.queryByRole("dialog", { name: "Add to Footsteps" })).toBeNull();
  },
};

/** The Spatial Inspector's Sound field: the opener sits in a field row (a `<label>`). */
function InFieldRow() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <div style={{ height: "460px" }}>
      <label class="kit-field">
        <span class="kit-field-label">Sound</span>
        <span class="kit-field-control">
          <button ref={setAnchor} type="button" onClick={() => setOpen(true)}>
            {picked ?? "Pick a sound…"}
          </button>
          {open && anchor && <SoundPicker at={anchor} title="Pick a sound" list={() => SOUNDS} onPick={setPicked} onClose={() => setOpen(false)} />}
        </span>
      </label>
    </div>
  );
}

/**
 * Journeys walk 2, J9.1: a pick closes the picker, also when its opener is in a field row (a click in the picker used to
 * reach the `<label>`, whose activation pressed the opener and opened the picker again), and focus goes back to the opener.
 */
export const PickInAFieldRow: StoryObj = {
  render: () => <InFieldRow />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const opener = within(canvasElement).getByRole("button", { name: "Sound" }); // named by its field row
    await userEvent.click(opener);
    await userEvent.click(await page.findByRole("option", { name: /engine_loop/ }));
    await expect(page.queryByRole("dialog", { name: "Pick a sound" })).toBeNull();
    await expect(opener).toHaveTextContent("audio/vehicles/engine_loop.ogg");
    await expect(opener).toHaveFocus();
  },
};
