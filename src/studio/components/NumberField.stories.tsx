// Stories (ADR 0219, 0349) for the Studio's number fields: a NumberField whose label scrubs (2 px a step, Shift ×10,
// Alt fine, Escape puts it back, one undo step per drag), typed values that clamp, a SliderField pairing a slider with
// its typed field, a themed checkbox, and plain inputs the Studio styles with no work of their own (and whose labels
// scrub through `installLabelScrub`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useEffect, useRef, useState } from "preact/hooks";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { Checkbox } from "./Checkbox";
import { installLabelScrub } from "./labelScrub";
import { NumberField } from "./NumberField";
import { SliderField } from "./SliderField";

const meta: Meta = { title: "Studio/NumberField", component: NumberField };
export default meta;

function FieldDemo() {
  const [v, setV] = useState(10);
  const [log, setLog] = useState<string[]>([]);
  return (
    <div style={{ width: "320px" }}>
      <div class="studio-fieldrow">
        <NumberField label="Crossfade" unit="ms" value={v} min={0} max={100} step={1} onValue={(n, drag) => (setV(n), setLog((l) => [...l, `${n}${drag ? " drag" : ""}`]))} />
      </div>
      <output aria-label="Value">{v}</output>
      <output aria-label="Commits">{log.filter((l) => !l.endsWith("drag")).length}</output>
    </div>
  );
}

/** Press `el` at `from`, move 4 px (past the dead zone, where the scrub starts), then `delta` px further. */
const drag = (el: Element, from: number, delta: number, mods: { shiftKey?: boolean; altKey?: boolean } = {}) => {
  const r = el.getBoundingClientRect();
  const y = r.top + r.height / 2;
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from, clientY: y });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + 4, clientY: y, ...mods });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + 4 + delta, clientY: y, ...mods });
};

export const LabelScrub: StoryObj = {
  render: () => <FieldDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const label = c.getByText("Crossfade");
    await waitFor(() => expect(label).toHaveAttribute("title", "Drag left or right to change (Shift ×10, Alt fine)"));
    const x = label.getBoundingClientRect().left + 5;
    drag(label, x, 20); // past the 3 px dead zone, then 20 px: 10 steps
    fireEvent.pointerUp(label, { pointerId: 1 });
    await waitFor(() => expect(c.getByLabelText("Value")).toHaveTextContent("20"));
    await waitFor(() => expect(c.getByLabelText("Commits")).toHaveTextContent("1")); // one undo step for the whole drag
    drag(label, x, 20, { shiftKey: true });
    await waitFor(() => expect(c.getByLabelText("Value")).toHaveTextContent("100")); // clamped to max
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(c.getByLabelText("Value")).toHaveTextContent("20")); // Escape puts it back
    fireEvent.pointerUp(label, { pointerId: 1 });
  },
};

export const Typed: StoryObj = {
  render: () => <FieldDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByRole("textbox", { name: "Crossfade" });
    await userEvent.clear(box);
    await userEvent.type(box, "250{Enter}");
    await waitFor(() => expect(c.getByLabelText("Value")).toHaveTextContent("100")); // clamped
    await userEvent.type(box, "{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => expect(c.getByLabelText("Value")).toHaveTextContent("90"));
    await waitFor(() => expect(getComputedStyle(box).textAlign).toBe("right"));
    await waitFor(() => expect(getComputedStyle(box).width).toBe("76px"));
  },
};

function SliderDemo() {
  const [v, setV] = useState(-6);
  return (
    <div style={{ width: "360px" }}>
      <SliderField label="Volume" unit="dB" value={v} min={-60} max={6} step={0.5} onValue={(n) => setV(n)} />
      <output aria-label="Value">{v}</output>
    </div>
  );
}

export const Slider: StoryObj = {
  render: () => <SliderDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByRole("textbox", { name: "Volume value" });
    await userEvent.clear(box);
    await userEvent.type(box, "−12{Enter}");
    await waitFor(() => expect(c.getByLabelText("Value")).toHaveTextContent("-12"));
    await waitFor(() => expect(c.getByRole("slider", { name: "Volume" })).toHaveAttribute("aria-valuetext", "−12.0 dB"));
  },
};

function CheckDemo() {
  const [v, setV] = useState<boolean | "mixed">("mixed");
  return <Checkbox checked={v} label="Loop" onChange={setV} />;
}

export const Check: StoryObj = {
  render: () => <CheckDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByRole("checkbox", { name: "Loop" });
    await waitFor(() => expect(box).toHaveAttribute("aria-checked", "mixed"));
    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    await waitFor(() => expect(getComputedStyle(box).width).toBe("16px"));
  },
};

/** Plain inputs in a screen: styled by formControls.css, and their labels scrub through `installLabelScrub`. */
function PlainDemo() {
  const root = useRef<HTMLDivElement>(null);
  const [committed, setCommitted] = useState("4");
  useEffect(() => installLabelScrub(root.current!), []);
  return (
    <div ref={root} style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "6px 8px", width: "320px", alignItems: "center" }}>
      <label for="plain-max">Max instances</label>
      <input id="plain-max" type="number" min="1" max="16" step="1" value={committed} onChange={(e) => setCommitted((e.currentTarget as HTMLInputElement).value)} />
      <span>Name</span>
      <input type="text" placeholder="Engine loop" />
      <span>Note</span>
      <textarea placeholder="Shown on hover" />
      <span>Mode</span>
      <select>
        <option>Whole</option>
        <option>Loop</option>
      </select>
      <output aria-label="Committed">{committed}</output>
    </div>
  );
}

export const PlainInputs: StoryObj = {
  render: () => <PlainDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const label = c.getByText("Max instances");
    await new Promise((r) => setTimeout(r, 50)); // the demo installs the scrubber in an effect
    const x = label.getBoundingClientRect().left + 5;
    fireEvent.pointerOver(label);
    await waitFor(() => expect(label).toHaveAttribute("title", "Drag left or right to change (Shift ×10, Alt fine)"));
    drag(label, x, 10);
    fireEvent.pointerUp(label, { pointerId: 1 });
    await waitFor(() => expect(c.getByLabelText("Committed")).toHaveTextContent("9")); // 4 + 5 steps, committed once on release
    const text = c.getByPlaceholderText("Engine loop");
    await waitFor(() => expect(getComputedStyle(text).fontSize).toBe("12px"));
    await waitFor(() => expect(getComputedStyle(text).borderTopLeftRadius).toBe("3px"));
    await waitFor(() => expect(getComputedStyle(c.getByPlaceholderText("Shown on hover")).resize).toBe("vertical"));
  },
};
