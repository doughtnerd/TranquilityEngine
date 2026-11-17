// Stories (ADR 0219) for the Audio Debug panel (ADR 0157, 0220): the not-playing note, the status badge, amber and red
// cells, a sticky red that fades after five seconds of audio time, a new monitor on each Play, and the occlusion
// checkbox. `Audio.debug()` is spied on its public surface and answers the snapshot the story sets; the panel samples on
// its own 250 ms timer, so a play waits for the next sample to show. The monitor reads time from the snapshot
// (`info.time`), so a story moves the audio clock by setting it, not by faking timers.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, spyOn, userEvent, waitFor, within } from "storybook/test";
import { setPlayState } from "../../../editor/stories/editorStory";
import { Audio } from "../runtime/Audio";
import { AudioDebugPanel } from "./AudioDebugPanel";
import { occlusionOverlayOn } from "./OcclusionOverlay";
import { snapshot } from "./testing/debugSnapshot";
import type { AudioDebugSnapshot } from "./audioDebugMonitor";

/** What `Audio.debug()` answers next; a story replaces it between samples. */
let feed: () => AudioDebugSnapshot = () => snapshot();
const debugCalls = { n: 0 };

/** Wait this long for the panel's next 250 ms sample to show. */
const SAMPLE = { timeout: 3000 };

const play = () => setPlayState("playing");
const stop = () => setPlayState("edit");
/** The state cell of a label/value row in the panel. */
const cellOf = (root: HTMLElement, row: string) => root.querySelector<HTMLElement>(`tr[data-row="${row}"] td[data-health]`);

const meta = {
  title: "Audio/Debug/Panel",
  component: AudioDebugPanel,
  beforeEach: () => {
    feed = () => snapshot();
    debugCalls.n = 0;
    const spy = spyOn(Audio, "debug").mockImplementation(() => {
      debugCalls.n++;
      const info = feed();
      return { ...info, events: [], eventTotals: { lateStarts: 0 } };
    });
    return () => {
      spy.mockRestore();
      setPlayState("edit");
      occlusionOverlayOn.value = false;
    };
  },
} satisfies Meta<typeof AudioDebugPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotPlaying: Story = {
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByText("Not playing")).toBeVisible();
    expect(debugCalls.n).toBe(0);
    play();
    await waitFor(() => expect(within(canvasElement).queryByText("Not playing")).toBeNull());
    stop();
    await waitFor(() => expect(within(canvasElement).getByText("Not playing")).toBeVisible());
  },
};

export const StatusBadge: Story = {
  play: async ({ canvasElement }) => {
    play();
    const badge = () => canvasElement.querySelector<HTMLElement>(".audio-debug-status")!;
    await waitFor(() => expect(badge()).toHaveAttribute("data-status", "running"));
    expect(badge()).toHaveTextContent("running");
    expect(within(canvasElement).getByRole("table", { name: "Buses" })).toBeVisible();
    feed = () => snapshot({ status: "locked" });
    await waitFor(() => expect(badge()).toHaveAttribute("data-status", "locked"), SAMPLE);
    expect(badge()).toHaveTextContent("locked");
  },
};

export const AmberAndRedCells: Story = {
  play: async ({ canvasElement }) => {
    feed = () => snapshot({ counters: { zonesFaded: 0, irFailures: 0 } });
    play();
    await waitFor(() => expect(cellOf(canvasElement, "zonesFaded")).toHaveAttribute("data-health", "ok"));
    expect(cellOf(canvasElement, "irFailures")).toHaveAttribute("data-health", "ok");
    feed = () => snapshot({ counters: { zonesFaded: 2, irFailures: 1 } });
    await waitFor(() => expect(cellOf(canvasElement, "zonesFaded")).toHaveAttribute("data-health", "warn"), SAMPLE);
    expect(cellOf(canvasElement, "zonesFaded")).toHaveTextContent("2");
    expect(cellOf(canvasElement, "irFailures")).toHaveAttribute("data-health", "bad");
    // The theme's tokens colour them: amber is not red.
    expect(getComputedStyle(cellOf(canvasElement, "zonesFaded")!).color).not.toBe(getComputedStyle(cellOf(canvasElement, "irFailures")!).color);
  },
};

export const StickyRedFades: Story = {
  play: async ({ canvasElement }) => {
    let time = 0;
    let starved = 0;
    feed = () => snapshot({ time, counters: { wideStarved: starved } });
    play();
    await waitFor(() => expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "ok"));
    time = 1;
    starved = 1;
    await waitFor(() => expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "bad"), SAMPLE);
    // Four seconds on, with no new rise: still red.
    time = 5;
    const seen = debugCalls.n;
    await waitFor(() => expect(debugCalls.n).toBeGreaterThan(seen), SAMPLE);
    expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "bad");
    // Past five seconds after the rise: back to green.
    time = 7;
    await waitFor(() => expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "ok"), SAMPLE);
  },
};

export const NewPlayStartsANewMonitor: Story = {
  play: async ({ canvasElement }) => {
    let time = 0;
    let starved = 0;
    feed = () => snapshot({ time, counters: { wideStarved: starved } });
    play();
    await waitFor(() => expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "ok"));
    time = 1;
    starved = 1;
    await waitFor(() => expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "bad"), SAMPLE);
    stop();
    await waitFor(() => expect(within(canvasElement).getByText("Not playing")).toBeVisible());
    // The next Play's clock is later and the counter is unchanged: the old monitor would still call it a recent rise.
    time = 2;
    play();
    await waitFor(() => expect(cellOf(canvasElement, "wideStarved")).toHaveAttribute("data-health", "ok"));
  },
};

export const OcclusionToggle: Story = {
  beforeEach: () => {
    occlusionOverlayOn.value = false;
  },
  play: async ({ canvasElement }) => {
    play();
    const box = await within(canvasElement).findByLabelText("Show occlusion rays in the scene view");
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(occlusionOverlayOn.value).toBe(true);
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    expect(occlusionOverlayOn.value).toBe(false);
    await waitFor(() => expect(box).not.toBeChecked());
  },
};
