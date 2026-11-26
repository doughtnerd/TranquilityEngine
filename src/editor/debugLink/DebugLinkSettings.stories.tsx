// Stories (ADR 0219, 0376, 0403) for the debug link's preferences: listening on this machine (the default), the LAN toggle
// (off by default), the port (a bad one falls back), the rendezvous URL and ICE servers (empty, filled, invalid), listening
// off (the fields rest disabled), and a host that can't listen.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { DebugLinkFields } from "./DebugLinkSettings";
import { DEFAULT_DEBUG_LINK_PREFERENCES, listenAddress, type DebugLinkPreferences } from "./debugLinkLogic";
import type { ListenState } from "./editorLink";

function Demo(props: { unavailable?: boolean; initial?: Partial<DebugLinkPreferences> }) {
  const [value, setValue] = useState<DebugLinkPreferences>({ ...DEFAULT_DEBUG_LINK_PREFERENCES, ...props.initial });
  const listen: ListenState = !value.listen ? { kind: "off" } : props.unavailable ? { kind: "unavailable", why: "This editor can't listen for builds here: a browser page can't open a server socket. The desktop editor can, and this one can still connect to a build by its code (Connect to a build… in the builds menu)." } : { kind: "listening", address: listenAddress(value) };
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
    await step("empty: no rendezvous and no ICE servers", async () => {
      expect(c.getByLabelText("Rendezvous URL")).toHaveValue("");
      expect(c.getByLabelText("ICE servers")).toHaveValue("");
      expect(c.getByLabelText("Stored").textContent).toContain('"rendezvous":"","iceServers":[]');
    });
    await step("off: nothing can connect, and the other fields rest", async () => {
      await userEvent.click(listen);
      expect(c.getByRole("status").textContent).toBe("Off: builds can't connect to this editor.");
      expect(lan).toBeDisabled();
      expect(c.getByLabelText("Debug link port")).toBeDisabled();
    });
  },
};

export const RendezvousFilled: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await step("a ws:// rendezvous is kept", async () => {
      const rendezvous = c.getByLabelText<HTMLInputElement>("Rendezvous URL");
      await userEvent.type(rendezvous, "ws://rv.example.org:7800/myco-rendezvous");
      rendezvous.blur();
      expect(c.getByLabelText("Stored").textContent).toContain('"rendezvous":"ws://rv.example.org:7800/myco-rendezvous"');
      expect(c.queryByText(/isn't a ws:\/\/ or wss:\/\/ address/)).toBeNull();
    });
  },
};

export const RendezvousInvalid: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await step("an http:// address is dropped to empty, with a note", async () => {
      const rendezvous = c.getByLabelText<HTMLInputElement>("Rendezvous URL");
      await userEvent.type(rendezvous, "https://rv.example.org");
      rendezvous.blur();
      expect(rendezvous).toHaveValue("");
      expect(c.getByLabelText("Stored").textContent).toContain('"rendezvous":""');
      expect(c.getByText(/"https:\/\/rv\.example\.org" isn't a ws:\/\/ or wss:\/\/ address, so it was dropped\./)).toBeInTheDocument();
    });
  },
};

export const IceServersFilled: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await step("STUN and TURN lines are kept, one per entry", async () => {
      const ice = c.getByLabelText<HTMLTextAreaElement>("ICE servers");
      await userEvent.type(ice, "stun:stun.example.org:3478{enter}turns:turn.example.org:5349");
      ice.blur();
      expect(c.getByLabelText("Stored").textContent).toContain('"iceServers":["stun:stun.example.org:3478","turns:turn.example.org:5349"]');
      expect(c.queryByText(/a stun:, turn: or turns: address/)).toBeNull();
    });
  },
};

export const IceServersInvalid: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await step("a line that isn't STUN or TURN is dropped, the others kept", async () => {
      const ice = c.getByLabelText<HTMLTextAreaElement>("ICE servers");
      await userEvent.type(ice, "stun:stun.example.org:3478{enter}https://bad.example.org");
      ice.blur();
      expect(c.getByLabelText("Stored").textContent).toContain('"iceServers":["stun:stun.example.org:3478"]');
      expect(ice).toHaveValue("stun:stun.example.org:3478");
      expect(c.getByText(/One line isn't a stun:, turn: or turns: address, so it was dropped\./)).toBeInTheDocument();
    });
  },
};

export const ListenOff: Story = {
  render: () => <Demo initial={{ listen: false, rendezvous: "ws://rv.example.org:7800/myco-rendezvous", iceServers: ["stun:stun.example.org:3478"] }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByLabelText("Rendezvous URL")).toBeDisabled();
    expect(c.getByLabelText("ICE servers")).toBeDisabled();
    expect(c.getByLabelText("Rendezvous URL")).toHaveValue("ws://rv.example.org:7800/myco-rendezvous");
    expect(c.getByRole("status").textContent).toBe("Off: builds can't connect to this editor.");
  },
};

export const CantListenHere: Story = {
  args: { unavailable: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("status").textContent).toMatch(/can't listen for builds here/);
  },
};
