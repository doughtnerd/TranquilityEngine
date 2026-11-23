// Stories (ADR 0219, 0349) for the panel fields: a section of labelled rows with a number box (unit, range, arrow
// steps) and a select.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { FieldRow, NumberBox, Section, SelectBox } from "./PanelFields";

function Panel() {
  const [gain, setGain] = useState(-6);
  const [mode, setMode] = useState<"oneShot" | "loop">("oneShot");
  return (
    <div style={{ width: "320px" }}>
      <Section title="Playback" note="Values commit on Enter, blur or an arrow step.">
        <FieldRow label="Volume" unit="dB">
          <NumberBox label="Volume" value={gain} min={-96} max={12} step={0.5} digits={1} onValue={setGain} />
        </FieldRow>
        <FieldRow label="Plays">
          <SelectBox<"oneShot" | "loop"> label="Plays" value={mode} options={[{ value: "oneShot", label: "One-shot" }, { value: "loop", label: "Loop" }]} onValue={setMode} />
        </FieldRow>
      </Section>
    </div>
  );
}

const meta: Meta = { title: "Kit/Panel fields", component: Panel };
export default meta;

export const Rows: StoryObj = {
  render: () => <Panel />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByRole("textbox", { name: "Volume" }) as HTMLInputElement;
    await userEvent.click(box);
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(box).toHaveValue("-5.5")); // the box shows the value after the re-render
    await userEvent.clear(box);
    await userEvent.type(box, "40{Enter}");
    await waitFor(() => expect(box).toHaveValue("12")); // clamped to the range
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Plays" }), "loop");
    await expect((c.getByRole("combobox", { name: "Plays" }) as HTMLSelectElement).value).toBe("loop");
  },
};
