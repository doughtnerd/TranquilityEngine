// Stories (ADR 0219, 0340 §9, 0343 §6) for the Dialogue screen's Lines tab over the fixture project: status cells per
// language (recorded, heard in another language, mismatch, script changed, reading speed), search and the column filter,
// a refused key rename, and a text edit that lands in the string table.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { findLine } from "./dialogueData";
import { fixtureData, fixtureStrings, fixtureTable, TABLE_PATH } from "./dialogueFixture";
import { ALL_LINES, addLine, filterOptions, filterRows, lineRows, renameLine, textEdit, usedKeys, type LinesQuery } from "./linesModel";
import { LinesView } from "./LinesView";
import "./dialogue.css";

function Demo() {
  const [table, setTable] = useState(fixtureTable);
  const [strings, setStrings] = useState(fixtureStrings);
  const [query, setQuery] = useState<LinesQuery>(ALL_LINES);
  const [selected, setSelected] = useState<string | null>("intro_01");
  const [said, setSaid] = useState("");
  const data = fixtureData({ table, strings });
  const rows = lineRows(data, "en");
  const apply = (r: { next: typeof table } | { refused: string }) => ("refused" in r ? setSaid(`Can't: ${r.refused}`) : setTable(r.next));
  return (
    <div style={{ width: "980px" }}>
      <LinesView
        rows={filterRows(rows, query)}
        total={rows.length}
        filters={filterOptions(data, rows)}
        tables={[TABLE_PATH]}
        speakers={{ [TABLE_PATH]: table.speakers }}
        languages={data.languages.list}
        preview="en"
        query={query}
        selected={selected}
        onQuery={setQuery}
        onSelect={setSelected}
        onAdd={() => apply(addLine(table, usedKeys(data), selected))}
        onDuplicate={() => undefined}
        onDelete={() => undefined}
        onRename={(key, to) => apply(renameLine(table, key, to, usedKeys(data)))}
        onSpeaker={() => undefined}
        onText={(key, text) => {
          const r = textEdit(data, findLine(data, key)!, "en", text);
          if ("refused" in r) setSaid(r.refused);
          else if (r.next.kind === "strings") setStrings(r.next.next);
        }}
      />
      <p role="status">{said}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Lines", component: LinesView };
export default meta;

export const Lines: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const table = c.getByRole("table", { name: "Lines" });
    await expect(within(table).getByRole("cell", { name: /intro_01 in fr: Recorded.*duration 2.4 s, reference 1.2 s/ })).toHaveTextContent("✓ ⚠");
    await expect(within(table).getByRole("cell", { name: /intro_01 in fr-CA: Heard in fr/ })).toHaveTextContent("→fr");
    await expect(within(table).getByRole("cell", { name: /guard_01 in fr: .*reference text changed/ })).toHaveTextContent("✎");
    await expect(within(table).getByRole("cell", { name: /intro_02 in en: .*29 cps, max 15/ })).toBeInTheDocument();

    // Search and the column filter.
    await userEvent.type(c.getByRole("searchbox", { name: "Search lines" }), "halt");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2));
    await userEvent.clear(c.getByRole("searchbox", { name: "Search lines" }));
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Show" }), "missing:fr");
    await waitFor(() => expect(within(table).queryByRole("textbox", { name: "Key of intro_01" })).toBeNull());
    await expect(within(table).getByRole("textbox", { name: "Key of intro_02" })).toBeInTheDocument();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Show" }), "all");

    // A key already used is refused; the text edit writes the string table.
    const key = within(table).getByRole("textbox", { name: "Key of intro_01" });
    await userEvent.clear(key);
    await userEvent.type(key, "guard_01{Enter}");
    await expect(c.getByRole("status")).toHaveTextContent('"guard_01" is already a line key');
    const text = within(table).getByRole("textbox", { name: "Text of guard_01" });
    await userEvent.clear(text);
    await userEvent.type(text, "Stop right there!{Enter}");
    await waitFor(() => expect(within(table).getByRole("textbox", { name: "Text of guard_01" })).toHaveValue("Stop right there!"));
    await userEvent.click(c.getByRole("button", { name: "Add line" }));
    await expect(within(table).getByRole("textbox", { name: "Key of line_05" })).toBeInTheDocument();
  },
};
