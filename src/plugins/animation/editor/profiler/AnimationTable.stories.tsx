// Stories (ADR 0219; written, not run here) for the Animation table in the Play Stats panel (T34): the rows the profiler
// shows for a busy crowd, a crowd mostly culled and LOD-skipped, and a World whose third-party node faulted. The table
// is the panel's own `PlayStatsTables` markup over `animationRows`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { PlayStatsTables } from "../../../../editor/ui/PlayStats";
import type { AnimationFrameStats } from "../../runtime/core/frameMeter";
import { animationRows } from "./profilerLogic";
import "../../../../editor/ui/playstats.css";

const base: AnimationFrameStats = {
  frames: 15, gatherMs: 0.2, evaluateMs: 1.4, applyMs: 0.4, instances: 64, active: 64, culled: 0, lodSkipped: 0, evaluated: 64, bones: 3200, skinned: 64, nodeFuel: 0, faults: 0,
};
const memory = { memoryBytes: 12 * 1024 * 1024, neededBytes: 9 * 1024 * 1024 };

function Table(props: { stats: AnimationFrameStats }) {
  return (
    <div class="play-stats" style={{ position: "static", width: 360 }} role="region" aria-label="Stats">
      <table>
        <tbody>
          <PlayStatsTables tables={[{ title: "Animation", rows: animationRows(props.stats, memory) }]} />
        </tbody>
      </table>
    </div>
  );
}

const meta = { title: "Animation/Profiler table", component: Table } satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Busy: Story = {
  args: { stats: base },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Animation")).toBeInTheDocument();
    await expect(c.getByText("Evaluate")).toBeInTheDocument();
    await expect(canvasElement.querySelector('[data-stat="Animation:Instances"]')?.textContent).toBe("64");
  },
};

export const CulledAndLodSkipped: Story = {
  args: { stats: { ...base, active: 20, culled: 44, lodSkipped: 8.5, evaluated: 11.5, bones: 575, skinned: 20, evaluateMs: 0.4 } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-stat="Animation:LOD skipped"]')?.textContent).toBe("8.5");
  },
};

export const NodeFaults: Story = {
  args: { stats: { ...base, nodeFuel: 2_400_000, faults: 3 } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-stat="Animation:Node faults"]')?.textContent).toBe("3");
    await expect(canvasElement.querySelector('[data-stat="Animation:Node fuel"]')?.textContent).toBe("2.4M");
  },
};
