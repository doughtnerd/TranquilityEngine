// Stories (ADR 0373 "A recorder keeps the last N seconds … Scrub it"; T52) for the recorder's scrubber and the debugger
// strip: scrubbing to a past frame and back to Live, keyframe ticks, each kept length, the pose hint paused and
// running, and the Animator menu.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import type { AnimatorDebugFrame } from "../../runtime/features/debug/frame";
import { DebugBar } from "./DebugBar";
import { RECORD_SECONDS, RecorderBar } from "./RecorderBar";
import type { DebugRecording, DebugTarget } from "./source";
import "./debugger.css";

const frames: AnimatorDebugFrame[] = Array.from({ length: 90 }, (_, i) => ({
  index: 100 + i,
  time: (i + 1) / 30,
  report: { instance: 1, nodes: [], machines: [], transitions: [], requests: [], dropped: 0 },
  parameters: [],
  inputs: i === 40 ? [{ kind: "request", name: "Jump", lifetime: 0.2 }, { kind: "param", name: "speed", value: 2 }] : [],
  root: [],
}));
const isKeyframe = (index: number) => (index - 100) % 30 === 0;

function Harness(props: { paused: boolean }) {
  const [scrub, setScrub] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(10);
  return (
    <div style={{ width: "640px" }}>
      <RecorderBar frames={frames} isKeyframe={isKeyframe} scrub={scrub} onScrub={setScrub} seconds={seconds} onSeconds={setSeconds} paused={props.paused} poseShown={props.paused && scrub !== null} />
      <output aria-label="Kept">{seconds}</output>
    </div>
  );
}

const meta = { title: "Animation/Debugger/Recorder", render: (args: { paused: boolean }) => <Harness paused={args.paused} />, args: { paused: true } } satisfies Meta<{ paused: boolean }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Paused: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const slider = c.getByLabelText<HTMLInputElement>("Recorded frame");
    expect(c.getByLabelText("Scrubbed time").textContent).toBe("live");
    expect(canvasElement.querySelectorAll(".dbg-tick")).toHaveLength(3);
    await step("scrubbing to a past frame shows its time, pose and inputs", async () => {
      slider.value = "40";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      expect(await c.findByText(/Showing this frame's pose · request Jump \(0\.20 s\), speed = 2/)).toBeTruthy();
      expect(c.getByLabelText("Scrubbed time").textContent).toBe("−1.63 s");
      expect(c.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "false");
    });
    await step("Live follows the game again", async () => {
      await userEvent.click(c.getByRole("button", { name: "Live" }));
      expect(c.getByLabelText("Scrubbed time").textContent).toBe("live");
    });
    await step("each kept length", async () => {
      for (const s of RECORD_SECONDS) {
        await userEvent.selectOptions(c.getByLabelText("Seconds kept"), String(s));
        expect(c.getByLabelText("Kept").textContent).toBe(String(s));
      }
    });
  },
};

export const Running: Story = {
  args: { paused: false },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const slider = c.getByLabelText<HTMLInputElement>("Recorded frame");
    slider.value = "10";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(await c.findByText("Pause to see this frame's pose")).toBeTruthy();
  },
};

const tables = compileAnimGraph(parseAnimGraph({ format: "myco.animgraph-source@1", output: null, nodes: [] }).value);
const targets: DebugTarget[] = [{ id: "a", label: "Hero", graph: "hero.animgraph.json", tables }, { id: "b", label: "Guard", graph: "hero.animgraph.json", tables }];
const recording: DebugRecording = { frames, seconds: 10, isKeyframe, show: () => true, showing: null };
const choose = fn();

export const Strip: Story = {
  render: () => (
    <div style={{ width: "900px" }}>
      <DebugBar debug={{ status: "Debugging Hero", targets, target: targets[0]!, chosen: null, choose, recording, scrub: null, setScrub: () => {}, poseShown: false, paused: false }} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("status").textContent).toBe("Debugging Hero");
    await userEvent.selectOptions(c.getByLabelText("Debugged Animator"), "b");
    expect(choose).toHaveBeenLastCalledWith("b");
    await userEvent.selectOptions(c.getByLabelText("Debugged Animator"), "");
    expect(choose).toHaveBeenLastCalledWith(null);
    expect(c.getByRole("group", { name: "Recorder" })).toBeTruthy();
  },
};
