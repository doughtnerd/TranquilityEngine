// Stories (ADR 0219, 0348) for the Profiler's timeline over the fixture capture, opened through the real capture reader
// and Worker by a `ProfilerStore` (as the screen opens a project file): the tracks in the prototype's order, voice lanes
// by bus with status colours, a click on a stolen voice selecting it and moving the cursor to its start, "Problems only"
// dimming played voices, lanes by sound, and the ruler's markers and warnings.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { QUANTA_PER_STATUS, QUANTUM_MS, records, type Fields } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import { assembleCapture } from "../../../plugins/audio/runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META } from "../../../plugins/audio/runtime/capture/testSupport";
import { fixtureCapture } from "./profilerFixture";
import { ProfilerStore } from "./profilerStore";
import { ProfilerTimeline } from "./ProfilerTimeline";
import type { GroupBy } from "./voiceModel";
import "./profiler.css";

/** A store with the fixture open, as the screen's store opens `recordings/run.sporesample`. */
async function fixtureStore(): Promise<ProfilerStore> {
  const store = new ProfilerStore({ open: (bytes) => CaptureSource.openFile(bytes), readFile: async () => fixtureCapture().slice().buffer });
  await store.openPath("recordings/run.sporesample");
  return store;
}

/** The timeline fed from the store's signals, as the Timeline panel feeds it. */
function Demo({ store, problemsOnly, groupBy, heatmap }: { store: ProfilerStore; problemsOnly?: boolean; groupBy?: GroupBy; heatmap?: boolean }) {
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
        heatmap={heatmap}
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
  readonly heatmap?: boolean;
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
    await expect(labels.slice(0, 4)).toEqual(["Load", "Effects", "Memory", "Bus · Music"]);
    // The ruler's head reads the cursor as the take's playhead does.
    await expect(canvasElement.querySelector(".run-readout")?.textContent).toMatch(/^\d\d:\d\d\.\d{3}$/);
    await expect(c.getAllByRole("button", { name: /Warning at|Error at|Marker at/ }).length).toBeGreaterThan(2);
  },
};

/** ADR 0351 §6: the clip arena and the Forest package (loaded 1.2 s to 9 s), with a mark at its load and unload. */
export const Memory: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const row = await waitFor(() => c.getByRole("group", { name: "Memory" }));
    await expect(within(row).getByRole("note", { name: /^Forest loaded · 880 KB at/ })).toBeInTheDocument();
    await expect(within(row).getByRole("note", { name: /^Forest unloaded at/ })).toBeInTheDocument();
    await expect(row).toHaveTextContent("peak arena");
    // At 5 s the package is resident: the readout counts it.
    const plot = row.querySelector<HTMLElement>(".pf-plot")!;
    const box = plot.getBoundingClientRect();
    fireEvent.click(plot, { clientX: box.left + box.width * 0.42, clientY: box.top + 2 });
    await waitFor(() => expect(row.querySelector(".pf-track-value")?.textContent).toMatch(/^arena .* · packages 880 KB$/));
  },
};

/** Experimental heatmap: each voice coloured by how often its clip played in the capture (the most played is hottest). */
export const Heatmap: Story = {
  args: { heatmap: true },
  play: async ({ canvasElement }) => {
    const voices = await waitFor(() => {
      const all = [...canvasElement.querySelectorAll<HTMLElement>(".pf-voice.heat")];
      if (all.length === 0) throw new Error("no heat yet");
      return all;
    });
    const heats = voices.map((v) => Number(v.style.getPropertyValue("--heat")));
    await expect(Math.max(...heats)).toBe(1);
    await expect(voices.some((v) => /played (once|\d+ times)/.test(v.title))).toBe(true);
  },
};

export const SelectStolenVoice: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const stolen = await waitFor(() => canvasElement.querySelector<HTMLButtonElement>('.pf-voice[data-status="stolen"]')!);
    await userEvent.click(stolen);
    await expect(stolen).toHaveAttribute("aria-pressed", "true");
    await expect(c.getByLabelText("Selected").textContent).toBe(stolen.dataset.voice);
    // The cursor went to the voice's start.
    await waitFor(() => expect(canvasElement.querySelector(".run-readout")?.textContent).not.toBe("00:00.000"));
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

/** A capture of a steady load (40 % of each quantum, voices doing three times the buses' work), long enough to fit the meter. */
function cpuCapture(): ArrayBuffer {
  const fields = (k: number): Fields => ({
    quantaTotal: (k + 1) * QUANTA_PER_STATUS, busyMsTotal: (k + 1) * QUANTA_PER_STATUS * QUANTUM_MS * 0.4, clockStepMs: 1, wuVoices: (k + 1) * 30, wuBuses: (k + 1) * 10,
  });
  return assembleCapture(SAMPLE_HEADER, SAMPLE_META, records(320, fields), { index: true }).slice().buffer;
}

export const EffectsCost: Story = {
  loaders: [
    async () => {
      const store = new ProfilerStore({ open: (bytes) => CaptureSource.openFile(bytes), readFile: async () => cpuCapture() });
      await store.openPath("recordings/cpu.sporesample");
      return { store };
    },
  ],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const row = await waitFor(() => c.getByRole("group", { name: "Effects cost · estimated" }));
    await expect(within(row).getByText("Voices")).toBeVisible();
    // A click moves the cursor there: the costliest sections then.
    // At the plot's middle (a click with no position lands at its left edge, time 0, before the first reading).
    const plot = row.querySelector<HTMLElement>(".pf-plot")!;
    const r = plot.getBoundingClientRect();
    await userEvent.pointer({ keys: "[MouseLeft]", target: plot, coords: { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 } });
    await waitFor(() => expect(row.querySelector(".pf-track-value")?.textContent).toMatch(/^Voices \d+‰ · Buses \d+‰$/));
  },
};

export const BySound: Story = {
  args: { groupBy: "clip" },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByRole("group", { name: "boost.wav" })).toBeVisible());
  },
};
