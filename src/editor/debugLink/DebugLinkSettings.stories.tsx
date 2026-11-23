// Stories (ADR 0219, 0376) for the debug link's preferences: listening on this machine (the default), the LAN toggle
// (off by default), the port (a bad one falls back), listening off, and a host that can't listen.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { DebugLinkFields } from "./DebugLinkSettings";
import { DEFAULT_DEBUG_LINK_PREFERENCES, listenAddress, type DebugLinkPreferences } from "./debugLinkLogic";
import type { ListenState } from "./editorLink";

function Demo(props: { unavailable?: boolean }) {
  const [value, setValue] = useState<DebugLinkPreferences>(DEFAULT_DEBUG_LINK_PREFERENCES);
  const listen: ListenState = !value.listen ? { kind: "off" } : props.unavailable ? { kind: "unavailable", why: "This editor can't listen for builds here: a browser page can't open a server socket. The desktop editor can." } : { kind: "listening", address: listenAddress(value) };
  return (
    <div class="settings-dialog" style={{ width: "520px" }}>
      <DebugLinkFields value={value} listen={listen} onChange={setValue} />
      <output aria-label="Stored">{JSON.stringify(value)}</output>
    </div>
  );
}

const meta = { title: "Editor/Debug link/Settings", render: (args: { unavailable: boolean }) => <Demo unavailable={args.unavailable} />, args: { unavailable: false } } satisfies Meta<{ unavailable: boolean }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const listen = c.getByRole("checkbox", { name: /Listen for builds/ });
    const lan = c.getByRole("checkbox", { name: /local network/ });
    await step("on for this machine, the LAN off", async () => {
      expect(listen).toBeChecked();
      expect(lan).not.toBeChecked();
      expect(c.getByRole("status").textContent).toBe("Listening on this machine only: builds connect to ws://localhost:7790/myco-debug.");
    });
    await step("the LAN toggle", async () => {
      await userEvent.click(lan);
      expect(c.getByLabelText("Stored").textContent).toContain('"lan":true');
      expect(c.getByRole("status").textContent).toMatch(/^Listening on every network interface, port 7790/);
      await userEvent.click(lan);
      expect(c.getByLabelText("Stored").textContent).toContain('"lan":false');
    });
    await step("the port; a bad one falls back to the default", async () => {
      const port = c.getByLabelText<HTMLInputElement>("Debug link port");
      await userEvent.clear(port);
      await userEvent.type(port, "8123");
      port.blur();
      expect(c.getByLabelText("Stored").textContent).toContain('"port":8123');
      await userEvent.clear(port);
      await userEvent.type(port, "80");
      port.blur();
      expect(c.getByLabelText("Stored").textContent).toContain('"port":7790');
    });
    await step("off: nothing can connect, and the other fields rest", async () => {
      await userEvent.click(listen);
      expect(c.getByRole("status").textContent).toBe("Off: builds can't connect to this editor.");
      expect(lan).toBeDisabled();
      expect(c.getByLabelText("Debug link port")).toBeDisabled();
    });
  },
};

export const CantListenHere: Story = {
  args: { unavailable: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("status").textContent).toMatch(/can't listen for builds here/);
  },
};
