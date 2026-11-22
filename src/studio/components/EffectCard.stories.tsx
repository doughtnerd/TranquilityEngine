// Stories (ADR 0219, 0335) for one effect card: closed with its summary, open with its parameters, bypassed, and an
// effect at a level it can't run at (kept with a warning so it can be moved).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { defaultEffect, registerPluginEffects } from "../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../engine/audio/effects/pluginEffects";
import type { Effect, EffectLevel } from "../../engine/audio/effects/types";
import { EffectCard } from "./EffectCard";

function Demo(props: { effect: Effect; level?: EffectLevel; open?: boolean }) {
  const [effect, setEffect] = useState(props.effect);
  const [open, setOpen] = useState(!!props.open);
  return (
    <div style={{ width: "360px" }}>
      <EffectCard
        effect={effect}
        level={props.level ?? "bus"}
        open={open}
        first
        last
        onOpen={setOpen}
        onParam={(name, value) => setEffect({ ...effect, params: { ...effect.params, [name]: value } })}
        onOn={(on) => setEffect({ ...effect, on })}
        onMove={() => {}}
        onRemove={() => {}}
        onAutomate={() => {}}
      />
    </div>
  );
}

const meta: Meta = { title: "Studio/EffectCard", component: EffectCard };
export default meta;

export const Closed: StoryObj = {
  render: () => <Demo effect={{ ...defaultEffect("lowpass", "fx1"), params: { cutoff: 800, resonance: 0.2, drive: 0 } }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("800 Hz · 0.20")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Expand Low-pass" }));
    await expect(c.getByRole("slider", { name: "Cutoff" })).toBeVisible();
  },
};

export const Open: StoryObj = { render: () => <Demo effect={defaultEffect("reverb", "fx1")} open /> };

export const Bypassed: StoryObj = { render: () => <Demo effect={{ ...defaultEffect("compressor", "fx1"), on: false }} /> };

export const WrongLevel: StoryObj = { render: () => <Demo effect={defaultEffect("pitchShift", "fx1")} level="bus" open /> };

// ADR 0338 B2: a plugin effect's card comes out of the catalogue like a built-in's, from its plugin.json declaration
// (here the tremolo sample's, inline: stories never import samples).
const TREMOLO_AUDIO = {
  modules: { dsp: { wasm: "dsp/tremolo.wasm", memoryMB: 1 } },
  effects: [{
    type: "example.tremolo", module: "dsp", kind: 0, label: "Tremolo", levels: ["sample", "instance", "bus"], cost: "light",
    params: [
      { name: "rate", label: "Rate", min: 0.1, max: 20, step: 0.01, unit: "Hz", default: 5, scale: "log" },
      { name: "depth", label: "Depth", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      { name: "shape", label: "Shape", choices: ["Sine", "Triangle", "Square"], default: 0 },
    ],
  }],
};
registerPluginEffects({ plugin: "example.tremolo", title: "Tremolo", version: "1.0.0", enabled: true, effects: parsePluginAudio(TREMOLO_AUDIO, { name: "example.tremolo", title: "Tremolo", version: "1.0.0" }, []).effects });

export const PluginEffect: StoryObj = {
  render: () => <Demo effect={{ ...defaultEffect("example.tremolo", "fx1"), params: { rate: 6, depth: 80, shape: 0 } }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Tremolo")).toBeVisible();
    await expect(c.getByText("6.00 Hz · 80 %")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Expand Tremolo" }));
    await expect(c.getByRole("slider", { name: "Rate" })).toBeVisible();
    await expect(c.getByRole("slider", { name: "Depth" })).toBeVisible();
    await expect(c.getByRole("slider", { name: "Shape" })).toBeVisible();
  },
};
