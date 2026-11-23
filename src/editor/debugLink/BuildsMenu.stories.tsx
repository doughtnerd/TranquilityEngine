// Stories (ADR 0219, 0376) for the connected-builds menu: two builds (one on another machine), picking the one the
// debuggers read, None, disconnecting, the settings item; and the empty menu while listening, off, and unavailable.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import { BuildsMenu } from "./BuildsMenu";
import type { BuildEntry } from "./debugLinkLogic";
import type { ListenState } from "./editorLink";

const BUILDS: BuildEntry[] = [
  { id: 1, name: "Racer", platform: "web", remote: "127.0.0.1:50001" },
  { id: 2, name: "Racer", platform: "desktop", remote: "192.168.1.30:51234" },
];
const LISTENING: ListenState = { kind: "listening", address: "ws://127.0.0.1:7790/myco-debug" };

type Args = { builds: readonly BuildEntry[]; listen: ListenState; onSettings: () => void; onConnect?: () => void; onOfferRoom?: () => void; withSlot?: boolean };

function Demo(props: Args) {
  const [builds, setBuilds] = useState(props.builds);
  const [active, setActive] = useState<number | null>(builds[0]?.id ?? null);
  return (
    <div style={{ padding: "8px", display: "flex", gap: "8px", alignItems: "center" }}>
      <BuildsMenu
        builds={builds}
        active={active}
        listen={props.listen}
        onChoose={setActive}
        onDisconnect={(id) => {
          setBuilds(builds.filter((b) => b.id !== id));
          if (active === id) setActive(null);
        }}
        onSettings={props.onSettings}
        onConnect={props.onConnect}
        onOfferRoom={props.onOfferRoom}
        playSlot={props.withSlot ? <span>Play as a build: 3F9QK-7KD2X</span> : undefined}
      />
      <output aria-label="Active">{active ?? "none"}</output>
    </div>
  );
}

const meta = { title: "Editor/Debug link/Builds menu", render: (args: Args) => <Demo {...args} />, args: { builds: BUILDS, listen: LISTENING, onSettings: fn() } } satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoBuilds: Story = {
  play: async ({ canvasElement, args, step }) => {
    const c = within(canvasElement);
    const button = c.getByRole("button", { name: "2 builds" });
    await step("the menu lists each build and where it runs; the active one is checked", async () => {
      await userEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");
      const menu = within(c.getByRole("menu", { name: "Connected builds" }));
      expect(menu.getByRole("menuitemradio", { name: /Racer \(web, this machine\)/ })).toHaveAttribute("aria-checked", "true");
      expect(menu.getByRole("menuitemradio", { name: /Racer \(desktop, 192\.168\.1\.30\)/ })).toHaveAttribute("aria-checked", "false");
    });
    await step("picking another build makes it the one the debuggers read", async () => {
      await userEvent.click(within(c.getByRole("menu")).getByRole("menuitemradio", { name: /desktop/ }));
      expect(c.queryByRole("menu")).toBeNull();
      expect(c.getByLabelText("Active").textContent).toBe("2");
    });
    await step("None goes back to Play mode", async () => {
      await userEvent.click(button);
      await userEvent.click(within(c.getByRole("menu")).getByRole("menuitemradio", { name: /None/ }));
      expect(c.getByLabelText("Active").textContent).toBe("none");
    });
    await step("disconnecting a build drops it", async () => {
      await userEvent.click(button);
      const disconnects = within(c.getByRole("menu")).getAllByRole("menuitem", { name: "Disconnect Racer" });
      await userEvent.click(disconnects[0]!);
      expect(c.getByRole("button", { name: "1 build" })).toBeTruthy();
    });
    await step("the settings item", async () => {
      await userEvent.click(c.getByRole("button", { name: "1 build" }));
      await userEvent.click(within(c.getByRole("menu")).getByRole("menuitem", { name: "Debug link settings…" }));
      expect(args.onSettings).toHaveBeenCalled();
    });
  },
};

export const EscapeCloses: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2 builds" }));
    await userEvent.keyboard("{Escape}");
    expect(c.queryByRole("menu")).toBeNull();
  },
};

export const NoBuildsListening: Story = {
  args: { builds: [] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "No builds" }));
    expect(within(c.getByRole("menu")).getByText(/No builds connected\. Export with “Debugging on”.*ws:\/\/localhost:7790\/myco-debug/)).toBeTruthy();
    expect(within(c.getByRole("menu")).queryByRole("menuitemradio")).toBeNull();
  },
};

export const Off: Story = {
  args: { builds: [], listen: { kind: "off" } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Debug link off" }));
    expect(within(c.getByRole("menu")).getByText("The debug link is off. Turn it on in Settings.")).toBeTruthy();
  },
};

export const Unavailable: Story = {
  args: { builds: [], listen: { kind: "unavailable", why: "This editor can't listen for builds here: a browser page can't open a server socket. The desktop editor can." } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Debug link off" }));
    expect(within(c.getByRole("menu")).getByText(/can't listen for builds here/)).toBeTruthy();
  },
};

export const ConnectItem: Story = {
  args: { onConnect: fn() },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2 builds" }));
    await userEvent.click(within(c.getByRole("menu")).getByRole("menuitem", { name: "Connect to a build…" }));
    expect(args.onConnect).toHaveBeenCalled();
    expect(c.queryByRole("menu")).toBeNull();
  },
};

export const OfferRoomItem: Story = {
  args: { onOfferRoom: fn() },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2 builds" }));
    await userEvent.click(within(c.getByRole("menu")).getByRole("menuitem", { name: "Offer a room…" }));
    expect(args.onOfferRoom).toHaveBeenCalled();
    expect(c.queryByRole("menu")).toBeNull();
  },
};

export const NoOfferRoomItemWithoutTheHandler: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2 builds" }));
    expect(within(c.getByRole("menu")).queryByRole("menuitem", { name: "Offer a room…" })).toBeNull();
  },
};

export const NoConnectItemWithoutTheHandler: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2 builds" }));
    expect(within(c.getByRole("menu")).queryByRole("menuitem", { name: "Connect to a build…" })).toBeNull();
  },
};

export const PlaySlotAtTheTop: Story = {
  args: { withSlot: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2 builds" }));
    expect(c.getByRole("menu").firstElementChild).toHaveTextContent("Play as a build: 3F9QK-7KD2X");
  },
};
