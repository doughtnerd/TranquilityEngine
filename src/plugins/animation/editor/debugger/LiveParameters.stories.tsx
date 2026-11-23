// Stories (ADR 0219) for the live parameter panel (ADR 0373 "the parameter panel is live and editable"; T52): live
// values per type, edits sent through `onSet` (the debugger routes them to `Animator.set`), a refused edit's reason,
// request lifetimes, and a recorded frame (read-only).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { editValue, type LiveParameterRow } from "./liveParameterLogic";
import { LiveParameters } from "./LiveParameters";
import "./debugger.css";

const rows: LiveParameterRow[] = [
  { name: "speed", type: "float", value: 1.25, set: true, computed: false },
  { name: "combo", type: "int", value: 2, set: true, computed: false },
  { name: "grounded", type: "bool", value: true, set: false, computed: false },
  { name: "aim", type: "vec2", value: [0.5, -0.25], set: true, computed: false },
  { name: "target", type: "node", value: null, set: false, computed: false },
];
const onSet = fn((name: string, input: string | boolean | readonly number[]) => {
  const r = editValue(rows.find((x) => x.name === name)!.type, input);
  return "refused" in r ? r.refused : null;
});

const meta = {
  title: "Animation/Debugger/Live Parameters",
  render: (args: { past: boolean }) => (
    <div style={{ width: "260px" }}>
      <LiveParameters rows={rows} onSet={onSet} past={args.past} requests={[{ name: "Jump", life: 0.15 }, { name: "Crouch", life: 0 }]} />
    </div>
  ),
  args: { past: false },
} satisfies Meta<{ past: boolean }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Live: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    onSet.mockClear();
    expect(c.getByLabelText("speed live value")).toHaveValue("1.250");
    await userEvent.click(c.getByLabelText("grounded live value"));
    expect(onSet).toHaveBeenLastCalledWith("grounded", false);
    const speed = c.getByLabelText("speed live value");
    await userEvent.clear(speed);
    await userEvent.type(speed, "2.5{Enter}");
    expect(onSet).toHaveBeenLastCalledWith("speed", "2.5");
    const combo = c.getByLabelText("combo live value");
    await userEvent.clear(combo);
    await userEvent.type(combo, "1.5{Enter}");
    expect(c.getByRole("alert").textContent).toBe("an int parameter takes a whole number");
    expect(c.getByText("set from code")).toBeTruthy();
    expect(c.getByLabelText("Request Jump: 0.15 s left")).toBeTruthy();
    expect(c.getByLabelText("Request Crouch: not live")).toBeTruthy();
  },
};

export const RecordedFrame: Story = {
  args: { past: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText(/recorded frame/)).toBeTruthy();
    expect(c.getByLabelText("speed live value")).toBeDisabled();
    expect(c.getByLabelText("grounded live value")).toBeDisabled();
  },
};
