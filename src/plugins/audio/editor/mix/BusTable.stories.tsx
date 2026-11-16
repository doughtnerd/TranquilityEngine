// Stories (ADR 0219) for the profiler's bus table (Pf5): one row per bus with a cell per gain lane flagged unity or
// active, the product and the product up the tree, a mute as silence, a tombstone as removed, a bus the capture never
// named by its slot, and the empty state. Rendered through its real props, the `busTableData` of a keyframe's buses.
// The same cases run headless in profilerTables.test.ts until the story tests have run green.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect } from "storybook/test";
import type { KeyframeBus, KeyframePayload } from "../../runtime/capture/format";
import { BusTable, busTableData } from "./BusTable";
import { busParents, busTableRows } from "./profilerTablesModel";
import { nameLookup } from "./voiceTableModel";

const EMPTY_MIX = { slotTableVersion: 1, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 };
const keyframe = (over: Partial<KeyframePayload> = {}): KeyframePayload => ({ voices: [], buses: [], metered: [], events: [], music: [], mix: EMPTY_MIX, ...over });
const bus = (slot: number, over: Partial<KeyframeBus> = {}): KeyframeBus => ({ slot, gen: 1, flags: 0, lanes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], duck: 1, automation: 1, ...over });
const NAMES = nameLookup({ clips: new Map(), buses: new Map([[0, "Master"], [1, "Music"], [2, "SFX"]]), events: new Map(), parameters: new Map(), snapshots: new Map(), targets: new Map() } as never);
const parents = busParents({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Music" }] }, [[0, "Master"], [1, "Music"], [2, "SFX"]]);
const CTX = { playing: false, truncated: false, beforeFirstKeyframe: false };
const dataOf = (buses: KeyframeBus[]) => busTableData(busTableRows(keyframe({ buses }), NAMES, parents), buses.length, "", CTX);

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".pgrid-row")];
const cells = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".pgrid-cell")];

const meta = {
  title: "Audio/Profiler/Bus table",
  component: BusTable,
  args: { data: dataOf([bus(1, { lanes: [0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 1] })]) },
} satisfies Meta<typeof BusTable>;
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
  args: { data: dataOf([bus(1, { flags: 1 }), bus(2, { flags: 1 << 4 }), bus(7)]) },
  play: async ({ canvasElement }) => {
    expect(rows(canvasElement).map((r) => r.dataset.state)).toEqual(["active", "removed", "unity"]);
    expect(cells(rows(canvasElement)[0]!).at(-2)).toHaveTextContent("-inf dB"); // a mute is silence
    expect(cells(rows(canvasElement)[1]!)[0]).toHaveTextContent("SFX (removed)");
    expect(cells(rows(canvasElement)[2]!)[0]).toHaveTextContent("bus 7");
  },
};

export const Empty: Story = {
  args: { data: dataOf([]) },
  play: async ({ canvasElement }) => {
    expect(canvasElement.querySelector(".ptable-empty")).toHaveTextContent("No bus data at the cursor");
    expect(canvasElement.querySelector("[role=grid]")).toBeNull();
  },
};
