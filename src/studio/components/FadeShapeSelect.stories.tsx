// Stories (ADR 0219, 0335) for the fade shape picker (ADR 0336): a fade in and a fade out, each drawing its glyph.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { FadeShape } from "../../engine/audio/playlist/types";
import { FadeShapeSelect } from "./FadeShapeSelect";


function Harness(props: { readonly out?: boolean; readonly initial: FadeShape }) {
  const [v, setV] = useState<FadeShape>(props.initial);
  return <FadeShapeSelect label={props.out ? "Fade-out shape" : "Fade-in shape"} out={props.out} value={v} onValue={setV} />;
}

const meta = { title: "Studio/Fade shape", component: Harness, args: { initial: "equalPower" as FadeShape } } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FadeIn: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Fade-in shape" }), "exp3");
    await expect(c.getByRole("combobox", { name: "Fade-in shape" })).toHaveValue("exp3");
  },
};

export const FadeOut: Story = { args: { out: true, initial: "log2" } };
