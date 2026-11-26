// Stories (ADR 0219) for the shared dope sheet grid (ADR 0346, 0373): rows of keys under a ruler, headings and spans,
// clicking and Shift/Ctrl-clicking keys, box select over several rows, dragging selected keys (the host moves them),
// clicking the ruler to move the playhead, and onion skin ghost marks. The host here keeps the selection and moves keys
// itself, as the curve editor's dope sheet and the Animation window do.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { DopeSheetGrid, type DopeRow, type DopeSelectMode } from "./DopeSheetGrid";

const ROWS: DopeRow[] = [
  { id: "body", label: "Body", heading: true, keys: [] },
  { id: "x", label: "position.x", depth: 1, color: "var(--series-1)", keys: [{ id: "x0", x: 0, label: "x key at 0.00 s" }, { id: "x1", x: 0.5, label: "x key at 0.50 s" }, { id: "x2", x: 1, label: "x key at 1.00 s" }] },
  { id: "y", label: "position.y", depth: 1, color: "var(--series-2)", keys: [{ id: "y0", x: 0.25, label: "y key at 0.25 s" }, { id: "y1", x: 0.75, label: "y key at 0.75 s" }] },
  { id: "on", label: "Active", depth: 1, color: "var(--series-3)", keys: [{ id: "on0", x: 0.2, label: "on at 0.20 s" }], spans: [{ id: "s0", from: 0.2, to: 0.6, label: "on 0.20 s – 0.60 s" }] },
];

function Host(props: { ghosts?: readonly number[] }) {
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [t, setT] = useState(0);
  const [moved, setMoved] = useState(0);
  const select = (ids: readonly string[], mode: DopeSelectMode) =>
    setSel((cur) => {
      if (mode === "replace") return new Set(ids);
      const next = new Set(cur);
      for (const id of ids) mode === "toggle" && next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <div style={{ width: "640px" }}>
      <DopeSheetGrid length={1} rows={ROWS} selected={sel} playhead={t} ghosts={props.ghosts} onPlayhead={setT} onSelect={select} onDrag={(phase, dx) => phase === "end" && setMoved(dx)} />
      <output aria-label="Selected">{[...sel].sort().join(",") || "none"}</output> · <output aria-label="Playhead">{t.toFixed(2)}</output> · <output aria-label="Moved">{moved > 0 ? "later" : moved < 0 ? "earlier" : "no"}</output>
    </div>
  );
}

const meta = {
  title: "Editor/Curves/Dope Sheet Grid",
  render: () => <Host />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Clicking selects one key; Shift adds; Ctrl toggles. */
export const SelectKeys: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // One user session, so a modifier held down stays down for the click (each bare userEvent call starts afresh).
    const user = userEvent.setup();
    await user.click(c.getByRole("button", { name: "x key at 0.50 s" }));
    await waitFor(() => expect(c.getByLabelText("Selected")).toHaveTextContent("x1"));
    await user.keyboard("{Shift>}");
    await user.click(c.getByRole("button", { name: "y key at 0.25 s" }));
    await user.keyboard("{/Shift}");
    await waitFor(() => expect(c.getByLabelText("Selected")).toHaveTextContent("x1,y0"));
    await user.keyboard("{Control>}");
    await user.click(c.getByRole("button", { name: "x key at 0.50 s" }));
    await user.keyboard("{/Control}");
    await waitFor(() => expect(c.getByLabelText("Selected")).toHaveTextContent("y0"));
    expect(c.getByRole("button", { name: "y key at 0.25 s" })).toHaveAttribute("aria-pressed", "true");
  },
};

/** A box dragged over empty grid space selects the keys inside it, across rows. */
export const BoxSelect: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const rowX = canvasElement.querySelector('[data-row="x"]') as HTMLElement;
    const rowY = canvasElement.querySelector('[data-row="y"]') as HTMLElement;
    const a = rowX.getBoundingClientRect();
    const b = rowY.getBoundingClientRect();
    // From just after 0.40 s on the x row to just after 0.80 s on the y row: x1 (0.5) and y1 (0.75).
    fireEvent.pointerDown(rowX, { button: 0, clientX: a.left + a.width * 0.4, clientY: a.top + 2, pointerId: 1 });
    fireEvent.pointerMove(rowX, { clientX: a.left + a.width * 0.8, clientY: b.bottom - 2, pointerId: 1 });
    fireEvent.pointerUp(rowX, { clientX: a.left + a.width * 0.8, clientY: b.bottom - 2, pointerId: 1 });
    await waitFor(() => expect(c.getByLabelText("Selected")).toHaveTextContent("x1,y1"));
  },
};

/** Dragging a key reports the time offset to the host. */
export const DragKeys: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const key = c.getByRole("button", { name: "x key at 0.50 s" });
    const row = key.parentElement!.getBoundingClientRect();
    const r = key.getBoundingClientRect();
    fireEvent.pointerDown(key, { button: 0, clientX: r.left + r.width / 2, clientY: r.top + 2, pointerId: 1 });
    fireEvent.pointerMove(key, { clientX: r.left + row.width * 0.2, clientY: r.top + 2, pointerId: 1 });
    fireEvent.pointerUp(key, { clientX: r.left + row.width * 0.2, clientY: r.top + 2, pointerId: 1 });
    await waitFor(() => expect(c.getByLabelText("Moved")).toHaveTextContent("later"));
  },
};

/** Clicking the ruler moves the playhead; onion skin ghosts are marked on it. */
export const PlayheadAndGhosts: Story = {
  render: () => <Host ghosts={[0.4, 0.6]} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const ruler = canvasElement.querySelector(".ce-ruler") as HTMLElement;
    const r = ruler.getBoundingClientRect();
    fireEvent.pointerDown(ruler, { button: 0, clientX: r.left + r.width / 2, clientY: r.top + 4, pointerId: 1 });
    fireEvent.pointerUp(ruler, { clientX: r.left + r.width / 2, clientY: r.top + 4, pointerId: 1 });
    await waitFor(() => expect(c.getByLabelText("Playhead")).toHaveTextContent("0.50"));
    expect(canvasElement.querySelectorAll(".ce-ghost-flag")).toHaveLength(2);
  },
};

/** Bars (the Timeline window's clips): a blend region over two overlapping bars, the bar selected by a click, and its handles. */
export const Bars: Story = {
  render: () => {
    const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
    const rows: DopeRow[] = [
      {
        id: "clips", label: "Animation", color: "var(--series-1)", keys: [],
        bars: [{ id: "a", from: 0, to: 0.6, label: "wave · 0.00 – 0.60 s", easeOut: 0.2 }, { id: "b", from: 0.4, to: 1, label: "run · 0.40 – 1.00 s", easeIn: 0.2 }],
        spans: [{ id: "blend", from: 0.4, to: 0.6, label: "Blend 0.40 s – 0.60 s", blend: true }],
      },
    ];
    return (
      <div style={{ width: "640px" }}>
        <DopeSheetGrid length={1} rows={rows} selected={sel} playhead={0} onPlayhead={() => {}} onSelect={(ids) => setSel(new Set(ids))} />
        <output aria-label="Selected">{[...sel].join(",") || "none"}</output>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTitle("Blend 0.40 s – 0.60 s")).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "run · 0.40 – 1.00 s" }));
    expect(c.getByLabelText("Selected")).toHaveTextContent("b");
    expect(c.getByRole("button", { name: "run · 0.40 – 1.00 s" })).toHaveAttribute("aria-pressed", "true");
  },
};
