// Stories (ADR 0219, 0349) for one effect card: closed with its summary, open with its parameters, bypassed, and an
// effect at a level it can't run at (kept with a warning so it can be moved).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import { defaultEffect, registerPluginEffects } from "../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../engine/audio/effects/pluginEffects";
import type { Effect, EffectLevel } from "../../engine/audio/effects/types";
import type { AudioPluginDebug } from "../../plugins/audio/runtime/debugTypes";
import { EffectCard } from "./EffectCard";

function Demo(props: { effect: Effect; level?: EffectLevel; open?: boolean; health?: AudioPluginDebug; onReset?: () => void }) {
  const [effect, setEffect] = useState(props.effect);
  const [open, setOpen] = useState(!!props.open);
  const [health, setHealth] = useState(props.health);
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
        pluginHealth={health ?? null}
        onResetPlugin={() => {
          props.onReset?.();
          // What the runtime reports after a reset: on again, the counts kept.
          if (health) setHealth({ ...health, state: "live", faults: { trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 } });
        }}
      />
    </div>
  );
}

/** A health row of `Audio.debug().plugins` for the tremolo (41 instructions a frame on one instance, 64 KB). */
const tremoloHealth = (over: Partial<AudioPluginDebug> = {}): AudioPluginDebug => ({
  plugin: "example.tremolo", type: "example.tremolo", module: "dsp", e: 0, state: "live", warmUps: 1, instances: 32, inUse: 1,
  instructionsPerQuantum: 41 * 128, faults: { trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 }, starved: 0, noInstance: 0, memoryBytes: 64 * 1024, ...over,
});

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

// ADR 0352 B2: a plugin effect's card comes out of the catalogue like a built-in's, from its plugin.json declaration
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
    await expect(c.getByRole("combobox", { name: "Shape" })).toBeVisible();
  },
};

// ADR 0352 §9 (B6): a `choices` parameter is a menu, not a slider; its value is the option's index.
export const ChoicesMenu: StoryObj = {
  render: () => <Demo effect={defaultEffect("example.tremolo", "fx1")} open />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const shape = c.getByRole("combobox", { name: "Shape" });
    await expect(shape).toHaveValue("0");
    await expect(within(shape).getAllByRole("option").map((o) => o.textContent)).toEqual(["Sine", "Triangle", "Square"]);
    await userEvent.selectOptions(shape, "Square");
    await expect(shape).toHaveValue("2");
    await expect(c.queryByRole("slider", { name: "Shape" })).toBeNull();
  },
};

// The plugin chip, and the health row when open: instructions per frame against the declared budget, memory, faults.
export const PluginHealthRow: StoryObj = {
  render: () => <Demo effect={defaultEffect("example.tremolo", "fx1")} health={tremoloHealth()} open />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Tremolo 1.0.0")).toBeVisible();
    await expect(c.getByLabelText("Tremolo health")).toHaveTextContent("Live · 41 of 1000 instructions per frame · 64 KB · no faults");
    await expect(c.queryByRole("status")).toBeNull();
    await expect(c.queryByRole("button", { name: "Reset plugin" })).toBeNull();
  },
};

const resets = fn();

// Off after three faults: the status line says why and Reset plugin turns it back on.
export const PluginFaulted: StoryObj = {
  render: () => <Demo effect={defaultEffect("example.tremolo", "fx1")} health={tremoloHealth({ state: "disabled", faults: { trap: 1, budget: 2, grow: 0, nonFinite: 0, range: 0 } })} onReset={resets} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("status")).toHaveTextContent("Off after three faults within a second (over budget ×2, trapped ×1): passes audio through until reset");
    await userEvent.click(c.getByRole("button", { name: "Reset plugin" }));
    await expect(resets).toHaveBeenCalledTimes(1);
    await expect(c.queryByRole("status")).toBeNull();
  },
};

// A plugin turned off in Project Settings > Plugins: the card is greyed, its effect kept and passing audio through.
registerPluginEffects({
  plugin: "example.wobble", title: "Wobble", version: "2.1.0", enabled: false,
  effects: parsePluginAudio({ modules: { dsp: { wasm: "w.wasm" } }, effects: [{ type: "example.wobble", module: "dsp", kind: 0, label: "Wobble", levels: ["bus"], params: [{ name: "amount", label: "Amount", min: 0, max: 1, default: 0.5 }] }] }, { name: "example.wobble", title: "Wobble", version: "2.1.0" }, []).effects,
});

export const PluginOff: StoryObj = {
  render: () => <Demo effect={defaultEffect("example.wobble", "fx1")} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(canvasElement.querySelector(".studio-fx")).toHaveAttribute("aria-disabled", "true");
    await expect(c.getByText("Wobble 2.1.0")).toBeVisible();
    await expect(c.getByRole("status")).toHaveTextContent("Passes audio through: its plugin, Wobble, is off in Project Settings > Plugins");
  },
};

// A type no installed plugin declares: kept as written, greyed, passing audio through.
export const PluginMissing: StoryObj = {
  render: () => <Demo effect={{ id: "fx1", type: "acme.gone", on: true, params: { mix: 0.4 } }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(canvasElement.querySelector(".studio-fx")).toHaveAttribute("aria-disabled", "true");
    await expect(c.getByRole("status")).toHaveTextContent("Passes audio through: no installed plugin declares that effect type");
  },
};
