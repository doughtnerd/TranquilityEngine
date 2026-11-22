// Stories (ADR 0219) for the profiler's tables region, the panel's `tables` slot (Pf5): the voice, bus, event and music
// tables under one filter, typing in the filter, the music rows with a pending transition, the event instances of a
// recorded scene, and the empty states (no cursor yet, nothing at the cursor, nothing matching). Rendered through its
// real props (`TablesSlotProps`: a source, a seek state, the cursor, no live follow).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, within } from "storybook/test";
import type { CaptureKeyframe, CaptureKeyframeBus, CaptureKeyframeMusic, CaptureSeekState } from "../../runtime/capture/reader";
import { SAMPLE_RATE } from "../../runtime/capture/testSupport";
import type { TablesSlotProps } from "./ProfilerPanel";
import type { ProfileSource } from "./profilerSource";
import { ProfilerTables } from "./profilerTables";
import { tableEmptyText } from "./profilerTablesModel";
import { openScene } from "./voiceSceneSupport";

const EMPTY_MIX = { slotTableVersion: 1, monitorActive: false, targetIndex: 0, snapshot: null, masterVolume: 1, hiddenMute: false };
const keyframe = (over: Partial<CaptureKeyframe> = {}): CaptureKeyframe => ({ voices: [], buses: [], metered: [], events: [], music: [], mix: EMPTY_MIX, ...over });
const seekState = (kf: CaptureKeyframe | null): CaptureSeekState =>
  ({ seconds: 0, keyframeSeq: kf ? 1 : -1, keyframe: kf, status: null, records: [], recordsScanned: 0 }) as unknown as CaptureSeekState;
/** A bus row at unity whose authored lane sits at `authored` (value and target), with the given flags. */
const bus = (slot: number, { authored = 1, ...over }: Partial<CaptureKeyframeBus> & { authored?: number } = {}): CaptureKeyframeBus => {
  const at = (g: number) => ({ value: g, target: g });
  return {
    slot, gen: 1, lanes: { authored: at(authored), runtime: at(1), snapshot: at(1), monitor: at(1), dip: at(1) }, duck: 1, automation: 1,
    authoredMute: false, runtimeMute: false, monitorMute: false, monitorSolo: false, tombstone: false, metered: false, ...over,
  };
};
/** A META names table as the summary's log: each name held from the start. */
const fromStart = (m: Map<number, string> | undefined) => [...(m ?? [])].map(([id, name]) => [id, name, -Infinity] as const);
/** A source with these names that never answers a seek (the region asks for one only when it has none). */
const sourceOf = (names: { buses?: Map<number, string>; events?: Map<number, string> }, audio?: unknown): ProfileSource =>
  ({ summary: { names: { clips: [], buses: fromStart(names.buses), events: fromStart(names.events), parameters: [], snapshots: [], targets: [] }, meta: audio === undefined ? {} : { audio } }, truncated: false, startSeconds: 0, seek: () => new Promise(() => {}) }) as unknown as ProfileSource;
const CURSOR = { mode: "paused", time: 0, revision: 0 } as TablesSlotProps["cursor"];

// ---- reading the region ----

const section = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`section[data-table="${name}"]`)!;
const rowsOf = (root: HTMLElement, name: string): string[][] =>
  [...section(root, name).querySelectorAll<HTMLElement>(".pgrid-row")].map((r) => [...r.querySelectorAll(".pgrid-cell")].map((c) => c.textContent ?? ""));
const emptyOf = (root: HTMLElement, name: string): string | null => section(root, name).querySelector(".ptable-empty")?.textContent ?? null;
const summaryOf = (root: HTMLElement, name: string): string => section(root, name).querySelector(".ptable-summary")?.textContent ?? "";
const filter = (root: HTMLElement) => within(root).getByLabelText("Filter tables by name") as HTMLInputElement;

const meta = {
  title: "Audio/Profiler/Tables",
  component: ProfilerTables,
  args: { source: sourceOf({}), seek: seekState(keyframe()), cursor: CURSOR, live: null },
} satisfies Meta<typeof ProfilerTables>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    // The filter, then the voice, bus, event and music tables, in that order; each says it has nothing at the cursor.
    expect(canvasElement.querySelector("label")!.compareDocumentPosition(section(canvasElement, "voices")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...canvasElement.querySelectorAll<HTMLElement>("section")].map((s) => s.dataset.table)).toEqual(["voices", "buses", "events", "music"]);
    for (const t of ["voices", "buses", "events", "music"] as const) expect(emptyOf(canvasElement, t)).toBe(tableEmptyText(t, "none"));
    // A search input that shows what is typed.
    expect(filter(canvasElement).value).toBe("");
    await userEvent.type(filter(canvasElement), "jump");
    expect(filter(canvasElement).value).toBe("jump");
  },
};

