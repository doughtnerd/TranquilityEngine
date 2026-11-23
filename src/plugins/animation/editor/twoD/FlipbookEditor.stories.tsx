// Stories (ADR 0219) for the flipbook editor (ADR 0373 "2D tools"; T56): the view over an image's flipbooks, in its own state.
// The rules (frame order by name and number, holds, refusals) are unit tests (`flipbookLogic.test.ts`); these drive the
// view and check what it reports and shows. A refusal reaches the status bar, so the harness lists what the host was told.
import { useState } from "preact/hooks";
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { FlipbookEditor } from "./FlipbookEditor";
import type { Flipbooks } from "./flipbookLogic";
import { SHEET_SLICES, SHEET_URL } from "./twoDStoryFixtures";

/** The editor over its own flipbooks, listing each change it reported (one undo step each in a host). */
function Harness(props: { flipbooks?: Flipbooks; readOnly?: string | null }) {
  const [flipbooks, setFlipbooks] = useState<Flipbooks>(props.flipbooks ?? {});
  const [log, setLog] = useState<string[]>([]);
  return (
    <div style={{ width: "460px", padding: "8px" }}>
      <FlipbookEditor
        url={SHEET_URL}
        slices={SHEET_SLICES}
        flipbooks={flipbooks}
        readOnly={props.readOnly ?? null}
        onChange={(next, label) => {
          setLog((l) => [...l, label]);
          setFlipbooks(next);
        }}
      />
      <ul aria-label="Reported changes">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <pre aria-label="Flipbooks as stored">{JSON.stringify(flipbooks)}</pre>
    </div>
  );
}

const meta = { title: "Animation/2D tools/Flipbook editor", component: Harness } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

const WALK: Flipbooks = { walk: { slices: ["walk_0", "walk_1", "walk_2", "walk_3"], fps: 10, loop: true } };

/** Checked slices make a flipbook named after them, its frames in name and number order whatever the slices' order. */
export const CreateFromSlices: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const create = c.getByRole("button", { name: /Create Flipbook/ });
    await userEvent.click(c.getByLabelText("Use slice walk_3"));
    await userEvent.click(c.getByLabelText("Use slice walk_1"));
    await userEvent.click(c.getByLabelText("Use slice walk_2"));
    await userEvent.click(create);
    await waitFor(() => expect(c.getByLabelText("Flipbooks as stored").textContent).toBe(JSON.stringify({ walk: { slices: ["walk_1", "walk_2", "walk_3"], fps: 12, loop: true } })));
    expect(c.getByText("Create flipbook walk")).toBeTruthy();
    const frames = within(c.getByRole("list", { name: "Frames" }));
    expect(frames.getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("1. walk_1"), expect.stringContaining("2. walk_2"), expect.stringContaining("3. walk_3")]);
  },
};

/** Creating with nothing checked is refused with its reason, and nothing is reported as a change. */
export const RefusesNothingChecked: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: /Create Flipbook/ }));
    expect(c.queryByText(/^Create flipbook/)).toBeNull();
    expect(c.getByLabelText("Flipbooks as stored").textContent).toBe("{}");
  },
};

/** The frame buttons reorder, remove and add frames, and the hold lengthens a frame (its duration follows). */
export const EditFrames: Story = {
  args: { flipbooks: WALK },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const stored = () => JSON.parse(c.getByLabelText("Flipbooks as stored").textContent!).walk.slices as string[];
    await userEvent.click(c.getByRole("button", { name: "Move frame 1 later" }));
    await waitFor(() => expect(stored()).toEqual(["walk_1", "walk_0", "walk_2", "walk_3"]));
    await userEvent.click(c.getByRole("button", { name: "Remove frame 4" }));
    await waitFor(() => expect(stored()).toEqual(["walk_1", "walk_0", "walk_2"]));
    await userEvent.selectOptions(c.getByLabelText("Slice to add"), "walk_3");
    await userEvent.click(c.getByRole("button", { name: "Add Frame" }));
    await waitFor(() => expect(stored()).toEqual(["walk_1", "walk_0", "walk_2", "walk_3"]));
    const hold = c.getByLabelText("Hold of frame 2");
    await userEvent.clear(hold);
    await userEvent.type(hold, "3{Enter}");
    await waitFor(() => expect(stored()).toEqual(["walk_1", "walk_0", "walk_0", "walk_0", "walk_2", "walk_3"]));
    expect(within(c.getByRole("list", { name: "Frames" })).getByText("0.300 s")).toBeTruthy();
  },
};

/** The last frame can't be removed; the reason is the refusal's. Frame rate and loop edit the flipbook. */
export const RateLoopAndTheLastFrame: Story = {
  args: { flipbooks: { hop: { slices: ["walk_0"], fps: 12, loop: true } } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Remove frame 1" }));
    expect(c.getByLabelText("Flipbooks as stored").textContent).toBe(JSON.stringify({ hop: { slices: ["walk_0"], fps: 12, loop: true } }));
    const fps = c.getByLabelText("Frame rate");
    await userEvent.clear(fps);
    await userEvent.type(fps, "24{Enter}");
    await userEvent.click(c.getByLabelText("Loop"));
    await waitFor(() => expect(c.getByLabelText("Flipbooks as stored").textContent).toBe(JSON.stringify({ hop: { slices: ["walk_0"], fps: 24, loop: false } })));
  },
};

/** The preview plays in the panel: it shows a frame, Pause stops it and the scrubber picks a time. */
export const PreviewPlays: Story = {
  args: { flipbooks: WALK },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const preview = within(c.getByLabelText("Flipbook preview"));
    await waitFor(() => expect(preview.getByRole("img").getAttribute("aria-label")).toMatch(/^Showing walk_/));
    await userEvent.click(preview.getByRole("button", { name: "Pause" }));
    expect(preview.getByRole("button", { name: "Play" })).toBeTruthy();
    const scrub = preview.getByLabelText("Preview time") as HTMLInputElement;
    scrub.value = "0.25";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(preview.getByRole("img").getAttribute("aria-label")).toBe("Showing walk_2"));
  },
};

/** A read-only project leaves the editing buttons off. */
export const ReadOnly: Story = {
  args: { flipbooks: WALK, readOnly: "This project is read-only." },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("button", { name: /Create Flipbook/ })).toBeDisabled();
    expect(c.getByRole("button", { name: "Delete Flipbook" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Remove frame 1" })).toBeDisabled();
  },
};
