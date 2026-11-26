// Stories (ADR 0219, 0349) for the Studio's player bar, "Layout A", in the prototype's states: idle; Samples (play-mode
// pill, the big disc, the mini waveform); Playlists (the type badge, the Trigger pill, the voice strip, Release / Stop);
// the Mixer (its big button is the game session, with the live label); the game session pill and Linked to game badge;
// a long status beside Hear as at 1440px (the status gives way, nothing else clips); the bar's height is the same in
// every state.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { HearAsControl } from "./HearAsControl";
import { RecordSession, LiveLabel, MiniWaveform, PlayerBar, TransportButton, VoiceStrip } from "./PlayerBar";

const meta: Meta<typeof PlayerBar> = { title: "Studio/PlayerBar", component: PlayerBar };
export default meta;
type Story = StoryObj<typeof PlayerBar>;

const at = (width: number) => (Story: () => ComponentChildren) => (
  <div style={{ width: `${width}px` }}>
    <Story />
  </div>
);
const noop = () => {};
const session = (live = false) => <RecordSession recording={live} time={live ? 12.48 : 0} connected title="Record a take on the game" link="linked" onToggle={noop} />;
const hearAs = <HearAsControl choice="source" busy={0} failure={null} onChoose={noop} onToggle={noop} />;
const LEVELS = [0.2, 0.5, 0.9, 0.7, 0.8, 0.6, 0.65, 0.5, 0.45, 0.4, 0.35, 0.3, 0.3, 0.25, 0.22, 0.2, 0.18, 0.15, 0.12, 0.1, 0.08, 0.06, 0.04, 0.02];

export const Idle: Story = {
  args: { idleArt: "WAV", session: session() },
  decorators: [at(1440)],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Nothing playing")).toBeVisible();
    await expect(c.getByRole("button", { name: /Record session/ })).toBeVisible();
  },
};

export const SamplesIdle: Story = {
  args: {
    nowPlaying: { art: "WAV", title: "brake_skid.wav", subtitle: "Loop · while held · 2.6 s" },
    viz: <MiniWaveform levels={LEVELS} playhead={0.2} />,
    transport: (
      <>
        <button class="studio-player-scope">Trim ▾</button>
        <TransportButton primary icon="play" label="Play" onClick={noop} />
      </>
    ),
    scrub: (
      <>
        <span>00:00.520</span>
        <input type="range" aria-label="Playhead" min={0} max={2.6} step={0.001} value={0.52} />
        <span>00:02.600</span>
      </>
    ),
    status: "Space plays Trim",
    hearAs,
    session: session(),
  },
  decorators: [at(1440)],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // One big button (the disc), no separate Stop.
    await expect(c.getAllByRole("button", { name: /Play|Stop/ })).toHaveLength(1);
    await expect(c.getByText("Space plays Trim")).toBeVisible();
  },
};

/** The Playlists screen: the tile is the playlist's type badge, the big button the Trigger pill, the scrubber the voice strip. */
function PlaylistDemo() {
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  return (
    <PlayerBar
      nowPlaying={{ art: "SW", title: "Bike impact", subtitle: "Switch · Surface" }}
      transport={
        <>
          <TransportButton icon="skipBack" label="Previous voice event" disabled={!busy} onClick={noop} />
          <TransportButton trigger icon={busy ? "release" : "trigger"} label={busy ? "Release" : "Trigger"} onClick={() => setBusy(!busy)} />
          {busy && <TransportButton icon="stop" label="Stop" onClick={() => setBusy(false)} />}
          <TransportButton icon="skipForward" label="Next voice event" disabled={!busy} onClick={noop} />
        </>
      }
      scrub={
        busy ? (
          <VoiceStrip from={0} to={4} cursor={cursor} segments={[{ start: 0, end: 1.2 }, { start: 0.3, end: 2.4 }, { start: 1, end: null }]} startText={(cursor ?? 4).toFixed(2)} endText="playing" onSeek={setCursor} />
        ) : (
          <VoiceStrip from={0} to={1} cursor={0} segments={[]} startText="0.00" endText="—" disabled onSeek={noop} />
        )
      }
      status={busy ? "Playing: metal_scrape + metal_body" : "Next trigger: Random pick · 1 of 5"}
      hearAs={hearAs}
      session={session()}
    />
  );
}

export const Playlists: StoryObj = {
  render: () => <PlaylistDemo />,
  decorators: [at(1440)],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = canvasElement.querySelector<HTMLElement>(".studio-player")!;
    const idleHeight = bar.offsetHeight;
    await expect(canvasElement.querySelector(".studio-player-art")).toHaveTextContent("SW");
    await userEvent.click(c.getByRole("button", { name: "Trigger" }));
    await expect(c.getByRole("button", { name: "Release" })).toBeVisible();
    const strip = c.getByRole("slider", { name: "Scrub through the voices" });
    strip.focus();
    await userEvent.keyboard("{Home}");
    await expect(strip).toHaveAttribute("aria-valuenow", "0");
    // The bar keeps its height when the trigger starts the voice strip.
    await expect(bar.offsetHeight).toBe(idleHeight);
  },
};

export const MixerSession: Story = {
  args: {
    nowPlaying: { art: "MIX", title: "canyon_run_03", subtitle: "Take replay · plays through this mix" },
    transport: <TransportButton primary icon="stop" label="Stop the game session" onClick={noop} />,
    scrub: (
      <>
        <LiveLabel live />
        <input type="range" aria-label="Replay position" min={0} max={32} value={12.48} />
        <span>00:12.480</span>
      </>
    ),
    status: "Changes play right away",
    hearAs,
    session: <RecordSession recording time={12.48} connected title="Stop and save the recording" link="linked" onToggle={noop} />,
  },
  decorators: [at(1440)],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Live")).toBeVisible();
    await expect(c.getByText("Linked to game")).toBeVisible();
    await expect(c.getByRole("button", { name: /Stop and save the recording, 00:12.480/ })).toBeVisible();
  },
};

/** A long status beside Hear as and the game session at 1440px: the status is cut (whole in its tooltip); nothing else clips. */
export const LongStatus: Story = {
  args: { ...SamplesIdle.args, status: "Playing Whole · 00:00.000 – 00:02.600 · Space releases the held loop" },
  decorators: [at(1440)],
  play: async ({ canvasElement }) => {
    const status = canvasElement.querySelector<HTMLElement>(".studio-player-status")!;
    await expect(status).toHaveAttribute("title", expect.stringContaining("Space releases"));
    const bar = canvasElement.querySelector(".studio-player")!.getBoundingClientRect();
    for (const el of canvasElement.querySelectorAll<HTMLElement>(".studio-hear-as, .studio-session, .studio-linked")) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      await expect(r.right).toBeLessThanOrEqual(bar.right);
      await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
    }
  },
};
