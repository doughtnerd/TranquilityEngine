// Stories (ADR 0219) for the SDK's slider and colour fields (ADR 0282) and their one commit rule: a gesture reports
// with `drag` while under way, its end reports the last value with `drag` false, and a typed value is one report with
// `drag` false. Each story keeps the value in state and lists every report, as a caller's undo would see them.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { ColorField, SliderField } from "./valueControls";

/** The reports as lines: the value, then "drag" or "end". */
function Reports(props: { lines: readonly string[] }) {
  return (
    <ol aria-label="Reports">
      {props.lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ol>
  );
}

function SliderDemo(props: { value: number; clamp?: boolean }) {
  const [value, setValue] = useState(props.value);
  const [lines, setLines] = useState<string[]>([]);
  return (
    <div>
      <SliderField
        label="Glow"
        min={0}
        max={1}
        step={0.01}
        clamp={props.clamp}
        value={value}
        onValue={(v, drag) => {
          setValue(v);
          setLines((l) => [...l, `${v} ${drag ? "drag" : "end"}`]);
        }}
      />
      <Reports lines={lines} />
    </div>
  );
}

function ColorDemo(props: { value: string; alpha?: boolean; showHex?: boolean }) {
  const [value, setValue] = useState(props.value);
  const [lines, setLines] = useState<string[]>([]);
  return (
    <div>
      <ColorField
        label="Tint"
        alpha={props.alpha}
        showHex={props.showHex}
        value={value}
        onValue={(v, drag) => {
          setValue(v);
          setLines((l) => [...l, `${v} ${drag ? "drag" : "end"}`]);
        }}
      />
      <Reports lines={lines} />
    </div>
  );
}

const meta = {
  title: "Editor/Value controls",
  component: SliderDemo,
  args: { value: 0.5 },
} satisfies Meta<typeof SliderDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

const reports = (c: ReturnType<typeof within>) => [...c.getByRole("list", { name: "Reports" }).querySelectorAll("li")].map((li) => li.textContent);

/** Move a range or colour input to `value` as a pointer drag does: `input` events, then `change` on release. */
async function drag(input: HTMLInputElement, values: readonly string[]) {
  for (const v of values) {
    input.value = v;
    await fireEvent.input(input);
  }
  await fireEvent.change(input);
}

export const SliderDrag: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const slider = c.getByRole("slider", { name: "Glow" }) as HTMLInputElement;
    const box = c.getByRole("spinbutton", { name: "Glow value" });
    await step("a drag reports each value with drag, and its release reports the last one again to close the step", async () => {
      await drag(slider, ["0.6", "0.7"]);
      expect(reports(c)).toEqual(["0.6 drag", "0.7 drag", "0.7 end"]);
      expect(box).toHaveValue(0.7);
    });
    await step("a typed number is one report that closes its own step", async () => {
      await userEvent.clear(box);
      await userEvent.type(box, "0.25");
      await userEvent.tab();
      expect(reports(c).at(-1)).toBe("0.25 end");
      await waitFor(() => expect(slider.value).toBe("0.25"));
    });
  },
};

export const SliderClamp: Story = {
  args: { value: 0.5, clamp: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByRole("spinbutton", { name: "Glow value" });
    // With `clamp`, a typed value is held to the slider's range; text that isn't a number puts the value back.
    await userEvent.clear(box);
    await userEvent.type(box, "5");
    await userEvent.tab();
    expect(reports(c)).toEqual(["1 end"]);
  },
};

export const ColorPick: StoryObj<typeof ColorDemo> = {
  render: (args) => <ColorDemo {...args} />,
  args: { value: "#00ff0080", alpha: true, showHex: true },
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const picker = c.getByLabelText("Tint") as HTMLInputElement;
    const alpha = c.getByRole("spinbutton", { name: "Tint alpha" });
    await step("the picker shows the colour without its opacity, the box and the text with it", async () => {
      expect(picker.value).toBe("#00ff00");
      expect(alpha).toHaveValue(0.502);
      expect(canvasElement.querySelector(".color-field-hex")).toHaveTextContent("#00ff0080");
    });
    await step("picking keeps the opacity, reporting drags while the picker is open and the end when it closes", async () => {
      await drag(picker, ["#ff0000"]);
      expect(reports(c)).toEqual(["#ff000080 drag", "#ff000080 end"]);
    });
    await step("a typed opacity is one report; at 1 the alpha is left out", async () => {
      await userEvent.clear(alpha);
      await userEvent.type(alpha, "0.25");
      await userEvent.tab();
      expect(reports(c).at(-1)).toBe("#ff000040 end");
      await userEvent.clear(alpha);
      await userEvent.type(alpha, "1");
      await userEvent.tab();
      expect(reports(c).at(-1)).toBe("#ff0000 end");
    });
  },
};

export const ColorWithoutAlphaBox: StoryObj<typeof ColorDemo> = {
  render: (args) => <ColorDemo {...args} />,
  args: { value: "#33669980" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // Without the box, a pick still keeps the value's opacity.
    expect(c.queryByRole("spinbutton")).toBeNull();
    await drag(c.getByLabelText("Tint") as HTMLInputElement, ["#ffffff"]);
    expect(reports(c)).toEqual(["#ffffff80 drag", "#ffffff80 end"]);
  },
};
