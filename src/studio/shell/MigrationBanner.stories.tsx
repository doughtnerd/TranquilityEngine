// Stories (ADR 0219) for the Playlists screen's migration banner (ADR 0329): a read-only project with old audio events,
// the migration running, and a failed try. The play presses Migrate now and checks the action ran.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { MigrationBanner } from "./MigrationBanner";
import type { PendingAudioMigration } from "./audioMigration";

const pending = (over: Partial<PendingAudioMigration> = {}): PendingAudioMigration => ({
  files: ["audio/music.audioevent.json", "audio/step.audioevent.json"],
  migrate: fn(async () => {}),
  running: false,
  error: null,
  ...over,
});

const meta = {
  title: "Studio/Shell/Migration banner",
  component: MigrationBanner,
  args: { pending: pending() },
} satisfies Meta<typeof MigrationBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("old audio event format (2 files)");
    await userEvent.click(canvas.getByRole("button", { name: "Migrate now" }));
    await expect(args.pending.migrate).toHaveBeenCalledTimes(1);
  },
};

export const Running: Story = {
  args: { pending: pending({ running: true }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Migrating…" })).toBeDisabled();
  },
};

export const Failed: Story = {
  args: { pending: pending({ error: "disk full" }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent("Couldn't migrate: disk full");
  },
};
