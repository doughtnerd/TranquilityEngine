// Stories (ADR 0219, 0355 §7, 0357 §6) for the test bench over the fixture event, with the path table highlighting the
// pick: Guard·Clear·Near says a weighted line with its subtitle; Say remembers it (avoid-repeat); Roll ×50 shows the
// distribution; Captain has no path; Sniper is an explicit silence.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { findLine, textThrough } from "../dialogueData";
import { fixtureData, fixtureDialogue } from "../dialogueFixture";
import type { EventContext } from "./eventsModel";
import { PathTableView } from "./PathTableView";
import { bench, benchAvailable, EMPTY_MEMORY, rememberSaid, roll, type RollBar } from "./testBench";
import { TestBenchView } from "./TestBenchView";
import "../dialogue.css";

const ctx: EventContext = { parameterLabels: () => null };

function Demo() {
  const data = fixtureData();
  const e = fixtureDialogue().events[0];
  const [values, setValues] = useState<Record<string, string>>({ speaker: "Guard", weather: "Clear", distance: "Near" });
  const [seed, setSeed] = useState(1);
  const [memory, setMemory] = useState(EMPTY_MEMORY);
  const [bars, setBars] = useState<RollBar[] | null>(null);
  const [now, setNow] = useState(0);
  const rules = (k: string) => findLine(data, k)?.line ?? null;
  const bctx = { seed, history: memory.history[e.name] ?? [], available: benchAvailable(memory, rules, now) };
  const view = bench(e, values, bctx);
  const ref = "key" in view.result ? findLine(data, view.result.key) : null;
  return (
    <div style={{ width: "1000px" }}>
      <TestBenchView
        event={e} ctx={ctx} values={values} seed={seed} view={view} preview="fr" bars={bars}
        subtitle={ref ? textThrough(data, ref, "fr")?.text ?? null : null}
        memory={Object.values(memory.history).flat()}
        onValue={(n, v) => setValues({ ...values, [n]: v })}
        onSeed={setSeed}
        onSay={() => { if ("key" in view.result) setMemory(rememberSaid(memory, e.name, view.result.key, now)); setNow(now + 10); setSeed(seed + 1); }}
        onRoll={() => setBars(roll(e, values, bctx))}
        onResetMemory={() => setMemory(EMPTY_MEMORY)}
      />
      <PathTableView event={e} ctx={ctx} parameters={[]} lints={[]} bench={view.rows} lineKeys={[]} recorded={() => true} preview="fr" readOnly
        impactOf={() => ({ refused: "read-only" })} onArgument={() => undefined} onEntry={() => undefined} onLines={() => undefined} onNumbers={() => undefined} onAddPath={() => undefined} onRemovePath={() => undefined} />
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Events/Test bench", component: TestBenchView };
export default meta;

export const TestBench: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByLabelText("Decision")).toHaveTextContent(/^Says (guard_01|intro_02) \(path Guard · \* · Near\)/);
    const paths = c.getByRole("table", { name: "Paths" });
    await expect(within(paths).getByRole("row", { name: /Path 1: Guard · \* · Near \(picked\)/ })).toHaveClass("picked");
    await expect(within(paths).getByRole("row", { name: /Path 3: Sniper/ })).toHaveTextContent("Sniper isn't speaker = Guard");

    await userEvent.click(c.getByRole("button", { name: "Say" }));
    await expect(c.getByText(/^Said:/)).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Roll ×50" }));
    const bars = c.getByLabelText("Pick distribution");
    await expect(within(bars).getByLabelText(/^guard_01: \d+ of 50$/)).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Reset memory" }));
    await expect(c.getByRole("button", { name: "Reset memory" })).toBeDisabled();

    await userEvent.selectOptions(c.getByRole("combobox", { name: "Bench speaker" }), "Captain");
    await waitFor(() => expect(c.getByLabelText("Decision")).toHaveTextContent("no path matches"));
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Bench speaker" }), "Sniper");
    await waitFor(() => expect(c.getByLabelText("Decision")).toHaveTextContent("an explicit silence"));
    await expect(within(paths).getByRole("row", { name: /Path 3: Sniper · \* · \* \(silence\)/ })).toHaveClass("silence");
  },
};
