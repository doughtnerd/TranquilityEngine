// Stories (ADR 0219) for the profiler's voice table (Pf5): 1,024 voices windowed to at most 64 rendered rows while the
// region scrolls, keyboard focus through the rows (arrows, pages, Home and End), a click focusing a row, the filtered and
// empty states, and a stolen voice's reason and thief on a recorded scene. Rendered through its real props: the one table
// section (ADR 0326) with the voice table's columns and the kit's table of a reconstructed seek state.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor } from "storybook/test";
import type { CaptureKeyframe, CaptureKeyframeVoice, CaptureSeekState } from "../../runtime/capture/reader";
import { SAMPLE_RATE } from "../../runtime/capture/testSupport";
import { MAX_RENDERED_ROWS, ROW_HEIGHT, VIEWPORT_ROWS, windowRows } from "./gridWindow";
import { VOICE_TABLE } from "./VoiceTable";
import { TableSection } from "./ProfilerTableSection";
import { namesFromStart } from "../../runtime/capture/testSupport";
import { profilerTable, profilerTables, tableEmptyText, tableSeek, voiceRows, type ProfilerTable } from "./profilerTablesModel";
import type { VoiceRow } from "./voiceTableModel";
import { openScene } from "./voiceSceneSupport";

const EMPTY_MIX = { slotTableVersion: 1, monitorActive: false, targetIndex: 0, snapshot: null, masterVolume: 1, hiddenMute: false };
const keyframe = (over: Partial<CaptureKeyframe> = {}): CaptureKeyframe => ({ voices: [], buses: [], metered: [], events: [], music: [], mix: EMPTY_MIX, ...over });
const seekState = (kf: CaptureKeyframe | null): CaptureSeekState =>
  ({ seconds: 0, keyframeSeq: kf ? 1 : -1, keyframe: kf, status: null, records: [], recordsScanned: 0 }) as unknown as CaptureSeekState;
const voice = (id: number, over: Partial<CaptureKeyframeVoice> = {}): CaptureKeyframeVoice => ({
  id, clip: 1 + (id % 3), slot: id % 3, state: "playing", priority: id % 5, reason: null, gain: 0.5, pitch: 1, audibility: (65535 - id * 8) / 65536, playheadFrames: id * 10, ...over,
});
const NAMES = namesFromStart({ clips: [[1, "jump.ogg"], [2, "Land.ogg"], [3, "footstep.ogg"]], buses: [[0, "Master"], [1, "Music"], [2, "SFX"]] });
const voiceData = (state: CaptureSeekState, filter = ""): ProfilerTable<VoiceRow> => profilerTable("voices", voiceRows(state, NAMES), filter, tableSeek(state, false, false));
const thousand = () => voiceData(seekState(keyframe({ voices: Array.from({ length: 1024 }, (_, i) => voice(i + 1)) })));
const four = seekState(keyframe({ voices: [voice(1, { clip: 1, slot: 1 }), voice(2, { clip: 2, slot: 2 }), voice(3, { clip: 1, slot: 2 }), voice(4, { clip: 3, slot: 1 })] }));

// ---- reading the rendered table ----

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".pgrid-row")];
const indices = (root: HTMLElement) => rows(root).map((r) => Number(r.dataset.index));
const cells = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".pgrid-cell")].map((c) => c.textContent ?? "");
const focused = (root: HTMLElement) => rows(root).filter((r) => r.tabIndex === 0).map((r) => Number(r.dataset.index));
const region = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-scroll]")!;
const grid = (root: HTMLElement) => root.querySelector<HTMLElement>("[role=grid]")!;
/** Scroll the region as a wheel or scrollbar does, and let the table follow: its window starts where the offset's does. */
async function scrollTo(root: HTMLElement, top: number): Promise<void> {
  const r = region(root);
  r.scrollTop = top;
  await fireEvent.scroll(r);
  const start = windowRows({ total: 1024, scrollTop: r.scrollTop }).start;
  await waitFor(() => expect(indices(root)[0]).toBe(start));
}
/** Press `key` on the grid; whether the table took it (prevented the browser's default). */
const press = async (root: HTMLElement, key: string): Promise<boolean> => !(await fireEvent.keyDown(grid(root), { key }));

const meta = {
  title: "Audio/Profiler/Voice table",
  component: TableSection<VoiceRow>,
  args: { columns: VOICE_TABLE, table: thousand() },
} satisfies Meta<typeof TableSection<VoiceRow>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ManyVoices: Story = {
  play: async ({ canvasElement, args, step }) => {
    await step("every voice is in the data, windowed by the grid and not by the model, most audible first", async () => {
      expect(args.table.rows).toHaveLength(1024);
      expect(args.table.summary).toBe("1024 voices");
      expect(args.table.empty).toBeNull();
      expect(args.table.rows[0]!.id).toBe(1);
      expect(args.table.rows.map((r) => r.audibility)).toEqual([...args.table.rows.map((r) => r.audibility)].sort((a, b) => b! - a!));
    });
    await step("at most 64 rows rendered at every scroll position; the window moves with the scroll", async () => {
      const firsts: number[] = [];
      for (const top of [0, 150, 1_000, 5_000, 10_000, 15_000, 20_000, 20_480, 99_999]) {
        await scrollTo(canvasElement, top);
        const idx = indices(canvasElement);
        expect(idx.length, `scroll ${top}`).toBeGreaterThan(0);
        expect(idx.length, `scroll ${top}`).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
        expect(idx, `scroll ${top}`).toEqual(idx.map((_, i) => idx[0]! + i)); // contiguous
        const first = Math.floor(windowRows({ total: 1024, scrollTop: region(canvasElement).scrollTop }).scrollTop / ROW_HEIGHT);
        expect(idx).toContain(first); // the top visible row
        expect(idx).toContain(first + VIEWPORT_ROWS - 1); // and the bottom one
        firsts.push(idx[0]!);
      }
      expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
      expect(new Set(firsts).size).toBe(firsts.length - 1); // 20_480 and 99_999 both clamp to the end
    });
    await step("each row sits at its index; the spacer is sized for the whole list", async () => {
      await scrollTo(canvasElement, 10_000);
      expect(canvasElement.querySelector<HTMLElement>(".pgrid-spacer")!.style.height).toBe(`${1024 * ROW_HEIGHT}px`);
      for (const r of rows(canvasElement)) expect(r.style.top).toBe(`${Number(r.dataset.index) * ROW_HEIGHT}px`);
      expect(grid(canvasElement)).toHaveAttribute("aria-rowcount", "1025");
    });
    await step("the scroll region is the tab stop while the focused row is scrolled out of the window", async () => {
      expect(region(canvasElement).tabIndex).toBe(0); // row 0 is far above
      await scrollTo(canvasElement, 0);
      expect(region(canvasElement).tabIndex).toBe(-1); // row 0 is rendered and is the tab stop
    });
  },
};

