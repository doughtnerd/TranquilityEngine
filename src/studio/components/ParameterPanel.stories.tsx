// Stories (ADR 0219, 0349) for the game parameters panel: numeric sliders and labelled selects with test values and a
// reset to the default, and the empty state.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { ParameterDef } from "../../engine/audio/parameters";
import { NewParameterDialog } from "./NewParameterDialog";
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

/** J4.1: with `onNewParameter`, a project with none offers "+ New parameter…" under the empty line, and under the rows. */
function NewProjectDemo() {
  const [list, setList] = useState<ParameterDef[]>([]);
  const [open, setOpen] = useState(false);
  return (
    <div style={{ width: "340px" }}>
      <ParameterPanel parameters={list} values={{}} onValue={() => {}} onNewParameter={() => setOpen(true)} />
      {open && <NewParameterDialog existing={list.map((p) => p.name)} onCancel={() => setOpen(false)} onCreate={(d) => { setList([...list, d]); setOpen(false); }} />}
    </div>
  );
}

export const EmptyWithNewParameter: StoryObj = {
  render: () => <NewProjectDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("No game parameters yet.")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "New parameter…" }));
    const dialog = within(within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "New parameter" }));
    await userEvent.click(dialog.getByRole("button", { name: "Create" }));
    await expect(c.getByLabelText("Parameter value")).toBeVisible();
    await expect(c.getByText("Parameter")).toBeVisible();
    await expect(c.getByRole("button", { name: "New parameter…" })).toBeVisible();
  },
};
