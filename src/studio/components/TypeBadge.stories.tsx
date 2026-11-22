// Stories (ADR 0219, 0335) for the type badges: every playlist type, a two-axis Blend and a sample, each in its series
// colour (themed by Settings > Appearance).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { TypeBadge } from "./TypeBadge";

const meta: Meta = { title: "Studio/TypeBadge", component: TypeBadge };
export default meta;

export const All: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: "8px" }}>
      <TypeBadge playlist="queue" />
      <TypeBadge playlist="switch" />
      <TypeBadge playlist="blend" />
      <TypeBadge playlist="blend" axes={2} />
      <TypeBadge playlist="layer" />
      <TypeBadge playlist="clip" />
      <TypeBadge playlist="sequence" />
      <TypeBadge sample />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("img", { name: "Blend playlist, two axes" })).toHaveTextContent("2D");
    await expect(c.getByRole("img", { name: "Sample" })).toHaveTextContent("SMP");
  },
};
