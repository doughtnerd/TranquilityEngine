// Stories (ADR 0219) for the Sample toolbar's Save split button (owner decision 3): Save saves the project data, the
// caret's menu offers Write to file… and Fork as new sample…; Write to file… is off for a file that isn't a WAV.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { SaveSplitButton } from "./SaveSplitButton";

function Demo(props: { wav: boolean }) {
  const [said, setSaid] = useState("");
  return (
    <div style={{ padding: "8px", display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
      <SaveSplitButton
        canSave
        whyNoWrite={props.wav ? null : "Only a WAV file can carry markers and loops"}
        canFork
        saveKeys="Ctrl+S"
        forkKeys="Ctrl+Shift+S"
        onSave={() => setSaid("saved")}
        onWrite={() => setSaid("write")}
        onFork={() => setSaid("fork")}
      />
      <output>{said}</output>
    </div>
  );
}

const meta: Meta<typeof Demo> = { title: "Studio/Samples/Save split button", component: Demo, args: { wav: true } };
export default meta;
type Story = StoryObj<typeof Demo>;

export const Wav: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(c.getByRole("button", { name: "Save" }));
    await expect(c.getByText("saved")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "More ways to save" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Write to file…" }));
    await expect(c.getByText("write")).toBeVisible();
  },
};

export const NotAWav: Story = {
  args: { wav: false },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "More ways to save" }));
    await expect(within(document.body).getByRole("menuitem", { name: "Write to file…" })).toBeDisabled();
  },
};
