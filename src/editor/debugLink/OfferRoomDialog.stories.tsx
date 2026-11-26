// Stories (ADR 0219, 0404) for the Offer a room dialog: one per state of the offer, the copy button, and Stop, Escape and
// a joined build closing it.
import { signal } from "@preact/signals";
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { OfferedRoom } from "./editorLink";
import { OfferRoomDialog } from "./OfferRoomDialog";

type State = OfferedRoom["state"]["value"];

interface Args {
  state: State;
  code: string | null;
  notice: string | null;
  stop: () => void;
}

function Demo({ state, code, notice, stop }: Args) {
  const [open, setOpen] = useState(true);
  const [room] = useState<OfferedRoom>(() => ({ code: signal(code), state: signal(state), notice, stop }));
  return (
    <div>
      <output aria-label="State">{open ? "open" : "closed"}</output>
      {open && <OfferRoomDialog offer={() => room} onClose={() => setOpen(false)} />}
    </div>
  );
}

const meta: Meta<Args> = {
  title: "Editor/Debug link/Offer a room dialog",
  render: (args: Args) => <Demo {...args} />,
  args: { state: { kind: "waiting", code: "3f9qk-7kd2x" }, code: "3f9qk-7kd2x", notice: null, stop: fn() },
};
export default meta;
type Story = StoryObj<Args>;

export const Opening: Story = {
  args: { state: { kind: "opening" }, code: null },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(await c.findByRole("status")).toHaveTextContent("Opening a room…");
    expect(c.getByRole("button", { name: "Copy" })).toBeDisabled();
  },
};

export const Waiting: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const dialog = await c.findByRole("dialog", { name: "Offer a room" });
    expect(within(dialog).getByLabelText("Room code")).toHaveTextContent("3F9QK-7KD2X");
    expect(dialog).toHaveTextContent("Open the game with ?debug-code=3F9QK-7KD2X in its address, or launch it with --debug-code 3F9QK-7KD2X.");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Waiting for a build to join.");
    expect(within(dialog).getByRole("button", { name: "Stop" })).toHaveFocus();
  },
};

export const WithANotice: Story = {
  args: { notice: "This page was opened from localhost, so only builds on this machine can join." },
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByText(/only builds on this machine/)).toBeTruthy();
  },
};

export const Joined: Story = {
  args: { state: { kind: "joined" }, code: null },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(await c.findByRole("status")).toHaveTextContent("A build joined");
    await c.findByText("closed", undefined, { timeout: 4000 }); // closes by itself, without cutting the pairing off
    expect(args.stop).not.toHaveBeenCalled();
  },
};

export const Retrying: Story = {
  args: { state: { kind: "retrying", why: "connection refused" }, code: null },
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByRole("status")).toHaveTextContent("connection refused");
  },
};

export const Unavailable: Story = {
  args: { state: { kind: "unavailable", why: "No rendezvous is set. Add one in Settings." }, code: null },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(await c.findByRole("status")).toHaveTextContent("No rendezvous is set. Add one in Settings.");
    expect(c.getByRole("button", { name: "Copy" })).toBeDisabled();
  },
};

export const CopyCopiesTheCode: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const writeText = fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(await c.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("3F9QK-7KD2X");
    expect(await c.findByRole("button", { name: "Copied" })).toBeTruthy();
  },
};

export const StopStopsAndCloses: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: "Stop" }));
    expect(args.stop).toHaveBeenCalled();
    expect(c.getByLabelText("State").textContent).toBe("closed");
  },
};

export const EscapeStopsAndCloses: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await c.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(args.stop).toHaveBeenCalled();
    expect(c.getByLabelText("State").textContent).toBe("closed");
  },
};
