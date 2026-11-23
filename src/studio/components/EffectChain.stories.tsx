// Stories (ADR 0219, 0349) for the effect chain: a bus chain (add from the alphabetical menu, the new card opens;
// bypass, reorder, remove), a sidechain keyed on Dialogue, an automated parameter, a full chain, a clip (voice) chain
// and a refusal reported by the owner.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import { defaultEffect, registerPluginEffects } from "../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../engine/audio/effects/pluginEffects";
import type { Effect, EffectLevel } from "../../engine/audio/effects/types";
import type { AudioPluginDebug } from "../../plugins/audio/runtime/debugTypes";
import { EffectChain } from "./EffectChain";

function Demo(props: { level: EffectLevel; start: Effect[]; limit?: number; automated?: Record<string, Record<string, string>>; exclude?: readonly string[] }) {
  const [effects, setEffects] = useState<Effect[]>(props.start);
  const [log, setLog] = useState<string[]>([]);
  return (
    <div style={{ width: "360px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <EffectChain
        title={props.level === "bus" ? "Bus effects" : "Clip effects"}
        note={props.level === "bus" ? "Inserts run top to bottom, before the fader" : "Runs on this clip's voice"}
        level={props.level}
        effects={effects}
        limit={props.limit}
        ownBus="Music"
        keyBuses={["SFX", "Dialogue", "Ambience"]}
        automated={props.automated}
        exclude={props.exclude}
        onAutomate={(id) => setLog((l) => [...l, `automate ${id}`])}
        onAutomateMenu={(id) => setLog((l) => [...l, `automation menu ${id}`])}
        onEdit={(result, label, drag) => {
          if ("refused" in result) return setLog((l) => [...l, `Can't ${label.toLowerCase()}: ${result.refused}`]);
          setEffects(result.next);
          if (!drag) setLog((l) => [...l, label]);
        }}
      />
      <ol data-testid="log" style={{ fontSize: "11px" }}>
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </div>
  );
}

const busChain = (): Effect[] => [{ ...defaultEffect("highpass", "fx1"), params: { cutoff: 120, resonance: 0.1, drive: 0 } }, { ...defaultEffect("compressor", "fx2"), params: { threshold: -20, ratio: 3, attack: 10, release: 120, makeup: 0 } }];

const meta: Meta = { title: "Studio/EffectChain", component: EffectChain };
export default meta;

export const BusChain: StoryObj = {
  render: () => <Demo level="bus" start={busChain()} limit={8} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Add effect" }));
    const menu = within(document.body).getByRole("menu", { name: "Add effect" });
    // The built-ins (before any plugin group) are alphabetical.
    const children = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')];
    const sep = children.findIndex((e) => e.getAttribute("role") === "separator");
    const labels = (sep < 0 ? children : children.slice(0, sep)).map((b) => b.textContent ?? "");
    await expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Limiter/ }));
    await expect(c.getByRole("button", { name: "Collapse Limiter" })).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Move Limiter up" }));
    await expect(c.getByTestId("log")).toHaveTextContent("Move Limiter up");
    await userEvent.click(c.getAllByRole("button", { name: /^On$/ })[0]!);
    await expect(c.getByTestId("log")).toHaveTextContent("Bypass High-pass");
  },
};

export const Sidechain: StoryObj = { render: () => <Demo level="bus" start={[{ ...defaultEffect("sidechainCompressor", "fx1"), key: "Dialogue" }]} /> };

export const Automated: StoryObj = { render: () => <Demo level="bus" start={[defaultEffect("lowpass", "fx1")]} automated={{ fx1: { cutoff: "800 Hz" } }} /> };

export const Full: StoryObj = { render: () => <Demo level="bus" start={busChain()} limit={2} /> };

export const ClipChain: StoryObj = { render: () => <Demo level="voice" start={[defaultEffect("envelope", "fx1"), defaultEffect("pitchShift", "fx2")]} /> };

/** A Playlists Clip's chain (instance level, decisions.md): no Delay or Reverb offered; Automate's right-click is the owner's menu. */
export const ClipPlaylistChain: StoryObj = {
  render: () => <Demo level="instance" start={[defaultEffect("lowpass", "fx1")]} exclude={["delay", "reverb"]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Add effect" }));
    const menu = within(document.body).getByRole("menu", { name: "Add effect" });
    await expect(within(menu).queryByRole("menuitem", { name: /^Delay/ })).toBeNull();
    await expect(within(menu).queryByRole("menuitem", { name: /^Reverb/ })).toBeNull();
    await expect(within(menu).getByRole("menuitem", { name: /^Chorus/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByRole("button", { name: "Automate Low-pass" }) });
    await expect(c.getByTestId("log")).toHaveTextContent("automation menu fx1");
  },
};

export const WrongLevel: StoryObj ={ render: () => <Demo level="bus" start={[defaultEffect("gain", "fx1")]} /> };

export const Empty: StoryObj = { render: () => <Demo level="instance" start={[]} /> };

// ADR 0352 §9 (B6): plugin effects in Add effect, after the built-ins, under their plugin's title; a plugin card gets
// its health from the rows the owner passes (else the runtime's own) and its Reset plugin.
registerPluginEffects({
  plugin: "example.tremolo", title: "Tremolo", version: "1.0.0", enabled: true,
  effects: parsePluginAudio(
    { modules: { dsp: { wasm: "dsp/tremolo.wasm" } }, effects: [{ type: "example.tremolo", module: "dsp", kind: 0, label: "Tremolo", levels: ["sample", "instance", "bus"], budget: { instructionsPerFrame: 300 }, params: [{ name: "rate", label: "Rate", min: 0.1, max: 20, default: 5, unit: "Hz" }, { name: "shape", label: "Shape", choices: ["Sine", "Triangle", "Square"], default: 0 }] }] },
    { name: "example.tremolo", title: "Tremolo", version: "1.0.0" },
    [],
  ).effects,
});

const chainResets = fn();

export const PluginGroups: StoryObj = {
  render: () => (
    <div style={{ width: "360px" }}>
      <PluginDemo />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Add effect" }));
    const menu = within(document.body).getByRole("menu", { name: "Add effect" });
    const heading = within(menu).getByRole("menuitem", { name: "Tremolo" });
    await expect(heading).toBeDisabled();
    const item = within(menu).getAllByRole("menuitem").find((b) => b.textContent === "TremoloTremolo")!;
    await userEvent.click(item);
    await expect(c.getByRole("button", { name: "Collapse Tremolo" })).toBeVisible();
    await expect(c.getByLabelText("Tremolo health")).toHaveTextContent("Live · 0 of 300 instructions per frame · 64 KB · over budget ×1");
    await expect(c.getByRole("status")).toHaveTextContent("Faulted: over budget ×1; those blocks passed through dry");
    await userEvent.click(c.getByRole("button", { name: "Reset plugin" }));
    await expect(chainResets).toHaveBeenCalledWith("example.tremolo");
  },
};

function PluginDemo() {
  const [effects, setEffects] = useState<Effect[]>([]);
  const health: AudioPluginDebug[] = [{
    plugin: "example.tremolo", type: "example.tremolo", module: "dsp", e: 0, state: "live", warmUps: 1, instances: 32, inUse: 1,
    instructionsPerQuantum: 0, faults: { trap: 0, budget: 1, grow: 0, nonFinite: 0, range: 0 }, starved: 0, noInstance: 0, memoryBytes: 65536,
  }];
  return <EffectChain level="bus" effects={effects} pluginHealth={health} onResetPlugin={chainResets} onEdit={(r) => "next" in r && setEffects(r.next)} />;
}
