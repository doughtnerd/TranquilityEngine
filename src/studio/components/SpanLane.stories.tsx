// Stories (ADR 0219, 0349) for the span lane: a capture's voices (played, held, blocked, stolen, missing, virtual and
// still playing) stacked where they overlap; selecting with clicks and the arrow keys; the "problems only" filter.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { AXIS, VOICES, WIDTH } from "./laneStoryData";
import { SpanLane } from "./SpanLane";

function Demo(props: { filter?: "all" | "problems" }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div>
      <SpanLane label="Voices" spans={VOICES} toX={AXIS.toX} width={WIDTH} now={30} selected={selected} filter={props.filter} onSelect={setSelected} />
      <p data-testid="selected">{selected ?? "none"}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/SpanLane", component: SpanLane };
export default meta;

export const Voices: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("option", { name: /boost_01/ }));
    await expect(c.getByTestId("selected")).toHaveTextContent("b1");
    c.getByRole("listbox", { name: "Voices" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(c.getByTestId("selected")).toHaveTextContent("b2");
  },
};

export const ProblemsOnly: StoryObj = { render: () => <Demo filter="problems" /> };
