// Stories (ADR 0219, 0335) for chips: kind badges in each tone, a filter chip that toggles, and a removable chip.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { Chip } from "./Chip";

const meta: Meta = { title: "Kit/Chip", component: Chip };
export default meta;

export const Tones: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: "6px" }}>
      <Chip>WAV</Chip>
      <Chip tone="accent">Loop</Chip>
      <Chip tone="success">Calibrated</Chip>
      <Chip tone="warning">Not calibrated</Chip>
      <Chip tone="danger">Clipping</Chip>
    </div>
  ),
};

function FilterDemo() {
  const [on, setOn] = useState(false);
  const [tags, setTags] = useState(["vehicles", "ui"]);
  return (
    <div style={{ display: "flex", gap: "6px" }}>
      <Chip pressed={on} onToggle={setOn}>
        Problems only
      </Chip>
      {tags.map((t) => (
        <Chip key={t} tone="accent" onRemove={() => setTags(tags.filter((x) => x !== t))} removeLabel={`Remove ${t}`}>
          {t}
        </Chip>
      ))}
    </div>
  );
}

export const FilterAndRemove: StoryObj = {
  render: () => <FilterDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Problems only" }));
    await expect(c.getByRole("button", { name: "Problems only" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Remove ui" }));
    await expect(c.queryByText("ui")).toBeNull();
  },
};
