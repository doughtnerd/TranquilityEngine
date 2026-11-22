// Stories (ADR 0219, 0340 §9) for batch import over the fixture project: a French delivery matched by `{lang}/{key}`,
// then by `{key}_{lang}`; an unknown key skipped, then created as a row; a bad pattern refused.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { previewBatch } from "./batchImport";
import { BatchImportDialog } from "./BatchImportDialog";
import { fixtureData, TABLE_PATH } from "./dialogueFixture";
import "./dialogue.css";

const BY_FOLDER = ["fr/intro_02.wav", "fr/intro_01.wav", "fr/nobody.wav", "es/intro_01.wav"];
const BY_SUFFIX = ["intro_02_fr.wav", "guard_01_de.ogg"];

function Demo() {
  const data = fixtureData();
  const [files, setFiles] = useState(BY_FOLDER);
  const [pattern, setPattern] = useState("{lang}/{key}");
  const [language, setLanguage] = useState("en");
  const [createIn, setCreateIn] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  return (
    <div>
      <button onClick={() => { setFiles(BY_SUFFIX); setPattern("{key}_{lang}"); }}>Second delivery</button>
      <p aria-label="Result">{said}</p>
      <BatchImportDialog
        files={files} pattern={pattern} language={language} createIn={createIn}
        preview={previewBatch(data, files, pattern, { language, createIn })}
        tables={[TABLE_PATH]} languages={data.languages.list}
        onPick={(picked) => setFiles(picked.map((f) => f.name))}
        onPattern={setPattern} onLanguage={setLanguage} onCreateIn={setCreateIn}
        onApply={() => setSaid("imported")} onCancel={() => setSaid("cancelled")}
      />
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Batch import", component: BatchImportDialog };
export default meta;

export const BatchImport: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const preview = () => c.getByRole("table", { name: "Import preview" });
    await expect(within(preview()).getByRole("row", { name: /fr\/intro_02.wav/ })).toHaveTextContent("audio/vo/fr/ch1/intro_02.wav");
    await expect(within(preview()).getByRole("row", { name: /fr\/intro_01.wav/ })).toHaveTextContent("replace");
    await expect(within(preview()).getByRole("row", { name: /es\/intro_01.wav/ })).toHaveTextContent("unknown language");
    await expect(c.getByRole("button", { name: "Import 2 files" })).toBeEnabled();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Unknown keys" }), TABLE_PATH);
    await waitFor(() => expect(c.getByRole("button", { name: "Import 3 files" })).toBeEnabled());
    await expect(within(preview()).getByRole("row", { name: /fr\/nobody.wav/ })).toHaveTextContent("new row in ch1");

    const pattern = c.getByRole("textbox", { name: "Naming pattern" });
    await userEvent.clear(pattern);
    await userEvent.type(pattern, "{{lang}");
    await expect(c.getByRole("alert")).toHaveTextContent("a pattern needs {key}");

    await userEvent.click(c.getByRole("button", { name: "Second delivery" }));
    await waitFor(() => expect(within(preview()).getByRole("row", { name: /intro_02_fr.wav/ })).toHaveTextContent("audio/vo/fr/ch1/intro_02.wav"));
    await expect(within(preview()).getByRole("row", { name: /guard_01_de.ogg/ })).toHaveTextContent("audio/vo/de/ch1/guard_01.ogg");
    await userEvent.click(c.getByRole("button", { name: "Import 2 files" }));
    await expect(c.getByLabelText("Result")).toHaveTextContent("imported");
  },
};
