// Stories (ADR 0219, 0349) for the ducking row: while playing (switching to "Above level" shows the threshold; a
// trigger another rule already uses is disabled), above a level, and turned off.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { DuckingRule } from "../../engine/audio/project/types";
import { DuckRow } from "./DuckRow";
import { duckTriggerOptions } from "./mixRowsModel";

const parents: Record<string, string | null> = { Master: null, SFX: "Master", Vehicles: "SFX", Weapons: "SFX", Ambience: "Master", Dialogue: "Master", Music: "Master" };
const names = Object.keys(parents);

function Demo(props: { start: DuckingRule; open?: boolean }) {
  const [rule, setRule] = useState(props.start);
  const [open, setOpen] = useState(!!props.open);
  const others: DuckingRule[] = [{ ...props.start, trigger: props.start.trigger === "Weapons" ? "Dialogue" : "Weapons" }];
  return (
    <div style={{ width: "340px" }}>
      <DuckRow rule={rule} open={open} triggers={duckTriggerOptions(names, rule.target, [rule, ...others], (n) => parents[n] ?? null, rule.trigger)} onOpen={setOpen} onEdit={(r) => "next" in r && setRule(r.next)} onRemove={() => {}} />
    </div>
  );
}

const presence: DuckingRule = { target: "Ambience", trigger: "Dialogue", mode: "presence", detector: "rms", thresholdDb: -20, amountDb: -4, attackMs: 80, releaseMs: 400, enabled: true };

const meta: Meta = { title: "Studio/DuckRow", component: DuckRow };
export default meta;

export const WhilePlaying: StoryObj = {
  render: () => <Demo start={presence} open />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("radio", { name: "Above level" }));
    await expect(c.getByRole("slider", { name: "Above" })).toBeVisible();
    // MX-33: Ducked by is an in-app menu: the current trigger checked, one another rule uses disabled with "already".
    await userEvent.click(c.getByRole("button", { name: /Ducked by/ }));
    const menu = within(document.body).getByRole("menu", { name: "Ducked by" });
    await expect(within(menu).getByRole("menuitemradio", { name: /Dialogue/ })).toHaveAttribute("aria-checked", "true");
    await expect(within(menu).getByRole("menuitemradio", { name: /Weapons/ })).toBeDisabled();
    await expect(within(menu).getByRole("menuitemradio", { name: /Weapons/ })).toHaveTextContent("already");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Music/ }));
    await expect(c.getByRole("button", { name: /Ducked by Music/ })).toBeVisible();
  },
};

export const AboveLevel: StoryObj = { render: () => <Demo start={{ ...presence, trigger: "Weapons", mode: "level", amountDb: -8 }} open /> };

export const Off: StoryObj = { render: () => <Demo start={{ ...presence, enabled: false }} /> };
