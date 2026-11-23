// Stories (ADR 0219) for the Timeline window's item editor and binding picker (ADR 0373), as the window shows them under
// the grid, without a scene: a clip's fields, a camera cut, and a signal (the Animation window's row editor), each
// reporting its change as one labelled edit; and the binding picker's typed path for a timeline opened from a file.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, within } from "storybook/test";
import { parseTimeline, type Timeline } from "../../../../engine/animation/timeline";
import { BindingPicker } from "./BindingPicker";
import { ItemEditor } from "./ItemEditor";

const timeline: Timeline = parseTimeline({
  format: "myco.timeline@1",
  duration: 8,
  tracks: [
    { kind: "subclip", keys: [{ time: 1, end: 4, clip: "asset:clips/wave.anim.json", speed: 1 }] },
    { kind: "control", keys: [{ time: 2, action: "cameraCut", target: "Cam1" }] },
    { kind: "event", keys: [{ time: 3, method: "boom" }] },
  ],
}).value;

function Host(props: { id: string }) {
  const [last, setLast] = useState("none");
  const report = (r: object, label: string) => setLast("refused" in r ? `refused: ${(r as { refused: string }).refused}` : label);
  return (
    <div style={{ width: "720px" }}>
      <ItemEditor timeline={timeline} id={props.id} root={null} file="animation/intro.timeline.json" onItems={report} onApply={report} onOpen={(ref) => setLast(`open ${ref}`)} />
      <output aria-label="Last edit">{last}</output>
    </div>
  );
}

const meta = { title: "Animation/Timeline Item Editor" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A clip's speed change is one edit named "Set clip speed"; a speed past the limit is refused with the reason. */
export const ClipFields: Story = {
  render: () => <Host id="0#0" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("group", { name: "Clip" })).toBeTruthy();
    await fireEvent.change(c.getByLabelText("Speed"), { target: { value: "2" } });
    expect(c.getByLabelText("Last edit")).toHaveTextContent("Set clip speed");
    await fireEvent.change(c.getByLabelText("Speed"), { target: { value: "500" } });
    expect(c.getByLabelText("Last edit")).toHaveTextContent(/refused: the speed must be between/);
  },
};

/** A camera cut shows its action and target. */
export const CameraCut: Story = {
  render: () => <Host id="1#0" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText("Camera cut", { selector: ".aw-re-head" })).toBeTruthy();
    expect(c.getByRole("combobox", { name: "Action" })).toHaveDisplayValue("Camera cut");
  },
};

/** A signal reuses the Animation window's notify editor. */
export const Signal: Story = {
  render: () => <Host id="2#0" />,
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("group", { name: "Event key" })).toBeTruthy();
  },
};

/** Without a director the binding is a typed path. */
export const TypedBinding: Story = {
  render: () => {
    const [path, setPath] = useState("Hero");
    return <BindingPicker path={path} root={null} label="Binding of Hero" onPick={setPath} />;
  },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Binding of Hero" });
    await fireEvent.change(input, { target: { value: "Hero/Sword" } });
    expect(input).toHaveValue("Hero/Sword");
  },
};
