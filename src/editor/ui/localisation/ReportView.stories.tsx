// Stories (ADR 0219) for the Localisation panel's Report tab over the fixture project: progress per language and the
// gathering's lists, each row opening its file.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { gatherKeys } from "../../../engine/localisation/exchange/gather";
import { FIXTURE_FILES, FIXTURE_LANGUAGES } from "./localisationFixture";
import { localisationReport } from "./reportModel";
import { ReportView } from "./ReportView";

const meta: Meta = { title: "Editor/Localisation/Report" };
export default meta;

function Demo() {
  const [opened, setOpened] = useState("");
  const gather = gatherKeys({ files: FIXTURE_FILES, languages: FIXTURE_LANGUAGES });
  return (
    <div style={{ width: "720px" }}>
      <ReportView report={localisationReport(gather)} onOpen={setOpened} />
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
    await expect(c.getByLabelText("Opened")).toHaveTextContent("ui/Menu.svelte");
    await expect(c.getByRole("region", { name: "Unused keys" })).toHaveTextContent("old.unused");
  },
};
