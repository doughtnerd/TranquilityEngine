// Stories (ADR 0219, 0346, 0349) for the shared curve editor: time curves over a clip's waveform with a dope sheet,
// parameter curves over a histogram of the game's values, distance curves with Min/Max handles, an on/off lane, a
// Bézier key to edit, and the inline field that opens the dialog. Apply shows the result in units.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { Curve } from "../../../engine/core/curve";
import { CurveEditorDialog, type CurveEditorDialogProps } from "./CurveEditorDialog";
import { CurveField } from "./CurveField";
import type { CurveLane } from "./curveEditorModel";

const gain: CurveLane = { id: "gain", name: "Gain", unit: "dB", min: -48, max: 12, step: 0.5, color: 1, base: 0, curve: [[0, -48], [0.1, 0], [1.2, -3, "bezier", { in: [-0.3, 1], out: [0.3, -1] }], [2.4, -48]] };
const pitch: CurveLane = { id: "pitch", name: "Pitch", unit: "st", min: -24, max: 24, step: 0.1, color: 2, base: 0, curve: [[0, 0], [2.4, -2]] };
const pan: CurveLane = { id: "pan", name: "Pan", unit: "%", min: -100, max: 100, step: 1, color: 3, base: 0, curve: [] };
const lowpass: CurveLane = { id: "lp", name: "Low-pass", unit: "Hz", min: 200, max: 20000, step: 10, scale: "log", color: 4, base: 20000, curve: [[0, 20000], [1.1, 12000], [2.4, 2000, "smooth"]] };
const active: CurveLane = { id: "active", name: "Active", unit: "", min: 0, max: 1, step: 1, bool: true, color: 5, base: 1, curve: [[0, 1, "step"], [1.6, 0, "step"], [2.4, 0, "step"]] };

/** A decaying, grainy clip; with a Gain lane, the brighter shape is after the curve. */
const waveform: CurveEditorDialogProps["waveform"] = (t, values) => {
  const env = (t < 0.01 ? t / 0.01 : Math.exp(-t * 1.1)) * (0.35 + 0.65 * Math.abs(Math.sin(t * 37.1) * Math.sin(t * 11.3 + 1)));
  const g = values.gain === undefined ? 1 : Math.min(2, Math.pow(10, values.gain / 20));
  return [env, env * g];
};

function Demo(props: Omit<CurveEditorDialogProps, "onApply" | "onCancel">) {
  const [result, setResult] = useState("open");
  return (
    <div>
      <output aria-label="Result" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-code)", fontSize: "11px" }}>
        {result}
      </output>
      {result === "open" ? (
        <CurveEditorDialog {...props} onApply={(r) => setResult(JSON.stringify(r, null, 1))} onCancel={() => setResult("cancelled")} />
      ) : (
        <button type="button" onClick={() => setResult("open")}>
          Open again
        </button>
      )}
    </div>
  );
}

const meta: Meta = { title: "Kit/CurveEditorDialog", component: CurveEditorDialog };
export default meta;

export const TimeWithWaveform: StoryObj = {
  render: () => (
    <Demo
      kind="time"
      target="boost_tail"
      context="HoverBike / Boost · clip-local time"
      timeName="Sample time"
      length={2.4}
      playhead={0.6}
      lanes={[gain, pitch, pan, lowpass]}
      inputs={[{ id: "speed", name: "Speed", min: 0, max: 200, unit: "km/h", now: 80 }]}
      waveform={waveform}
    />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const dialog = await c.findByRole("dialog");
    await expect(within(dialog).getByRole("status")).toHaveTextContent("No changes yet");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await expect(c.getByLabelText("Result")).toHaveTextContent("cancelled");
  },
};

export const ParameterWithHistogram: StoryObj = {
  render: () => (
    <Demo
      kind="parameter"
      target="Bike impacts"
      context="Impact velocity → properties"
      parameter={{ name: "Impact velocity", min: 0, max: 127 }}
      now={38}
      band={[20, 60]}
      histogram={Array.from({ length: 40 }, (_, i) => Math.exp(-((i + 0.5) / 40) * 3.2) + 0.12 * Math.exp(-Math.pow(((i + 0.5) / 40 - 0.85) / 0.06, 2)))}
      lanes={[
        { ...gain, curve: [[0, -18], [127, 0]] },
        { ...pitch, curve: [[0, 2], [127, -2]] },
        { ...lowpass, curve: [[0, 4000], [76, 20000]] },
      ]}
    />
  ),
};

export const DistanceWithMinMax: StoryObj = {
  render: () => (
    <Demo
      kind="distance"
      target="Waterfall"
      context="Attenuation · metres from the listener"
      minDistance={2}
      maxDistance={40}
      now={12.4}
      listenerDensity={(d) => Math.min(1, Math.pow(d / 14, 2) * Math.exp(2 - (2 * d) / 14) * 0.9)}
      lanes={[
        { id: "volume", name: "Volume", unit: "dB", min: -60, max: 6, step: 0.5, base: 0, curve: [[0, 0], [2, 0], [12, -14], [40, -60]] },
        { id: "lowpass", name: "Low-pass", unit: "Hz", min: 200, max: 20000, step: 10, scale: "log", base: 20000, curve: [[2, 20000], [40, 3000]] },
        { id: "reverb", name: "Reverb send", unit: "%", min: 0, max: 100, step: 1, base: 10, curve: [[2, 12], [40, 60]] },
        { id: "spread", name: "Spread", unit: "°", min: 0, max: 360, step: 1, base: 0, curve: [[0, 360], [10, 90]] },
      ]}
    />
  ),
};

export const BoolLane: StoryObj = {
  render: () => <Demo kind="time" target="Chorus" context="Effect parameters over voice time" timeName="Voice time" length={2.4} initialLane="active" lanes={[active, { ...lowpass, name: "Rate", id: "rate", unit: "Hz", min: 0.1, max: 10, step: 0.01, curve: [[0, 0.5], [2.4, 4, "easeIn"]] }]} />,
};

export const BezierEditing: StoryObj = {
  render: () => <Demo kind="time" target="riser" context="Select the middle key to drag its handles; the toolbar's last-but-one button frees them" length={2.4} playhead={1.2} lanes={[gain]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const dialog = await c.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Gain key at 1\.20 s/ }));
    await expect(within(dialog).getByRole("button", { name: "Out handle" })).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: "In handle" })).toBeVisible();
  },
};

function FieldDemo() {
  const [curve, setCurve] = useState<Curve>([[0, 1], [5, 0.4, "smooth"], [10, 0.2]]);
  return (
    <div style={{ width: "280px" }}>
      <CurveField curve={curve} onChange={setCurve} xRange={[0, 10]} yRange={[0, 2]} interpolation label="Volume by speed" xName="Speed" />
      <output aria-label="Curve">{JSON.stringify(curve)}</output>
    </div>
  );
}

export const InlineField: StoryObj = { render: () => <FieldDemo /> };
