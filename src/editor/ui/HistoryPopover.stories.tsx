// Stories (ADR 0219, 0349) for Undo, Redo and the History popover over the active history (ADR 0145): a panel that
// registers its history (`usePanelHistory`, as any panel does) with a branching tree; clicking into it makes it the
// active one, the buttons name its steps and the popover draws its tree. Clicking in the cluster keeps it active.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useMemo, useRef, useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { usePanelHistory, type UndoHistory } from "../activeHistory";
import { HistoryPopover } from "./HistoryPopover";

const T0 = Date.now() - 60_000;
const STATES = [
  { seq: 0, parent: -1, label: "Opened", time: T0 - 5_000, hash: "0" },
  { seq: 1, parent: 0, label: "Add marker", time: T0, hash: "1" },
  { seq: 2, parent: 1, label: "Move marker", time: T0 + 10_000, hash: "2" },
  { seq: 3, parent: 2, label: "Set loop", time: T0 + 20_000, hash: "3" },
  { seq: 4, parent: 1, label: "Rename marker", time: T0 + 30_000, hash: "4" },
];

function useDemoHistory(): { current: number; history: UndoHistory } {
  const [current, setCurrent] = useState(3);
  const label = (seq: number) => STATES.find((s) => s.seq === seq)?.label ?? null;
  const parentOf = (seq: number) => Math.max(0, STATES.find((s) => s.seq === seq)?.parent ?? 0);
  const history = useMemo<UndoHistory>(
    () => ({
      name: "Engine loop.wav",
      canUndo: current > 0,
      canRedo: STATES.some((s) => s.parent === current),
      undoLabel: label(current),
      redoLabel: label(STATES.find((s) => s.parent === current)?.seq ?? -1),
      undo: () => setCurrent(parentOf(current)),
      redo: () => setCurrent(STATES.filter((s) => s.parent === current).at(-1)?.seq ?? current),
      tree: { states: STATES, current, saved: 2, jumpTo: setCurrent },
    }),
    [current],
  );
  return { current, history };
}

function HistoryDemo() {
  const root = useRef<HTMLDivElement>(null);
  const { current, history } = useDemoHistory();
  usePanelHistory(root, history);
  return (
    <div>
      <HistoryPopover />
      <div ref={root} tabIndex={0} style={{ marginTop: "12px", padding: "16px", border: "1px solid var(--border)" }}>
        Sample editor (click here to focus it) · state {current}
      </div>
    </div>
  );
}

const meta: Meta = { title: "Kit/HistoryPopover", component: HistoryPopover };
export default meta;

export const Tree: StoryObj = {
  render: () => <HistoryDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText(/Sample editor/));
    await expect(c.getByRole("button", { name: "Undo" })).toHaveAttribute("title", expect.stringContaining("Undo Set loop"));
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await expect(c.getByText(/state 2/)).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: /History/ }));
    // The popover floats at the page's floating root (the body here), out of any container-query toolbar.
    const popover = within(document.body).getByRole("dialog", { name: "History" });
    await expect(popover).toBeVisible();
    await expect(canvasElement.contains(popover)).toBe(false);
  },
};

export const NothingFocused: StoryObj = { render: () => <HistoryPopover none="Click into a sample or playlist to undo its edits" /> };

/** A document's own toolbar (the Samples toolbar): the cluster acts on that document's history, with nothing focused. */
function OneDocumentDemo() {
  const { current, history } = useDemoHistory();
  return (
    <div>
      <HistoryPopover none="No edits yet" of={{ kind: "asset", history, path: "audio/engine_loop.wav.meta.json" }} />
      <p>state {current}</p>
    </div>
  );
}

/** Journeys walk 2, J11.2: right after a sample opens its toolbar's Undo and History work, before any click into it. */
export const OneDocument: StoryObj = {
  render: () => <OneDocumentDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "Undo" })).toBeEnabled();
    await expect(c.getByRole("button", { name: "Undo" })).toHaveAttribute("title", expect.stringContaining("Undo Set loop"));
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await expect(c.getByText(/state 2/)).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: /History/ }));
    const popover = within(document.body).getByRole("dialog", { name: "History" });
    await expect(popover).toHaveTextContent("engine_loop.wav.meta.json · every step, with branches");
    await expect(popover).not.toHaveTextContent("Click into a document");
  },
};
