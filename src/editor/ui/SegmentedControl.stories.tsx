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

/** The filled look (prototype `.seg`), and a narrow row: the control keeps its content width and wraps, never clipping. */
export const FillAndWrap: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: "8px", width: "180px" }}>
      <span>Fill</span>
      <SegmentedControl label="Calibrate" look="fill" value={"ear" as string} onChange={() => {}} options={[{ value: "ear", label: "By ear" }, { value: "eye", label: "By eye" }]} />
      <span>Type</span>
      <SegmentedControl label="Marker type" value={"hit" as string} onChange={() => {}} options={[{ value: "exit", label: "Exit" }, { value: "hit", label: "Hit point" }, { value: "cue", label: "Cue" }, { value: "note", label: "Note" }]} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const fill = c.getByRole("radiogroup", { name: "Calibrate" });
    await expect(fill.getBoundingClientRect().width).toBeLessThan(120); // its content's width, not the row's
    const types = c.getByRole("radiogroup", { name: "Marker type" });
    const cue = c.getByRole("radio", { name: "Cue" });
    await expect(cue.getBoundingClientRect().right).toBeLessThanOrEqual(types.getBoundingClientRect().right + 0.5); // wrapped, not clipped
  },
};

const TYPES = [
  { value: "note", label: "Note" },
  { value: "exit", label: "Exit" },
  { value: "entry", label: "Entry" },
  { value: "hit", label: "Hit point" },
  { value: "cue", label: "Cue" },
] as const;
type MarkerType = (typeof TYPES)[number]["value"];

function FitDemo(props: { width: number }) {
  const [type, setType] = useState<MarkerType>("note");
  return (
    <div style={{ width: `${props.width}px` }}>
      <SegmentedControl label="Marker type" size="small" fit="menu" value={type} onChange={setType} options={TYPES} />
      <output aria-label="Type">{type}</output>
    </div>
  );
}

/** Journeys walk 2, V1: an inspector's Type at the dock's default width stays one row: a menu when the segments don't fit. */
export const FitsAsAMenu: StoryObj = {
  render: () => <FitDemo width={150} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const menu = await c.findByRole("combobox", { name: "Marker type" });
    await expect(c.queryByRole("radiogroup", { name: "Marker type" })).toBeNull();
    await userEvent.selectOptions(menu, "Hit point");
    await expect(c.getByLabelText("Type")).toHaveTextContent("hit");
  },
};

/** With room, the same control is one row of segments. */
export const FitsAsSegments: StoryObj = {
  render: () => <FitDemo width={400} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const group = await c.findByRole("radiogroup", { name: "Marker type" });
    await expect(c.queryByRole("combobox", { name: "Marker type" })).toBeNull();
    const tops = [...group.querySelectorAll("button")].map((b) => b.getBoundingClientRect().top);
    await expect(new Set(tops).size).toBe(1); // one row
  },
};
