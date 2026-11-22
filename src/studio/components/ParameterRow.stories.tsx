// Stories (ADR 0219, 0335) for the parameter row: a log frequency (typed "2.4k" reads as 2400 Hz), a linear gain with
// arrow keys, a value driven by automation, and the label scrub (drag the label; Shift ×10, Alt fine).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { effectParamSpec } from "../../engine/audio/effects/catalogue";
import { ParameterRow } from "./ParameterRow";
import type { ParamSpec } from "./parameterRowModel";

const cutoff = effectParamSpec("lowpass", "cutoff")!;
const gain = effectParamSpec("gain", "gain")!;

function Demo(props: { spec: ParamSpec; start: number; disabled?: boolean; note?: string }) {
  const [v, setV] = useState(props.start);
  return (
    <div style={{ width: "340px" }}>
      <ParameterRow spec={props.spec} value={v} disabled={props.disabled} note={props.note} title={props.disabled ? "Automated by depth" : undefined} onValue={(n) => setV(n)} />
      <p data-testid="value">{v}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/ParameterRow", component: ParameterRow };
export default meta;

export const LogFrequency: StoryObj = {
  render: () => <Demo spec={cutoff} start={800} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByLabelText("Cutoff value");
    await userEvent.clear(box);
    await userEvent.type(box, "2.4k");
    await userEvent.tab();
    await expect(c.getByTestId("value")).toHaveTextContent("2400");
  },
};

export const LinearGain: StoryObj = {
  render: () => <Demo spec={gain} start={0} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    c.getByLabelText("Gain value").focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await expect(c.getByTestId("value")).toHaveTextContent("1");
  },
};

export const Automated: StoryObj = { render: () => <Demo spec={cutoff} start={800} disabled note="auto · 1.20 kHz" /> };
