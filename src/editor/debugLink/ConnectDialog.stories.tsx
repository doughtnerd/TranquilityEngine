// Stories (ADR 0219, 0380) for the Connect dialog: empty, typing, connecting, each failure kind, the discovered list, and
// Enter, Escape and a successful connect closing it.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import { ConnectDialog, type DiscoveredBuild } from "./ConnectDialog";
import type { ConnectFailure, ConnectTarget } from "./connectFlow";

const refusal = (failure: ConnectFailure) => () => Promise.reject(new Error(failure.message, { cause: failure }));
const FAILURES: Record<string, ConnectFailure> = {
  "bad-code": { kind: "bad-code", message: "That isn't a pairing code: a pairing code has 10 characters, not 4." },
  refused: { kind: "refused", message: "That code doesn't match the one shown. Check it and try again." },
  unreachable: { kind: "unreachable", message: "Nothing answered at 2 addresses. Check that the build is running with debugging on, on the same network." },
  "needs-rendezvous": { kind: "needs-rendezvous", message: "Room codes connect through a rendezvous, coming in a later update. Use the build's address code or type its address." },
};

interface Args {
  onConnect: (target: ConnectTarget) => Promise<void>;
  discovered?: readonly DiscoveredBuild[];
  failure?: ConnectFailure | null;
}

function Demo(props: Args) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <output aria-label="State">{open ? "open" : "closed"}</output>
      {open && <ConnectDialog onConnect={props.onConnect} onClose={() => setOpen(false)} discovered={props.discovered} failure={props.failure} />}
    </div>
  );
}

const meta: Meta<Args> = { title: "Editor/Debug link/Connect dialog", render: (args: Args) => <Demo {...args} />, args: { onConnect: fn(() => Promise.resolve()) } };
export default meta;
type Story = StoryObj<Args>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const dialog = await c.findByRole("dialog", { name: "Connect to a build" });
    expect(within(dialog).getByLabelText("Code")).toHaveFocus();
    expect(within(dialog).getByLabelText("Or an address")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(within(dialog).queryByRole("group", { name: "Builds on the network" })).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  },
};

export const Typing: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(await c.findByLabelText("Code"), "3f9qk 7kd2x");
    expect(c.getByLabelText("Code")).toHaveValue("3f9qk 7kd2x");
    expect(c.getByRole("button", { name: "Connect" })).toBeEnabled();
  },
};

export const Connecting: Story = {
  args: { onConnect: () => new Promise<void>(() => {}) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(await c.findByLabelText("Code"), "3F9QK7KD2X{Enter}");
    expect(await c.findByRole("status")).toHaveTextContent("Connecting…");
    expect(c.getByLabelText("Code")).toBeDisabled();
    expect(c.getByRole("button", { name: "Connect" })).toBeDisabled();
  },
};

function failing(kind: string): Story {
  const failure = FAILURES[kind]!;
  return {
    args: { onConnect: refusal(failure) },
    play: async ({ canvasElement }) => {
      const c = within(canvasElement);
      await userEvent.type(await c.findByLabelText("Code"), "3F9QK7KD2X");
      await userEvent.click(c.getByRole("button", { name: "Connect" }));
      const alert = await c.findByRole("alert");
      expect(alert).toHaveTextContent(failure.message);
      expect(alert).toHaveAttribute("data-kind", kind);
      expect(c.getByRole("dialog")).toBeTruthy(); // stays open to try again
      expect(c.getByLabelText("Code")).toBeEnabled();
      await userEvent.type(c.getByLabelText("Code"), "X"); // typing again clears the line
      expect(c.queryByRole("alert")).toBeNull();
    },
  };
}
export const BadCode: Story = failing("bad-code");
export const Refused: Story = failing("refused");
export const Unreachable: Story = failing("unreachable");
export const NeedsRendezvous: Story = failing("needs-rendezvous");

export const OpenedWithAFailure: Story = {
  args: { failure: FAILURES.unreachable },
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByRole("alert")).toHaveTextContent("Nothing answered");
  },
};

export const Discovered: Story = {
  args: {
    discovered: [
      { name: "Racer", platform: "desktop", address: "192.168.1.20:7790" },
      { name: "Racer", platform: "android", address: "192.168.1.31:7790" },
    ],
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const list = await c.findByRole("group", { name: "Builds on the network" });
    await userEvent.click(within(list).getByRole("button", { name: /android/ }));
    expect(c.getByLabelText("Or an address")).toHaveValue("192.168.1.31:7790");
    expect(c.getByLabelText("Code")).toHaveFocus();
  },
};

export const EnterConnectsAndClosesOnSuccess: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.type(await c.findByLabelText("Code"), "3f9qk-7kd2x{Enter}");
    expect(args.onConnect).toHaveBeenCalledWith({ code: "3f9qk-7kd2x" });
    await within(canvasElement).findByText("closed");
    expect(c.queryByRole("dialog")).toBeNull();
  },
};

export const TypedAddress: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.type(await c.findByLabelText("Or an address"), "192.168.1.20:7790{Enter}");
    expect(args.onConnect).toHaveBeenCalledWith({ address: "192.168.1.20:7790" });
  },
};

export const EscapeCloses: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(c.getByLabelText("State").textContent).toBe("closed");
  },
};
