// Stories (ADR 0219, 0349) for the kit's empty state: a screen's "nothing yet" with what it is for and how to start,
// with and without an action, and the compact form a narrow panel uses.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = { title: "Kit/EmptyState", component: EmptyState };
export default meta;
type Story = StoryObj<typeof EmptyState>;

export const WithAction: Story = {
  args: { title: "No takes yet", body: "A take records what the game asked of audio during a play session, so you can replay it against the current mix.", icon: "◉", action: { label: "Open a take file…", run: fn() } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("note", { name: "No takes yet" })).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Open a take file…" }));
    await expect(args.action!.run).toHaveBeenCalledOnce();
  },
};

export const Compact: Story = {
  args: { title: "Nothing selected", body: "Pick a bus to see its effects.", compact: true },
};

/** A side panel's empty state is one line; its explanation is an ⓘ tooltip (spec §1.3), which a press also opens. */
export const CompactOneLine: Story = {
  args: { title: "No takes yet", body: "Record one with Record session in the Studio's player bar.", compact: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const note = c.getByRole("note", { name: "No takes yet" });
    await expect(note.querySelector("p")).toBeTruthy();
    const tip = c.getByRole("button", { name: "About: No takes yet" });
    await expect(tip).toHaveAttribute("title", "Record one with Record session in the Studio's player bar.");
    await userEvent.click(tip);
    await expect(await within(document.body).findByRole("tooltip")).toHaveTextContent("Record one with Record session");
  },
};