export const Keyboard: Story = {
  play: async ({ canvasElement, step }) => {
    await step("one tab stop, the focused row; arrows move it one row, the window following", async () => {
      expect(focused(canvasElement)).toEqual([0]);
      rows(canvasElement)[0]!.focus();
      await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([1]));
      for (let i = 0; i < 29; i++) await userEvent.keyboard("{ArrowDown}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([30]));
      expect(document.activeElement).toBe(rows(canvasElement).find((r) => r.dataset.index === "30")); // focused at commit
      expect(indices(canvasElement).length).toBeLessThanOrEqual(MAX_RENDERED_ROWS);
      await userEvent.keyboard("{ArrowUp}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([29]));
    });
    await step("pages, and jumps to the first and last row, keeping the focused row rendered", async () => {
      await userEvent.keyboard("{Home}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([0]));
      await userEvent.keyboard("{PageDown}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([VIEWPORT_ROWS]));
      await userEvent.keyboard("{End}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([1023]));
      expect(indices(canvasElement).at(-1)).toBe(1023);
      await userEvent.keyboard("{PageUp}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([1023 - VIEWPORT_ROWS]));
      await userEvent.keyboard("{Home}");
      await waitFor(() => expect(focused(canvasElement)).toEqual([0]));
      expect(indices(canvasElement)[0]).toBe(0); // scrolled back to the top
    });
    await step("other keys are left to the browser", async () => {
      expect(await press(canvasElement, "a")).toBe(false);
      expect(await press(canvasElement, "Tab")).toBe(false);
      expect(await press(canvasElement, "ArrowDown")).toBe(true);
    });
    await step("a click focuses a row", async () => {
      await userEvent.click(rows(canvasElement)[2]!);
      await waitFor(() => expect(focused(canvasElement)).toEqual([Number(rows(canvasElement)[2]!.dataset.index)]));
    });
  },
};

export const Filtered: Story = {
  args: { table: voiceData(four, "jump") },
  play: async ({ canvasElement, args }) => {
    // Narrowed by clip or bus name, case-insensitively; it says how many matched and renders only those rows.
    expect(args.table.summary).toBe("2 of 4 voices");
    expect(rows(canvasElement)).toHaveLength(2);
    expect(voiceData(four, "JUMP").rows.map((r) => r.id).sort()).toEqual([1, 3]);
    expect(voiceData(four, "sfx").rows.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(voiceData(four, "  land ").rows.map((r) => r.id)).toEqual([2]);
  },
};

export const Empty: Story = {
  args: { table: voiceData(seekState(keyframe())) },
  play: async ({ canvasElement, args }) => {
    // The empty text instead of a grid.
    expect(args.table.empty).toBe("none");
    expect([...canvasElement.querySelectorAll(".ptable-empty")].map((e) => e.textContent)).toEqual([tableEmptyText("voices", "none")]);
    expect(rows(canvasElement)).toHaveLength(0);
    expect(canvasElement.querySelector("[role=grid]")).toBeNull();
  },
};

export const NoKeyframe: Story = {
  args: { table: profilerTable("voices", voiceRows(seekState(keyframe({ voices: [voice(1)] })), NAMES), "", { ready: true, playing: false, truncated: false, beforeFirstKeyframe: true }) },
  play: async ({ canvasElement }) => {
    // A seek with no keyframe lists only the last second's starts, and says so.
    expect(canvasElement.textContent).toContain("no keyframe at or before the cursor");
  },
};

export const RecordedScene: Story = {
  loaders: [
    async () => {
      const s = await openScene();
      const state = await s.seek(45_000 / SAMPLE_RATE); // voice 1 stolen by 3 at frame 40,000 (reason 3, priority)
      const table = profilerTables(s, state, "").voices;
      s.close();
      return { table };
    },
  ],
  render: (_args, { loaded }) => <TableSection columns={VOICE_TABLE} table={loaded.table as ProfilerTable<VoiceRow>} />,
  play: async ({ canvasElement }) => {
    // A stolen voice's reason and the voice that stole it, by clip name.
    const row = rows(canvasElement).find((r) => cells(r)[0] === "1")!;
    expect(cells(row)[4]).toBe("priority, by voice 3 (jump.ogg)");
    expect(row).toHaveAttribute("data-state", "stolen");
  },
};
