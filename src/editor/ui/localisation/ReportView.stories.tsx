// Stories (ADR 0219) for the Localisation panel's Report tab over the fixture project: progress per language and the
// gathering's lists, each row opening its file (at its line), Svelte UI's unkeyed text with Dismiss, and running the fit
// check (a fixed box for the component's `#start`, the UI core's estimate as the measurer) (ADR 0356 §7–§9, 0419 wave F).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useEffect, useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { gatherKeys } from "../../../engine/localisation/exchange/gather";
import { UI_LINE_HEIGHT } from "../../../engine/ui/elementKinds";
import { UI_FONT_FAMILY } from "../../../engine/ui/fonts";
import { estimateText } from "../../../engine/ui/layout";
import { unkeyedTextIn } from "../../uiEdit/svelteStrings";
import { loadSvelteParser, parseSvelte, svelteParserLoaded } from "../../uiEdit/svelteText";
import { FIXTURE_FILES, FIXTURE_LANGUAGES, fixtureProject } from "./localisationFixture";
import { localisationReport } from "./reportModel";
import { ReportView } from "./ReportView";
import { fitCheck, type FitResult } from "./textFit";

const meta: Meta = { title: "Editor/Localisation/Report" };
export default meta;

const MENU = FIXTURE_FILES.find(([p]) => p === "ui/Menu.svelte")![1] as string;

function Demo() {
  const [ready, setReady] = useState(svelteParserLoaded());
  const [ignore, setIgnore] = useState<string[]>([]);
  const [fit, setFit] = useState<FitResult | null>(null);
  const [opened, setOpened] = useState("");
  useEffect(() => void loadSvelteParser().then(() => setReady(true)), []);
  const gather = gatherKeys({ files: FIXTURE_FILES, languages: FIXTURE_LANGUAGES });
  const unkeyed = ready ? unkeyedTextIn("ui/Menu.svelte", parseSvelte(MENU)) : [];
  const run = () =>
    setFit(fitCheck({
      project: fixtureProject(),
      targets: [{ path: "ui/Menu.svelte", where: "#start", line: 5, key: "menu.start", run: { fontSize: 16, fontWeight: "400", fontFamily: UI_FONT_FAMILY, lineHeight: UI_LINE_HEIGHT, wrap: "word" }, box: { width: 60, height: 20 } }],
      measure: estimateText,
    }));
  return (
    <div style={{ width: "720px" }}>
      <ReportView
        report={localisationReport(gather, { unkeyed, ignore, fit })}
        fitting={false}
        fitted={fit !== null}
        onRunFit={run}
        onOpen={(path, line) => setOpened(line ? `${path}:${line}` : path)}
        onDismiss={(id) => setIgnore([...ignore, id])}
      />
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
    await expect(c.getByLabelText("Opened")).toHaveTextContent("ui/Menu.svelte:6");
    await expect(c.getByRole("region", { name: "Unused keys" })).toHaveTextContent("old.unused");
    const unkeyed = c.getByRole("region", { name: "Unkeyed text" });
    await expect(await within(unkeyed).findByRole("button", { name: "Press any key" })).toBeInTheDocument();
    await userEvent.click(within(unkeyed).getByRole("button", { name: "Press any key" }));
    await expect(c.getByLabelText("Opened")).toHaveTextContent("ui/Menu.svelte:7");
    await userEvent.click(c.getByRole("button", { name: 'Dismiss "Press any key"' }));
    await expect(c.getByRole("region", { name: "Unkeyed text" })).not.toHaveTextContent("Press any key");
    await userEvent.click(c.getByRole("button", { name: "Check text fit" }));
    await expect(c.getByRole("region", { name: "Text that doesn't fit" })).toHaveTextContent("menu.start");
  },
};
