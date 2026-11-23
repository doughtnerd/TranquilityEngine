// Stories (ADR 0219, 0341) for a Studio screen's dock: the engine's dock layout over the screen's own layout store,
// the fixed panel in the middle (no ×), side panels with their empty states, and the panel menu's "Add <panel>",
// Close and Reset layout.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ScreenDock } from "./ScreenDock";
import { dockOf } from "./screenDocks";
import "../studio.css";

const meta: Meta = {
  title: "Studio/ScreenDock",
  component: ScreenDock,
  decorators: [
    (Story) => (
      <div class="studio" style={{ height: "520px", gridTemplateRows: "1fr", gridTemplateAreas: '"main"' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

export const Mixer: StoryObj = {
  render: () => <ScreenDock screen="mixer" />,
  play: async ({ canvasElement }) => {
    dockOf("mixer").store.reset();
    const c = within(canvasElement);
    await expect(await c.findByRole("note", { name: "Mixer" })).toBeVisible();
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByText("Snapshots") });
    const menu = await c.findByRole("menu", { name: "Panel menu" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Close Snapshots" }));
    await waitFor(() => expect(c.queryByText("Snapshots")).toBeNull());
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByText("Inspector") });
    await userEvent.click(within(await c.findByRole("menu", { name: "Panel menu" })).getByRole("menuitem", { name: "Reset layout" }));
    await expect(await c.findByText("Snapshots")).toBeVisible();
  },
};

export const Profiler: StoryObj = { render: () => <ScreenDock screen="profiler" /> };
