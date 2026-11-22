// Stories (ADR 0219) for the Localisation panel's Strings tab over a fixture project held by the story (the panel
// writes through asset documents in the editor): translate a missing key, see a broken message's check error inline,
// filter to what needs review, add a key, and a Studio-owned table shown read-only.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { translationPath, type StringTable } from "../../../engine/localisation/strings/format";
import type { TranslationFile } from "../../../engine/localisation/strings/translation";
import { languageOf } from "../../../engine/localisation/languages";
import type { EditResult } from "./editResult";
import { exchangeProjectOf } from "./localisationData";
import { FIXTURE_FILES, FIXTURE_LANGUAGES } from "./localisationFixture";
import { addKey, ALL_STRINGS, deleteKey, duplicateKey, filterRows, renameKey, setMaxLength, setNotes, setReferenceText, setReviewed, setTranslation, stringRows, type KeyChange, type StringsQuery } from "./stringsModel";
import { StringsView } from "./StringsView";

const meta: Meta = { title: "Editor/Localisation/Strings" };
export default meta;

function Demo(props: { studioRunning?: boolean }) {
  const [files, setFiles] = useState<[string, unknown][]>(FIXTURE_FILES);
  const [query, setQuery] = useState<StringsQuery>(ALL_STRINGS);
  const [said, setSaid] = useState("");
  const data = exchangeProjectOf(FIXTURE_LANGUAGES, files);
  const put = (path: string, value: unknown) => setFiles((fs) => [...fs.filter(([p]) => p !== path), [path, value]]);
  const table = (path: string, r: EditResult<StringTable>) => ("refused" in r ? setSaid(r.refused) : put(path, r.next));
  const tr = (path: string, r: EditResult<TranslationFile>) => ("refused" in r ? setSaid(r.refused) : put(translationPath(path, r.next.language), r.next));
  const change = (path: string, r: EditResult<KeyChange>) => {
    if ("refused" in r) return setSaid(r.refused);
    put(path, r.next.table);
    for (const t of Object.values(r.next.translations)) put(translationPath(path, t.language), t);
  };
  const named = (code: string) => ({ code, name: languageOf(FIXTURE_LANGUAGES, code)!.name, direction: languageOf(FIXTURE_LANGUAGES, code)!.direction });
  const rows = stringRows(data);
  return (
    <div style={{ width: "1100px", height: "520px", display: "flex", flexDirection: "column" }}>
      <StringsView
        tables={data.tables.map((t) => {
          const ro = props.studioRunning && t.path.startsWith("audio/");
          return { path: t.path, keys: t.table.strings.length, readOnly: ro ? "The Audio Studio has this project open, and this table holds subtitles, which are the Studio's: edit them there." : null, editInStudio: !!ro };
        })}
        reference={named("en")}
        languages={["fr", "ar"].map(named)}
        rows={filterRows(rows, query)}
        total={rows.length}
        query={query}
        onQuery={setQuery}
        onAddKey={(t, k) => table(t, addKey(data, t, k))}
        onRenameKey={(t, k, n) => change(t, renameKey(data, t, k, n))}
        onDuplicateKey={(t, k) => table(t, duplicateKey(data, t, k))}
        onDeleteKey={(t, k) => change(t, deleteKey(data, t, k))}
        onReferenceText={(t, k, v) => table(t, setReferenceText(data, t, k, v))}
        onNotes={(t, k, v) => table(t, setNotes(data, t, k, v))}
        onMaxLength={(t, k, v) => table(t, setMaxLength(data, t, k, v))}
        onTranslation={(t, k, c, v) => tr(t, setTranslation(data, t, k, c, v))}
        onReviewed={(t, k, c, on) => tr(t, setReviewed(data, t, k, c, on))}
        onEditInStudio={() => setSaid("opened the Studio")}
      />
      <output aria-label="Said">{said}</output>
    </div>
  );
}

export const Editing: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('"n" isn\'t an argument of the reference text')).toBeInTheDocument();
    const ar = c.getByRole("textbox", { name: "menu.start in ar" });
    await expect(ar).toHaveAttribute("dir", "rtl");
    await userEvent.type(ar, "ابدأ{Enter}");
    await expect(canvasElement.querySelector('tr[data-key="menu.start"] .loc-status')).toHaveTextContent("Translated");
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Filter" }), "needsReview");
    await expect(c.getByText("1 of 5 keys")).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Mark menu.quit in fr as reviewed" }));
    await expect(c.getByText("0 of 5 keys")).toBeInTheDocument();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Filter" }), "all");
    await userEvent.type(c.getByRole("textbox", { name: "New key" }), "intro_01{Enter}");
    await expect(c.getByLabelText("Said")).toHaveTextContent("keys are unique across the project");
  },
};

export const StudioTableReadOnly: StoryObj = {
  render: () => <Demo studioRunning />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Table" }), "audio/vo/ch1.strings.json");
    await expect(c.getByRole("note")).toHaveTextContent("The Audio Studio has this project open");
    await expect(c.getByRole("textbox", { name: "intro_01 in fr" })).toBeDisabled();
    await userEvent.click(c.getByRole("button", { name: "Edit in the Studio" }));
    await expect(c.getByLabelText("Said")).toHaveTextContent("opened the Studio");
  },
};
