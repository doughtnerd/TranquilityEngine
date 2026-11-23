// Stories (ADR 0219) for the subtitle display's states, drawn by `SubtitlePreview` from the real subtitle board (the
// model `SubtitleDisplay` draws) fed scripted `onLine`/`onCaption` events on a heard clock: one speaker, a conversation
// with names only while several speak, paging timed by a `sub` marker, a caption dropped first when the stack is full,
// the size presets and the background box.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useMemo, useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { fitsLines } from "../../../engine/localisation/subtitles";
import { SUBTITLE_SIZES, type SubtitleSize } from "../../../engine/localisation/subtitleSettings";
import { fontSizeFor, showSpeakerNames, SubtitleBoard, type BoardCaptionEvent, type BoardLineEvent, type SpeakerNameMode } from "../runtime/board";
import { SubtitlePreview } from "./SubtitlePreview";

const meta: Meta = { title: "Plugins/Subtitles/Display" };
export default meta;

type Event = { at: number } & ({ line: BoardLineEvent } | { caption: BoardCaptionEvent });

const SPEAKERS: Record<string, { name: string; color: string | null }> = { Ava: { name: "Ava:", color: "#7fd1ff" }, Guard: { name: "Guard:", color: null } };
const line = (key: string, speaker: string, text: string, time: number, duration: number): Event => ({ at: time, line: { phase: "start", key, speaker, text, textKey: key, duration, time } });
const sub = (key: string, time: number): Event => ({ at: time, line: { phase: "marker", key, speaker: null, text: null, textKey: key, duration: 0, time, marker: { type: "cue", name: "sub", time } } });
const caption = (key: string, text: string, time: number): Event => ({ at: time, caption: { phase: "start", playlist: `${key}.playlist.json`, key, text, time, duration: 1.5 } });

const SCRIPT: Event[] = [
  line("intro_01", "Ava", "We have to leave before the guards come back. The gate at the north wall is still open.", 0, 8),
  sub("intro_01", 3.5),
  caption("door", "[door slams]", 3.8),
  line("guard_01", "Guard", "Halt! Who goes there?", 4, 2),
];

/** The board after the script's events up to `time`, and its rows at `time`. */
function useBoard(time: number, mode: SpeakerNameMode) {
  return useMemo(() => {
    const board = new SubtitleBoard({ resolve: () => null, rule: () => ({ speed: 15, minDisplay: 1.5 }), fits: () => fitsLines(50, 1) }, { maxStack: 2, fadeIn: 0.12, fadeOut: 0.2, speech: true, captions: true });
    for (const e of SCRIPT) if (e.at <= time) "line" in e ? board.line(e.line) : board.caption(e.caption);
    const rows = board.rows(time);
    return { rows, names: showSpeakerNames(rows, mode, true) };
  }, [time, mode]);
}

function Demo(props: { time?: number; mode?: SpeakerNameMode; size?: SubtitleSize; background?: number }) {
  const [time, setTime] = useState(props.time ?? 0.5);
  const [size, setSize] = useState<SubtitleSize>(props.size ?? "medium");
  const [background, setBackground] = useState(props.background ?? 0.6);
  const { rows, names } = useBoard(time, props.mode ?? "whenSeveral");
  const height = 270;
  return (
    <div style={{ display: "grid", gap: "8px", color: "var(--text)" }}>
      <SubtitlePreview rows={rows} names={names} speaker={(id) => SPEAKERS[id] ?? { name: `${id}:`, color: null }} fontSize={fontSizeFor(size, height)} background={background} position="bottom" margin={8} maxWidth={70} height={height} />
      <label>Heard time <input type="range" min={0} max={8} step={0.1} value={time} aria-label="Heard time" onInput={(e) => setTime(Number((e.currentTarget as HTMLInputElement).value))} /> <output aria-label="Time">{time.toFixed(1)} s</output></label>
      <label>Size <select aria-label="Size" value={size} onChange={(e) => setSize((e.currentTarget as HTMLSelectElement).value as SubtitleSize)}>{SUBTITLE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      <label>Background <input type="range" min={0} max={1} step={0.1} value={background} aria-label="Background" onInput={(e) => setBackground(Number((e.currentTarget as HTMLInputElement).value))} /></label>
      <button onClick={() => setTime(3.4)}>Before the sub marker</button>
      <button onClick={() => setTime(3.6)}>After the sub marker</button>
      <button onClick={() => setTime(3.9)}>Door slams</button>
      <button onClick={() => setTime(4.2)}>Guard speaks</button>
    </div>
  );
}

const rowTexts = (c: ReturnType<typeof within>) => c.queryAllByRole("listitem").map((r: HTMLElement) => r.querySelector(".line")?.textContent ?? "");

export const OneSpeaker: StoryObj = {
  render: () => <Demo time={0.5} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(rowTexts(c)).toEqual(["We have to leave before the guards come back."]);
    // One speaker with whenSeveral: no name.
    await expect(canvasElement.querySelector(".speaker")).toBeNull();
  },
};

export const PagingWithSubMarker: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Before the sub marker" }));
    await expect(rowTexts(c)[0]).toBe("We have to leave before the guards come back.");
    await userEvent.click(c.getByRole("button", { name: "After the sub marker" }));
    await expect(rowTexts(c)[0]).toBe("The gate at the north wall is still open.");
  },
};

export const ConversationDropsCaptionFirst: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Guard speaks" }));
    // maxStack 2: the caption left before Ava's speech; two speakers, so names show.
    await expect(rowTexts(c)).toEqual(["The gate at the north wall is still open.", "Halt! Who goes there?"]);
    await expect([...canvasElement.querySelectorAll(".speaker")].map((s) => s.textContent)).toEqual(["Ava:", "Guard:"]);
  },
};

export const SizesAndBackground: StoryObj = {
  render: () => <Demo time={3.9} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const row = () => c.getAllByRole("listitem")[0] as HTMLElement;
    await expect(row().style.fontSize).toBe("10.8px"); // medium: 4% of 270
    await expect(c.getAllByRole("listitem").map((r) => r.classList.contains("caption"))).toEqual([false, true]);
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Size" }), "extraLarge");
    await expect(row().style.fontSize).toBe("17.28px"); // 6.4% of 270
  },
};

export const ExtraLargeNoBox: StoryObj = { render: () => <Demo time={4.2} size="extraLarge" background={0} mode="always" /> };
