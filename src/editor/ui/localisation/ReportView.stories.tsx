// Stories (ADR 0219) for the Localisation panel's Report tab over the fixture project: progress per language, the
// gathering's lists, dismissing unkeyed text, and running the fit check (the UI core's estimate as the measurer).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { gatherKeys } from "../../../engine/localisation/exchange/gather";
import { estimateText } from "../../../engine/ui/layout";
import { fitCheck, type FitResult } from "./fitCheck";
import { FIXTURE_FILES, FIXTURE_LANGUAGES, fixtureProject } from "./localisationFixture";
import { localisationReport } from "./reportModel";
import { ReportView } from "./ReportView";

const meta: Meta = { title: "Editor/Localisation/Report" };
export default meta;

function Demo() {
  const [ignore, setIgnore] = useState<string[]>([]);
  const [fit, setFit] = useState<FitResult | null>(null);
  const [opened, setOpened] = useState("");
  const gather = gatherKeys({ files: FIXTURE_FILES, languages: FIXTURE_LANGUAGES, ignore });
  const run = () => setFit(fitCheck({ project: fixtureProject(), documents: FIXTURE_FILES.filter(([p]) => p.endsWith(".ui.xml")) as [string, string][], read: () => null, measure: estimateText }));
  return (
    <div style={{ width: "720px" }}>
      <ReportView report={localisationReport(gather, fit)} fitting={false} fitted={fit !== null} onRunFit={run} onOpen={setOpened} onDismiss={(id) => setIgnore([...ignore, id])} />
      <output aria-label="Opened">{opened}</output>
    </div>
  );
}

export const Lists: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const undefinedKeys = c.getByRole("region", { name: "Keys defined nowhere" });
    await expect(undefinedKeys).toHaveTextContent("menu.missing");
    await userEvent.click(within(undefinedKeys).getByRole("button", { name: "menu.missing" }));
    await expect(c.getByLabelText("Opened")).toHaveTextContent("ui/menu.ui.xml");
    await expect(c.getByRole("region", { name: "Unused keys" })).toHaveTextContent("old.unused");
    await userEvent.click(c.getByRole("button", { name: 'Dismiss "Press any key"' }));
    await expect(c.getByRole("region", { name: "Unkeyed text" })).not.toHaveTextContent("Press any key");
    await userEvent.click(c.getByRole("button", { name: "Check text fit" }));
    await expect(c.getByRole("region", { name: "Text that doesn't fit" })).toHaveTextContent("menu.start");
  },
};
