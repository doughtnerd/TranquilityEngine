// Stories (ADR 0219, 0352 §9) for the Profiler's Plugins panel: live plugin effect health, the rows that need attention
// first, Reset plugin on a faulted one; and the panel with nothing running.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { AudioPluginDebug } from "../../../plugins/audio/runtime/debugTypes";
import { PluginHealth } from "./PluginHealth";
import "./profiler.css";

const row = (type: string, over: Partial<AudioPluginDebug> = {}): AudioPluginDebug => ({
  plugin: type.split(".").slice(0, 2).join("."), type, module: "dsp", e: 0, state: "live", warmUps: 1, instances: 16, inUse: 2,
  instructionsPerQuantum: 2 * 41 * 128, faults: { trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 }, starved: 0, noInstance: 0, memoryBytes: 64 * 1024, ...over,
});

const BUDGETS: Record<string, number> = { "example.tremolo": 300, "acme.fx.crush": 200 };
const budgetOf = (type: string) => BUDGETS[type] ?? null;

const meta: Meta = { title: "Studio/Profiler/PluginHealth", component: PluginHealth };
export default meta;

const resets = fn();

export const Rows: StoryObj = {
  render: () => (
    <div style={{ width: "640px" }}>
      <PluginHealth rows={[row("example.tremolo"), row("acme.fx.crush", { state: "disabled", faults: { trap: 0, budget: 3, grow: 0, nonFinite: 0, range: 0 }, instructionsPerQuantum: 2 * 250 * 128, memoryBytes: 2 * 1024 * 1024 })]} budgetOf={budgetOf} onReset={resets} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const rows = c.getAllByRole("row").slice(1);
    // The faulted effect first: off after faults, over its budget, 2 MB.
    await expect(rows[0]).toHaveTextContent("acme.fx.crush");
    await expect(rows[0]).toHaveTextContent("Off after faults");
    await expect(rows[0]).toHaveTextContent("250 / 200");
    await expect(rows[0]).toHaveTextContent("2.0 MB");
    await expect(rows[0]).toHaveTextContent("over budget ×3");
    await expect(rows[1]).toHaveTextContent("41 / 300");
    await expect(within(rows[1]!).queryByRole("button")).toBeNull();
    await userEvent.click(c.getByRole("button", { name: "Reset plugin acme.fx.crush" }));
    await expect(resets).toHaveBeenCalledWith("acme.fx.crush");
  },
};

export const NothingRunning: StoryObj = {
  render: () => <PluginHealth rows={[]} onReset={() => {}} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/No plugin effects are running/)).toBeVisible();
  },
};
