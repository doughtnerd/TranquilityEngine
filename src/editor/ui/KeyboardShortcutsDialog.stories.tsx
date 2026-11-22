// Stories (ADR 0219, 0335) for the keyboard shortcuts dialog: groups, keys written the platform's way, the search,
// and the single-key shortcuts switch marking those shortcuts off.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { KeyboardShortcutsDialog, type ShortcutGroup } from "./KeyboardShortcutsDialog";

function Demo(props: { mac?: boolean }) {
  const [single, setSingle] = useState(true);
  const [open, setOpen] = useState(true);
  const groups: ShortcutGroup[] = [
    { title: "Everywhere", entries: [{ label: "Samples", keys: ["Mod+1"] }, { label: "Mixer", keys: ["Mod+3"] }, { label: "Undo", keys: ["Mod+Z"] }, { label: "Redo", keys: ["Mod+Shift+Z", "Ctrl+Y"] }, { label: "Next panel", keys: ["F6"] }, { label: "Keyboard shortcuts", keys: ["?"] }] },
    { title: "Samples", entries: [{ label: "Play from the playhead", keys: ["Space"], off: !single }, { label: "Add a marker", keys: ["M"], off: !single }] },
  ];
  return open ? <KeyboardShortcutsDialog groups={groups} mac={props.mac} singleKeys={{ on: single, set: setSingle }} onClose={() => setOpen(false)} /> : <p>Closed</p>;
}

const meta: Meta = { title: "Kit/KeyboardShortcutsDialog", component: KeyboardShortcutsDialog };
export default meta;

export const Search: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByRole("searchbox", { name: "Search shortcuts" }), "redo");
    await expect(c.getByText("Ctrl+Shift+Z")).toBeVisible();
    await expect(c.queryByText("Mixer")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect(c.getByText("Closed")).toBeVisible();
  },
};

export const MacKeys: StoryObj = { render: () => <Demo mac /> };
