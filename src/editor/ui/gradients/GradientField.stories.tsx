// Stories (ADR 0219, 0396) for the shared gradient field: colour stops under the bar, alpha stops above it. Clicking the
// bar's lower half adds a colour stop, its upper half an alpha stop; a selected stop shows its readout; Remove deletes it.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, userEvent, within } from "storybook/test";
import type { Gradient } from "../../../engine/core/gradient";
import { GradientField, GradientPreview } from "./GradientField";

const START: Gradient = { colors: [[0, "#ffffff"], [1, "#ff8000"]], alphas: [[0, 1], [1, 0]] };

function Host(props: { initial?: Gradient; readOnly?: boolean }) {
  const [g, setG] = useState<Gradient>(props.initial ?? START);
  return (
    <div style={{ width: "320px" }}>
      <GradientPreview gradient={g} />
      <GradientField gradient={g} label="Colour" readOnly={props.readOnly} onChange={setG} />
      <output aria-label="Stops">{g.colors.length} colour, {g.alphas.length} alpha</output>
    </div>
  );
}

const meta = {
  title: "Editor/Gradients/Gradient Field",
  render: () => <Host />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Clicking the lower half of the bar adds a colour stop; the upper half adds an alpha stop. */
export const AddStops: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = c.getByRole("img", { name: "Colour gradient" });
    const r = bar.getBoundingClientRect();
    await fireEvent.click(bar, { clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.75 });
    expect(c.getByLabelText("Stops")).toHaveTextContent("3 colour, 2 alpha");
    await fireEvent.click(bar, { clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.25 });
    expect(c.getByLabelText("Stops")).toHaveTextContent("3 colour, 3 alpha");
    expect(c.getByLabelText("Colour stop alpha")).toBeInTheDocument();
  },
};

/** Selecting an alpha stop edits its value and position; Remove deletes it. */
export const EditAlphaStop: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await fireEvent.pointerDown(c.getByRole("button", { name: "Colour alpha stop 2" }), { pointerId: 1 });
    const alpha = c.getByLabelText("Colour stop alpha");
    await userEvent.clear(alpha);
    await userEvent.type(alpha, "0.5");
    expect(alpha).toHaveValue("0.5");
    await userEvent.click(c.getByRole("button", { name: "Colour remove stop" }));
    expect(c.getByLabelText("Stops")).toHaveTextContent("2 colour, 1 alpha");
  },
};

/** The last colour stop can't be removed. */
export const KeepsOneColourStop: Story = {
  render: () => <Host initial={{ colors: [[0, "#336699"]], alphas: [] }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await fireEvent.pointerDown(c.getByRole("button", { name: "Colour color stop 1" }), { pointerId: 1 });
    expect(c.getByRole("button", { name: "Colour remove stop" })).toBeDisabled();
  },
};

/** Read-only: stops are disabled. */
export const ReadOnly: Story = {
  render: () => <Host readOnly />,
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("button", { name: "Colour alpha stop 1" })).toBeDisabled();
  },
};
