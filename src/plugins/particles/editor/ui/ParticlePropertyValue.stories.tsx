// Stories (ADR 0219) for the particle property value field (ADR 0290), the one the Blackboard and the Inspector's
// ParticleSystem section share: each type's control, the type's default for a value that doesn't read as it, and the
// SDK's report rule (ADR 0282): a colour pick or a curve drag reports with `drag`, its end reports the last value with
// `drag` false, a typed value is one report with `drag` false. Each story keeps the value in state and lists the reports.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, userEvent, within } from "storybook/test";
import type { GraphInputValue, GraphPropertyType } from "../../../../engine/scene/particleGraph";
import { ParticlePropertyValue } from "./ParticlePropertyValue";

function Demo(props: { type: GraphPropertyType; value: unknown }) {
  const [value, setValue] = useState<unknown>(props.value);
  const [lines, setLines] = useState<string[]>([]);
  return (
    <div style={{ width: 260 }}>
      <ParticlePropertyValue
        type={props.type}
        label="Fade"
        value={value}
        onValue={(v: GraphInputValue, drag) => {
          setValue(v);
          setLines((l) => [...l, `${JSON.stringify(v)} ${drag ? "drag" : "end"}`]);
        }}
      />
      <ol aria-label="Reports">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </div>
  );
}

const meta = {
  title: "Particles/Property value",
  component: Demo,
  args: { type: "number", value: 2 },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

const reports = (c: ReturnType<typeof within>) => [...c.getByRole("list", { name: "Reports" }).querySelectorAll("li")].map((li) => li.textContent);

export const NumberTyped: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const box = c.getByLabelText("Fade") as HTMLInputElement;
    await step("a typed number is one report that closes its own step", async () => {
      await userEvent.clear(box);
      await userEvent.type(box, "5");
      await userEvent.tab();
      expect(reports(c)).toEqual(["5 end"]);
    });
    await step("a number property can be random between two numbers, as on the Blackboard", async () => {
      await userEvent.selectOptions(c.getByLabelText("Fade mode"), "random");
      expect(reports(c).at(-1)).toMatch(/^\{"random":\[.*\]\} end$/);
      expect(c.getByLabelText("Fade min")).toBeInTheDocument();
    });
  },
};

export const VectorAxes: Story = {
  args: { type: "vector3", value: [1, 2, 3] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const y = c.getByLabelText("Fade y") as HTMLInputElement;
    await userEvent.clear(y);
    await userEvent.type(y, "7");
    await userEvent.tab();
    expect(reports(c)).toEqual(["[1,7,3] end"]);
  },
};

export const ColorPick: Story = {
  args: { type: "color", value: "#ff0000" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const picker = c.getByLabelText("Fade") as HTMLInputElement;
    // A pick moves through `input` events and ends with `change`, as the browser's picker does.
    for (const v of ["#00ff00", "#0000ff"]) {
      picker.value = v;
      await fireEvent.input(picker);
    }
    await fireEvent.change(picker);
    expect(reports(c)).toEqual(['"#00ff00" drag', '"#0000ff" drag', '"#0000ff" end']);
  },
};

export const CurveDrag: Story = {
  // Not a curve: the field shows the curve property's default (flat at 1), as a new property has.
  args: { type: "curve", value: 3 },
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Edit Fade curve" }));
    const keys = canvasElement.querySelectorAll<SVGCircleElement>("circle.curve-key");
    expect(keys).toHaveLength(2);
    await step("dragging a key reports each move with drag, and the release reports the last one again", async () => {
      const key = keys[1];
      const box = key.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      await fireEvent.pointerDown(key, { pointerId: 1, button: 0, buttons: 1, clientX: x, clientY: y });
      await fireEvent.pointerMove(key, { pointerId: 1, buttons: 1, clientX: x, clientY: y + 10 });
      await fireEvent.pointerMove(key, { pointerId: 1, buttons: 1, clientX: x, clientY: y + 20 });
      await fireEvent.pointerUp(key, { pointerId: 1, button: 0, clientX: x, clientY: y + 20 });
      const lines = reports(c);
      expect(lines).toHaveLength(3);
      expect(lines.slice(0, 2).every((l) => l?.startsWith('{"curve":') && l.endsWith(" drag"))).toBe(true);
      expect(lines[2]).toBe(lines[1]!.replace(/ drag$/, " end"));
    });
  },
};
