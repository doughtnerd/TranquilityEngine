// Stories (ADR 0219, 0335) for "Why it played": a voice that played (steps open their screens), a voice stolen by a
// limit, a missing file, a narrow panel where the chain stacks, and no voice selected. Arrows pan, + − zoom, 0 fits.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { CausalChain } from "./CausalChain";
import type { CausalStep } from "./causalChainModel";

const LAND: CausalStep[] = [
  { kind: "game", name: "Land", why: "Velocity 118", severity: "ok" },
  { kind: "sequence", name: "HoverBike/Land", why: "Clip at 0:00.0", severity: "ok", target: { screen: "playlists" } },
  { kind: "playlist", tag: "SW", name: "Bike impacts", why: "Surface → Metal", severity: "ok", target: { screen: "playlists" } },
  { kind: "playlist", tag: "1D", name: "Metal impacts", why: "Velocity 118 → Hard", severity: "ok", target: { screen: "playlists" } },
  { kind: "playlist", tag: "RND", name: "Metal hard", why: "Round robin → #4", severity: "ok", target: { screen: "playlists" } },
  { kind: "sample", name: "land_hard_04.wav", why: "Trim 0.00–0.92 s", severity: "ok", target: { screen: "samples" } },
  { kind: "bus", name: "SFX › Vehicles", why: "−6.0 dB", severity: "ok", target: { screen: "mixer" } },
];

const STOLEN: CausalStep[] = [
  { kind: "game", name: "Impact", why: "Speed 64", severity: "ok" },
  { kind: "playlist", tag: "RND", name: "Impacts", why: "Random → #3", severity: "ok", target: {} },
  { kind: "limit", name: "Impacts voice limit 4", why: "Stole the quietest voice; cut after 0.9 s", severity: "warning", target: {} },
  { kind: "bus", name: "SFX", why: "−2.0 dB", severity: "ok", target: {} },
];

const MISSING: CausalStep[] = [
  { kind: "game", name: "Dialogue line", why: "rider_07", severity: "ok" },
  { kind: "playlist", tag: "CLP", name: "Rider lines", why: "Line 7", severity: "ok", target: {} },
  { kind: "sample", name: "vo_rider_07.wav", why: "Missing file", severity: "error", target: {} },
];

function Demo(props: { steps: CausalStep[]; width?: number }) {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <div style={{ width: `${props.width ?? 620}px`, height: "260px", display: "flex", flexDirection: "column" }}>
      <CausalChain steps={props.steps} label="land_hard_04 at 0:21.4" onStep={(s) => setOpened(s.name)} />
      <p data-testid="opened">{opened ?? "nothing"}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/CausalChain", component: CausalChain };
export default meta;

export const Played: StoryObj = {
  render: () => <Demo steps={LAND} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Open Bike impacts" }));
    await expect(c.getByTestId("opened")).toHaveTextContent("Bike impacts");
    c.getByRole("group", { name: /Why it played/ }).focus();
    await userEvent.keyboard("1");
    await expect(c.getByRole("button", { name: "100%" })).toBeVisible();
  },
};

export const Stolen: StoryObj = { render: () => <Demo steps={STOLEN} /> };

export const MissingFile: StoryObj = { render: () => <Demo steps={MISSING} /> };

export const NarrowStacks: StoryObj = { render: () => <Demo steps={LAND} width={260} /> };

export const NoVoice: StoryObj = { render: () => <Demo steps={[]} /> };