export const NoCursorYet: Story = {
  args: { seek: null },
  play: async ({ canvasElement }) => {
    // Before any seek answered, every table asks for a cursor position.
    for (const t of ["voices", "buses", "events", "music"] as const) expect(emptyOf(canvasElement, t)).toBe(tableEmptyText(t, "noCursor"));
  },
};

export const FilterTyping: Story = {
  args: {
    source: sourceOf({ buses: new Map([[0, "Master"], [1, "Music"]]), events: new Map([[5, "PlayerJump"], [6, "Ambience"]]) }, { buses: [{ name: "Master" }] }),
    seek: seekState(keyframe({ buses: [bus(0), bus(1)], events: [{ id: 1, asset: 5, voices: 2, paramsHash: 0 }, { id: 2, asset: 6, voices: 1, paramsHash: 0 }] })),
  },
  play: async ({ canvasElement }) => {
    expect(rowsOf(canvasElement, "buses")).toHaveLength(2);
    expect(rowsOf(canvasElement, "events")).toHaveLength(2);
    await userEvent.type(filter(canvasElement), "mus");
    expect(rowsOf(canvasElement, "buses").map((c) => c[0])).toEqual(["Music"]);
    expect(rowsOf(canvasElement, "events")).toHaveLength(0);
    expect(emptyOf(canvasElement, "events")).toBe(tableEmptyText("events", "noMatch"));
    expect(summaryOf(canvasElement, "buses")).toBe("1 of 2 buses");
    await userEvent.clear(filter(canvasElement));
    await userEvent.type(filter(canvasElement), "jump");
    expect(rowsOf(canvasElement, "events").map((c) => c[1])).toEqual(["PlayerJump"]);
    await userEvent.clear(filter(canvasElement));
    await userEvent.type(filter(canvasElement), "zzz");
    expect(emptyOf(canvasElement, "voices")).toBe(tableEmptyText("voices", "none")); // no voices at all: not "no match"
  },
};

const music: CaptureKeyframeMusic[] = [
  { id: 7, segment: 1, state: "playing", pass: 2, bar: 4, beat: 3, tick: 120, tempo: 120, pending: { to: 2, seconds: 12.5 } },
  { id: 8, segment: 3, state: "ending", pass: 1, bar: 1, beat: 1, tick: 0, tempo: 90, pending: null },
];

export const Music: Story = {
  args: { source: sourceOf({ events: new Map([[1, "Intro"], [2, "Loop"], [3, "Outro"]]) }), seek: seekState(keyframe({ music })) },
  play: async ({ canvasElement }) => {
    expect(rowsOf(canvasElement, "music")).toEqual([["7", "Intro", "playing", "2", "4:3.120", "120", "to Loop at 12.50 s"], ["8", "Outro", "ending", "1", "1:1.0", "90", ""]]);
    expect([...section(canvasElement, "music").querySelectorAll("[role=columnheader]")].map((n) => n.textContent)).toEqual(["Instance", "Segment", "State", "Pass", "Bar:beat.tick", "Tempo", "Pending"]);
    // Filtered by segment name.
    await userEvent.type(filter(canvasElement), "out");
    expect(rowsOf(canvasElement, "music").map((c) => c[0])).toEqual(["8"]);
  },
};

export const RecordedSceneEvents: Story = {
  loaders: [
    async () => {
      const source = await openScene();
      const seek = await source.seek(5_000 / SAMPLE_RATE); // event 10 (PlayerJump) started at 2,000
      return { source, seek };
    },
  ],
  render: (args, { loaded }) => <ProfilerTables {...args} source={loaded.source as ProfileSource} seek={loaded.seek as CaptureSeekState} />,
  play: async ({ canvasElement, loaded }) => {
    expect(rowsOf(canvasElement, "events")).toEqual([["10", "PlayerJump", "0"]]); // started after the keyframe: no voice count
    expect(summaryOf(canvasElement, "events")).toBe("1 event instance");
    (loaded.source as ProfileSource).close();
  },
};
