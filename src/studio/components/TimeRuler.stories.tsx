// Stories (ADR 0219, 0335) for the time ruler in its three displays; dragging on it scrubs.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, within } from "storybook/test";
import { TimeRuler } from "./TimeRuler";
import type { TimeFormat, TimeSpan } from "./timeRulerModel";

function Live(props: { format: TimeFormat; view: TimeSpan }) {
  const [t, setT] = useState(0);
  return (
    <div style={{ width: "640px" }}>
      <TimeRuler view={props.view} format={props.format} context={{ rate: 48000, bpm: 120, meter: "4/4" }} position={t} length={props.view.end} onScrub={(at) => setT(at)} />
    </div>
  );
}

const meta: Meta<typeof Live> = { title: "Studio/TimeRuler", component: Live };
export default meta;
type Story = StoryObj<typeof Live>;

export const Timecode: Story = {
  args: { format: "timecode", view: { start: 0, end: 2.6 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("slider", { name: "Time" })).toHaveAttribute("aria-valuetext", "0:00.000");
  },
};
export const Samples: Story = { args: { format: "samples", view: { start: 0, end: 0.05 } } };
export const BarsAndBeats: Story = { args: { format: "bars", view: { start: 0, end: 16 } } };
