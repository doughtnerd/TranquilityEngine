// Stories (ADR 0219, 0349) for the waveform: a sample with loop bands, a deleted snippet, the playhead, and the
// placeholder while peaks load. Ctrl+wheel zooms, wheel scrolls.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, within } from "storybook/test";
import { Playhead } from "./Playhead";
import { storyPeaks } from "./storyPeaks";
import type { TimeSpan } from "./timeRulerModel";
import { Waveform } from "./Waveform";

const peaks = storyPeaks();

function Live(props: { loading?: boolean }) {
  const [view, setView] = useState<TimeSpan>({ start: 0, end: 2.6 });
  const [t, setT] = useState(0.9);
  return (
    <div style={{ width: "640px", height: "140px" }}>
      <Waveform
        mips={props.loading ? null : peaks}
        view={view}
        length={2.6}
        label="brake_skid.wav"
        onView={setView}
        onPress={(at) => setT(at)}
        bands={[
          { start: 0.45, end: 1.55, color: "--range-loop", label: "Loop 1" },
          { start: 1.9, end: 2.1, color: "--danger", hatched: true },
          { start: 2.3, end: 2.3, color: "--range-loop", label: "Hold" },
        ]}
      >
        <Playhead t={t} view={view} playing />
      </Waveform>
    </div>
  );
}

const meta: Meta<typeof Live> = { title: "Studio/Waveform", component: Live };
export default meta;
type Story = StoryObj<typeof Live>;

export const WithBands: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "brake_skid.wav" })).toBeVisible();
    await expect(within(canvasElement).getByText("Loop 1")).toBeVisible();
  },
};

export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Reading the waveform…")).toBeVisible();
  },
};
