// Stories (ADR 0219, 0340 §8–§9) for the Report tab over the fixture project: per-language counts, the French
// mismatch and script change, the CSV exports, and a script CSV import shown as a diff before Apply.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { formatCsv, parseCsv } from "./csv";
import { fixtureData } from "./dialogueFixture";
import { dialogueReport } from "./reportModel";
import { ReportView } from "./ReportView";
import { readScriptCsv, scriptCsv, type ScriptDiff } from "./scriptCsv";
import "./dialogue.css";

function Demo() {
  const data = fixtureData();
  const [pending, setPending] = useState<ScriptDiff | null>(null);
  const [said, setSaid] = useState("");
  return (
    <div style={{ width: "900px" }}>
      <button onClick={() => {
        const rows = parseCsv(scriptCsv(data));
        rows[1][2] = "Ava Grey";
        rows.push(["intro_03", "ch1", "Ava", "", "Now!", "", "", ""]);
        setPending(readScriptCsv(data, formatCsv(rows)));
      }}>Pretend import</button>
      <ReportView
        report={dialogueReport(data)}
        pending={pending}
        onExportReport={() => setSaid("report.csv")}
        onExportScript={() => setSaid("script.csv")}
        onImportScript={(text) => setPending(readScriptCsv(data, text))}
        onApplyScript={(remove) => { setSaid(`applied${remove ? " with removal" : ""}`); setPending(null); }}
        onCancelScript={() => setPending(null)}
        oldText={said === "moved" ? 0 : 2}
        onMoveSubtitles={() => setSaid("moved")}
      />
      <p role="status">{said}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Report", component: ReportView };
export default meta;

export const Report: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const table = c.getByRole("table", { name: "Lines per language" });
    await expect(within(table).getByRole("row", { name: /Français \(fr\)/ })).toHaveTextContent("2 / 4");
    await expect(within(table).getByRole("row", { name: /Deutsch \(de\) · not shipped/ })).toBeInTheDocument();
    const fr = c.getByRole("region", { name: "Report for fr" });
    await expect(fr).toHaveTextContent("Duration mismatch (1)");
    await expect(fr).toHaveTextContent("Script changed (1)");
    await userEvent.click(c.getByRole("button", { name: "Export report CSV" }));
    await expect(c.getByRole("status")).toHaveTextContent("report.csv");

    await userEvent.click(c.getByRole("button", { name: "Pretend import" }));
    const diff = c.getByRole("table", { name: "Script changes" });
    await expect(within(diff).getByRole("row", { name: /intro_03/ })).toHaveTextContent("added");
    await expect(within(diff).getByRole("row", { name: /intro_01/ })).toHaveTextContent("changed speaker");
    await userEvent.click(c.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(c.queryByRole("region", { name: "Script import" })).toBeNull());
    await expect(c.getByRole("status")).toHaveTextContent("applied");

    // 0343 §1: subtitles left in a line table are moved into the string table.
    await expect(c.getByRole("note", { name: "Subtitles in line tables" })).toHaveTextContent("2 lines keep their subtitles");
    await userEvent.click(c.getByRole("button", { name: "Move subtitles to the string table" }));
    await waitFor(() => expect(c.queryByRole("note", { name: "Subtitles in line tables" })).toBeNull());
  },
};
