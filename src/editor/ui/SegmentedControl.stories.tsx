// Stories (ADR 0219, 0349) for the segmented control: a radio group of joined buttons; the arrows move and pick.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { SegmentedControl } from "./SegmentedControl";

function Demo(props: { small?: boolean }) {
  const [mode, setMode] = useState<"ear" | "eye" | "both">("ear");
  return (
    <div>
      <SegmentedControl label="Calibrate" size={props.small ? "small" : "normal"} value={mode} onChange={setMode} options={[{ value: "ear", label: "By ear" }, { value: "eye", label: "By eye" }, { value: "both", label: "Both", disabled: true }]} />
      <output aria-label="Mode">{mode}</output>
    </div>
  );
}

const meta: Meta = { title: "Kit/SegmentedControl", component: SegmentedControl };
export default meta;

export const Arrows: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("radio", { name: "By ear" }));
    await userEvent.keyboard("{ArrowRight}");
    await expect(c.getByLabelText("Mode")).toHaveTextContent("eye");
    await userEvent.keyboard("{ArrowRight}"); // past the disabled one, back to the first
    await expect(c.getByLabelText("Mode")).toHaveTextContent("ear");
  },
};

export const Small: StoryObj = { render: () => <Demo small /> };
