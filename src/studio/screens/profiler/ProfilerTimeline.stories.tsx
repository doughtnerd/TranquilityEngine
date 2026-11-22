// Stories (ADR 0219, 0334) for the Profiler's timeline over the fixture capture, opened through the real capture reader
// and Worker by a `ProfilerStore` (as the screen opens a project file): the tracks in the prototype's order, voice lanes
// by bus with status colours, a click on a stolen voice selecting it and moving the cursor to its start, "Problems only"
// dimming played voices, lanes by sound, and the ruler's markers and warnings.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { fixtureCapture } from "./profilerFixture";
import { ProfilerStore } from "./profilerStore";
import { ProfilerTimeline } from "./ProfilerTimeline";
import type { GroupBy } from "./voiceModel";
import "./profiler.css";

/** A store with the fixture open, as the screen's store opens `captures/run.mycap`. */
async function fixtureStore(): Promise<ProfilerStore> {
  const store = new ProfilerStore({ open: (bytes) => CaptureSource.openFile(bytes), readFile: async () => fixtureCapture().slice().buffer });
  await store.openPath("captures/run.mycap");
  return store;
}

/** The timeline fed from the store's signals, as the Timeline panel feeds it. */
function Demo({ store, problemsOnly, groupBy }: { store: ProfilerStore; problemsOnly?: boolean; groupBy?: GroupBy }) {
  const data = store.data.value;
  if (!data) return <p>Opening…</p>;
  return (
    <div style={{ width: "900px" }}>
      <ProfilerTimeline
        data={data}
        cursor={store.cursor.value}
        readouts={store.readouts.value}
        selected={store.selected.value}
        problemsOnly={problemsOnly ?? store.problemsOnly.value}
        groupBy={groupBy ?? store.groupBy.value}
        onSeek={(t) => store.seekTo(t)}
        onSelect={(key) => store.select(key, true)}
      />
      <output aria-label="Selected">{store.selected.value ?? ""}</output>
    </div>
  );
}

interface Args {
  readonly problemsOnly?: boolean;
  readonly groupBy?: GroupBy;
}

const meta: Meta<Args> = {
  title: "Studio/Profiler/Timeline",
  loaders: [async () => ({ store: await fixtureStore() })],
  render: (args, { loaded }) => <Demo store={loaded.store as ProfilerStore} {...args} />,
};
export default meta;
type Story = StoryObj<Args>;

export const Fixture: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole("region", { name: "Capture timeline" })).toBeVisible());
    const labels = [...canvasElement.querySelectorAll(".pf-track-label")].map((e) => e.textContent);
    await expect(labels.slice(1, 6)).toEqual(["Load", "Bus · Music", "Bus · Vehicles", "Bus · Dialogue", "Dialogue"]);
    await expect(c.getAllByRole("button", { name: /Warning at|Error at|Marker at/ }).length).toBeGreaterThan(2);
  },
};

export const SelectStolenVoice: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const stolen = await waitFor(() => canvasElement.querySelector<HTMLButtonElement>('.pf-voice[data-status="stolen"]')!);
    await userEvent.click(stolen);
    await expect(stolen).toHaveAttribute("aria-pressed", "true");
    await expect(c.getByLabelText("Selected").textContent).toBe(stolen.dataset.voice);
    // The cursor went to the voice's start: the Music bus breakdown floats at it.
    await waitFor(() => expect(canvasElement.querySelector(".pf-float")?.textContent).toMatch(/^Music /));
  },
};

export const ProblemsOnly: Story = {
  args: { problemsOnly: true },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".pf-voice")).not.toBeNull());
    const played = [...canvasElement.querySelectorAll<HTMLElement>('.pf-voice[data-status="played"]')];
    await expect(played.every((b) => b.classList.contains("dim"))).toBe(true);
    await expect(canvasElement.querySelector('.pf-voice[data-status="missing"]')).not.toHaveClass("dim");
  },
};

export const BySound: Story = {
  args: { groupBy: "clip" },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByRole("group", { name: "boost.wav" })).toBeVisible());
  },
};
