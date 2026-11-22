// Stories (ADR 0219, 0335) for the game parameters panel: numeric sliders and labelled selects with test values and a
// reset to the default, and the empty state.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { ParameterDef } from "../../engine/audio/eventFormat";
import { ParameterPanel } from "./ParameterPanel";
import { withTestValue } from "./parameterPanelModel";

const params: ParameterDef[] = [
  { name: "threat", min: 0, max: 1, default: 0, seekSpeed: 0 },
  { name: "health", min: 0, max: 100, default: 100, seekSpeed: 0 },
  { name: "depth", min: 0, max: 30, default: 0, seekSpeed: 0 },
  { name: "gameState", labels: ["Playing", "Paused", "Cutscene", "Loading"], default: "Playing" },
  { name: "inCombat", labels: ["Off", "On"], default: "Off" },
];

function Demo(props: { parameters: ParameterDef[] }) {
  const [values, setValues] = useState<Record<string, number>>({ threat: 0.4 });
  return (
    <div style={{ width: "340px" }}>
      <ParameterPanel parameters={props.parameters} values={values} units={{ health: "%", depth: "m" }} onValue={(name, v) => setValues(withTestValue(values, name, v))} />
    </div>
  );
}

const meta: Meta = { title: "Studio/ParameterPanel", component: ParameterPanel };
export default meta;

export const TestValues: StoryObj = {
  render: () => <Demo parameters={params} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Reset threat" }));
    await expect(c.getByLabelText("threat value")).toHaveValue("0");
    await userEvent.selectOptions(c.getByRole("combobox", { name: "gameState" }), "Paused");
    await expect(c.getByRole("button", { name: "Reset gameState" })).toBeEnabled();
  },
};

export const Empty: StoryObj = { render: () => <Demo parameters={[]} /> };
