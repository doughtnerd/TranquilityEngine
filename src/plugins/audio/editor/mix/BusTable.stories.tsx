// Stories (ADR 0219) for the profiler's bus table (Pf5): one row per bus with a cell per gain lane flagged unity or
// active, the product and the product up the tree, a mute as silence, a tombstone as removed, a bus the capture never
// named by its slot, and the empty state. Rendered through its real props: the one table section (ADR 0326) with the bus
// table's columns and the kit's table of a keyframe's buses.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect } from "storybook/test";
import type { CaptureKeyframe, CaptureKeyframeBus } from "../../runtime/capture/reader";
import { BUS_TABLE } from "./BusTable";
import { TableSection } from "./ProfilerTableSection";
import { busParents, busTableRows, profilerTable, tableEmptyText, type BusRow } from "./profilerTablesModel";
import { namesFromStart } from "../../runtime/capture/testSupport";

const EMPTY_MIX = { slotTableVersion: 1, monitorActive: false, targetIndex: 0, snapshot: null, masterVolume: 1, hiddenMute: false };
const keyframe = (over: Partial<CaptureKeyframe> = {}): CaptureKeyframe => ({ voices: [], buses: [], metered: [], events: [], music: [], mix: EMPTY_MIX, ...over });
/** A bus row at unity whose authored lane sits at `authored` (value and target), with the given flags. */
const bus = (slot: number, { authored = 1, ...over }: Partial<CaptureKeyframeBus> & { authored?: number } = {}): CaptureKeyframeBus => {
  const at = (g: number) => ({ value: g, target: g });
  return {
    slot, gen: 1, lanes: { authored: at(authored), runtime: at(1), snapshot: at(1), monitor: at(1), dip: at(1) }, duck: 1, automation: 1,
    authoredMute: false, runtimeMute: false, monitorMute: false, monitorSolo: false, tombstone: false, metered: false, ...over,
  };
};
const NAMES = namesFromStart({ buses: [[0, "Master"], [1, "Music"], [2, "SFX"]] });
const parents = busParents({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Music" }] }, NAMES, 0);
const SEEK = { ready: true, playing: false, truncated: false, beforeFirstKeyframe: false };
const tableOf = (buses: CaptureKeyframeBus[]) => profilerTable("buses", busTableRows(keyframe({ buses }), NAMES, 0, parents), "", SEEK);

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".pgrid-row")];
const cells = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".pgrid-cell")];

const meta = {
  title: "Audio/Profiler/Bus table",
  component: TableSection<BusRow>,
  args: { columns: BUS_TABLE, table: tableOf([bus(1, { authored: 0.5 })]) },
} satisfies Meta<typeof TableSection<BusRow>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OneBus: Story = {
  play: async ({ canvasElement }) => {
    expect(rows(canvasElement)).toHaveLength(1);
    const c = cells(rows(canvasElement)[0]!);
    expect(c).toHaveLength(1 + 7 + 2);
    expect(c.map((x) => x.dataset.flag)).toEqual([undefined, "active", "unity", "unity", "unity", "unity", "unity", "unity", "active", "active"]);
    expect(c[0]).toHaveTextContent("Music");
    expect(c[1]).toHaveTextContent("-6.0 dB");
    expect(c[8]).toHaveTextContent("-6.0 dB");
    expect([...canvasElement.querySelectorAll("[role=columnheader]")].map((n) => n.textContent)).toEqual(
      ["Bus", "Authored", "Runtime", "Snapshot", "Monitor", "Dip", "Duck", "Automation", "Product", "To output"],
    );
  },
};

export const MutedRemovedAndUnnamed: Story = {
  args: { table: tableOf([bus(1, { authoredMute: true }), bus(2, { tombstone: true }), bus(7)]) },
  play: async ({ canvasElement }) => {
    expect(rows(canvasElement).map((r) => r.dataset.state)).toEqual(["active", "removed", "unity"]);
    expect(cells(rows(canvasElement)[0]!).at(-2)).toHaveTextContent("-inf dB"); // a mute is silence
    expect(cells(rows(canvasElement)[1]!)[0]).toHaveTextContent("SFX (removed)");
    expect(cells(rows(canvasElement)[2]!)[0]).toHaveTextContent("bus 7");
  },
};

export const Empty: Story = {
  args: { table: tableOf([]) },
  play: async ({ canvasElement, args }) => {
    expect(args.table.empty).toBe("none");
    expect(canvasElement.querySelector(".ptable-empty")).toHaveTextContent(tableEmptyText("buses", "none"));
    expect(canvasElement.querySelector("[role=grid]")).toBeNull();
  },
};
