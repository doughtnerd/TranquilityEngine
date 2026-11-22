// Stories (ADR 0219, 0337 §6) for Hear as in the player bar: Source by default with no chip; choosing Android shows the
// converting chip while a fake conversion runs and "Hearing Android" after; A/B flips back to Source and to Android again.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { HearAsChoice } from "../encoding/hearAs";
import { HearAsControl } from "./HearAsControl";
import { PlayerBar } from "./PlayerBar";

const meta: Meta = { title: "Studio/HearAsControl", component: HearAsControl };
export default meta;

/** The control with a pretend conversion of 300 ms after each platform choice. */
function Demo() {
  const [choice, setChoice] = useState<HearAsChoice>("source");
  const [last, setLast] = useState<HearAsChoice>("web");
  const [busy, setBusy] = useState(0);
  const choose = (c: HearAsChoice) => {
    setChoice(c);
    if (c === "source") return;
    setLast(c);
    setBusy(1);
    setTimeout(() => setBusy(0), 300);
  };
  return (
    <div style={{ width: "900px" }}>
      <PlayerBar idleArt="WAV" hearAs={<HearAsControl choice={choice} busy={busy} failure={null} onChoose={choose} onToggle={() => choose(choice === "source" ? last : "source")} />} />
    </div>
  );
}

export const InThePlayerBar: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const group = c.getByRole("radiogroup", { name: "Hear as platform" });
    await expect(within(group).getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
    await expect(c.queryByRole("status")).toBeNull();
    await userEvent.click(within(group).getByRole("radio", { name: "Android" }));
    await expect(c.getByRole("status")).toHaveTextContent("Converting for Android…");
    await waitFor(() => expect(c.getByRole("status")).toHaveTextContent("Hearing Android"));
    await userEvent.click(c.getByRole("button", { name: "Compare with source" }));
    await expect(within(group).getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(c.getByRole("button", { name: "Compare with source" }));
    await expect(within(group).getByRole("radio", { name: "Android" })).toHaveAttribute("aria-checked", "true");
  },
};

export const Failed: StoryObj = {
  render: () => <HearAsControl choice="web" busy={0} failure="Couldn't convert for web: the encoder thread failed" onChoose={() => {}} onToggle={() => {}} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("status")).toHaveTextContent("Conversion failed");
  },
};
