// Stories (ADR 0219) for the Localisation panel's Exchange tab over the fixture project: choose an export, then import
// a PO file and read its preview (a new translation, one from older reference text marked for review, a message that
// fails the checks, an unknown key) before applying.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { ImportPreview } from "../../../engine/localisation/exchange/importPreview";
import { exportFiles, importPreviewOf } from "./exchangeModel";
import { ExchangeView, type ExportChoice } from "./ExchangeView";
import { fixtureProject } from "./localisationFixture";

const meta: Meta = { title: "Editor/Localisation/Exchange" };
export default meta;

const PO = `msgid ""
msgstr ""
"Language: fr\\n"

msgctxt "old.unused"
msgid "Nobody uses me"
msgstr "Personne ne m'utilise"

msgctxt "menu.quit"
msgid "Quit"
msgstr "Quitter la partie"

msgctxt "hud.coins"
msgid "{count, plural, one {# coin} other {# coins}}"
msgstr "{count, plural, one {# pièce} other {# pièces}}"

msgctxt "nope"
msgid "x"
msgstr "y"
`;

function Demo() {
  const [choice, setChoice] = useState<ExportChoice>({ format: "xliff", tables: [], languages: [], onlyNeedsWork: false });
  const [preview, setPreview] = useState<{ p: ImportPreview; names: string[] } | null>(null);
  const [said, setSaid] = useState("");
  const project = fixtureProject();
  return (
    <div style={{ width: "900px" }}>
      <ExchangeView
        tables={project.tables.map((t) => t.path)}
        languages={[{ code: "fr", name: "Français" }, { code: "ar", name: "العربية" }]}
        choice={choice}
        onChoice={setChoice}
        onExport={() => setSaid(exportFiles(project, choice.format, choice).map((f) => f.name).join(", "))}
        preview={preview?.p ?? null}
        importing={preview?.names ?? []}
        blocked={[]}
        onPickFiles={(files) => setPreview({ p: importPreviewOf(project, files), names: files.map((f) => f.name) })}
        onApply={() => {
          setSaid(`applied ${preview!.p.changes.length}`);
          setPreview(null);
        }}
        onCancel={() => setPreview(null)}
        canImport
      />
      <output aria-label="Said">{said}</output>
    </div>
  );
}

export const ExportAndImport: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("radio", { name: "PO" }));
    await userEvent.click(c.getByRole("checkbox", { name: "Français (fr)" }));
    await userEvent.click(c.getByRole("button", { name: "Export" }));
    await expect(c.getByLabelText("Said")).toHaveTextContent("strings.fr.po, strings.pot");
    await userEvent.upload(c.getByLabelText("Pick translation files"), new File([PO], "game.fr.po", { type: "text/plain" }));
    const preview = await c.findByLabelText("Import preview");
    await expect(preview).toHaveTextContent("1 new, 1 changed");
    await expect(preview).toHaveTextContent("needs review (older reference)");
    await expect(preview).toHaveTextContent("2 skipped: 1 fails the message checks, 1 unknown key");
    await userEvent.click(c.getByRole("button", { name: "Apply 2 changes" }));
    await expect(c.getByLabelText("Said")).toHaveTextContent("applied 2");
  },
};
