// Stories (ADR 0219, 0355 §7) for the coverage report over the fixture event: gaps as compact patterns, the Sniper
// silence, combinations missing in French, an unused line and the CSV export.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { fixtureDialogue } from "../dialogueFixture";
import { eventCoverage } from "./coverage";
import { CoverageView } from "./CoverageView";
import "../dialogue.css";

function Demo() {
  const [said, setSaid] = useState("");
  const e = fixtureDialogue().events[0];
  const coverage = eventCoverage(e, { parameterLabels: () => null }, ["en", "fr"], (key, code) => code === "en" || key === "intro_01");
  return (
    <div style={{ width: "700px" }}>
      <CoverageView events={[coverage]} unusedLines={["breath_03"]} unnamedEvents={["enemy_spotted"]} onExport={() => setSaid("coverage.csv")} />
      <p role="status">{said}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Events/Coverage", component: CoverageView };
export default meta;

export const Coverage: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const gaps = c.getByRole("list", { name: "Gaps of enemy_spotted" });
    await expect(within(gaps).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Captain · * · *", "Guard · Clear · Far", "Guard · Fog · Far"]);
    await expect(c.getByText("Sniper · * · *")).toBeInTheDocument();
    await expect(c.getByRole("list", { name: "Missing in fr for enemy_spotted" })).toHaveTextContent("Guard · Clear · Near");
    await expect(c.queryByRole("list", { name: "Missing in en for enemy_spotted" })).toBeNull();
    await expect(c.getByLabelText("Events no script names")).toHaveTextContent("enemy_spotted");
    await userEvent.click(c.getByRole("button", { name: "Export coverage CSV" }));
    await expect(c.getByRole("status")).toHaveTextContent("coverage.csv");
  },
};
