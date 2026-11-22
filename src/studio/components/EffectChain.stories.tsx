// Stories (ADR 0219, 0335) for the effect chain: a bus chain (add from the alphabetical menu, the new card opens;
// bypass, reorder, remove), a sidechain keyed on Dialogue, an automated parameter, a full chain, a clip (voice) chain
// and a refusal reported by the owner.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { defaultEffect } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel } from "../../engine/audio/effects/types";
import { EffectChain } from "./EffectChain";

function Demo(props: { level: EffectLevel; start: Effect[]; limit?: number; automated?: Record<string, Record<string, string>> }) {
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
        onAutomate={(id) => setLog((l) => [...l, `automate ${id}`])}
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
    await userEvent.click(c.getByRole("button", { name: "+ Add effect" }));
    const menu = within(document.body).getByRole("menu", { name: "Add effect" });
    const labels = within(menu).getAllByRole("menuitem").map((b) => b.textContent ?? "");
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

export const WrongLevel: StoryObj = { render: () => <Demo level="bus" start={[defaultEffect("gain", "fx1")]} /> };

export const Empty: StoryObj = { render: () => <Demo level="instance" start={[]} /> };
