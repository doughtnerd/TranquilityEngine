// Stories (ADR 0219) for the pose database tool's timeline strip (ADR 0373; T55): a clip's tagged ranges on a bar. The maths of
// positions, drags and colours are unit tests (`timelineStripLogic.test.ts`); these drive the view with pointer events and
// check what it reports (an edit is reported once, on release, so it is one undo step).
import { useState } from "preact/hooks";
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { PoseRange } from "../../../../engine/animation/poseDatabase";
import { RangeStrip } from "./RangeStrip";

const START: PoseRange[] = [{ from: 0, to: 2, tags: ["walk"] }, { from: 2, to: 3, tags: ["stop", "walk"] }];

/** The strip over its own state, listing the edits it reported. */
function Harness(props: { ranges?: PoseRange[]; duration?: number; disabled?: boolean }) {
  const [ranges, setRanges] = useState<PoseRange[]>(props.ranges ?? START);
  const [selected, setSelected] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [...l, s]);
  return (
    <div style={{ width: "420px" }}>
      <RangeStrip
        clip="walk.anim.json"
        duration={props.duration ?? 4}
        ranges={ranges}
        tagOrder={["walk", "stop"]}
        selected={selected}
        disabled={props.disabled}
        onSelect={setSelected}
        onChange={(k, from, to) => {
          note(`change ${k + 1}: ${from}-${to}`);
          setRanges((r) => r.map((g, i) => (i === k ? { ...g, from, to } : g)));
        }}
        onAdd={(from, to) => {
          note(`add ${from}-${to}`);
          setRanges((r) => [...r, { from, to, tags: [] }]);
        }}
      />
      <ul aria-label="Reported edits">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

const meta = { title: "Animation/Pose database/Range strip", component: Harness } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The bar of the strip, and a time on it as a screen x. */
const barOf = (c: HTMLElement) => c.querySelector<HTMLElement>(".posedb-strip-bar")!;
const xAt = (bar: HTMLElement, fraction: number) => bar.getBoundingClientRect().left + bar.getBoundingClientRect().width * fraction;
const pointer = { pointerId: 7, button: 0 };
/** Lets the strip render the gesture a pointer event started (state updates are asynchronous), as real pointer events are tasks apart. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** The ranges show with their tags, and a click selects one. */
export const Ranges: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const first = c.getByRole("button", { name: /Range 1: 0.00–2.00 s walk/ });
    expect(c.getByRole("button", { name: /Range 2: 2.00–3.00 s stop walk/ })).toBeTruthy();
    expect(first).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(first);
    await waitFor(() => expect(first).toHaveAttribute("aria-pressed", "true"));
  },
};

/** Dragging a range's end edge changes it once, on release, and the end can't pass the clip's length. */
export const DragAnEdge: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = barOf(canvasElement);
    const second = c.getByRole("button", { name: /Range 2/ });
    const edge = second.querySelector(".posedb-range-edge.end")!;
    fireEvent.pointerDown(edge, { ...pointer, clientX: xAt(bar, 0.75) });
    await tick();
    fireEvent.pointerMove(bar, { ...pointer, clientX: xAt(bar, 0.875) });
    await tick();
    expect(c.queryByText(/^change/)).toBeNull(); // nothing reported mid-drag
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 0.875) });
    await waitFor(() => expect(c.getByText("change 2: 2-3.5")).toBeTruthy());
    // Past the end of the clip: it stops at 4 s.
    const again = c.getByRole("button", { name: /Range 2/ }).querySelector(".posedb-range-edge.end")!;
    fireEvent.pointerDown(again, { ...pointer, clientX: xAt(bar, 0.875) });
    await tick();
    fireEvent.pointerMove(bar, { ...pointer, clientX: xAt(bar, 2) });
    await tick();
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 2) });
    await waitFor(() => expect(c.getByText("change 2: 2-4")).toBeTruthy());
  },
};

/** Dragging a range's body moves it, keeping its length. */
export const MoveARange: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = barOf(canvasElement);
    const first = c.getByRole("button", { name: /Range 1/ });
    fireEvent.pointerDown(first, { ...pointer, clientX: xAt(bar, 0.25) });
    await tick();
    fireEvent.pointerMove(bar, { ...pointer, clientX: xAt(bar, 0.375) });
    await tick();
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 0.375) });
    await waitFor(() => expect(c.getByText("change 1: 0.5-2.5")).toBeTruthy());
  },
};

/** Dragging over the empty strip adds a range; a click without a drag adds none. */
export const AddByDragging: Story = {
  args: { ranges: [] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = barOf(canvasElement);
    expect(c.getByText("the whole clip, untagged")).toBeTruthy();
    fireEvent.pointerDown(bar, { ...pointer, clientX: xAt(bar, 0.25) });
    await tick();
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 0.25) });
    expect(c.queryByText(/^add/)).toBeNull();
    fireEvent.pointerDown(bar, { ...pointer, clientX: xAt(bar, 0.25) });
    await tick();
    fireEvent.pointerMove(bar, { ...pointer, clientX: xAt(bar, 0.5) });
    await tick();
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 0.5) });
    await waitFor(() => expect(c.getByText("add 1-2")).toBeTruthy());
  },
};

/** A read-only strip reports nothing when dragged. */
export const ReadOnly: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const bar = barOf(canvasElement);
    fireEvent.pointerDown(bar, { ...pointer, clientX: xAt(bar, 0.1) });
    await tick();
    fireEvent.pointerMove(bar, { ...pointer, clientX: xAt(bar, 0.9) });
    await tick();
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 0.9) });
    expect(c.queryByText(/^add/)).toBeNull();
    const edge = c.getByRole("button", { name: /Range 1/ }).querySelector(".posedb-range-edge.end")!;
    fireEvent.pointerDown(edge, { ...pointer, clientX: xAt(bar, 0.5) });
    await tick();
    fireEvent.pointerMove(bar, { ...pointer, clientX: xAt(bar, 0.7) });
    await tick();
    fireEvent.pointerUp(bar, { ...pointer, clientX: xAt(bar, 0.7) });
    expect(c.queryByText(/^change/)).toBeNull();
  },
};

/** A clip whose length isn't known yet: the strip spans the ranges. */
export const UnknownLength: Story = {
  args: { duration: 0 },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByText("3.00 s")).toBeTruthy();
  },
};
