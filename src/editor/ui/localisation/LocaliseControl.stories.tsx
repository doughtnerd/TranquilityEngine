// Stories (ADR 0219) for the Inspector's Localise control over the fixture project: pick a key by searching its text
// (with the French preview), extract literal text to a table under the suggested key, and keyed text with Unlink
// (ADR 0356 §9, 0423 wave F: Svelte UI's literal text).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { fixtureProject } from "./localisationFixture";
import { keyMatches, keyPreview, suggestKey, suggestTable } from "./localiseKeys";
import { LocaliseControl } from "./LocaliseControl";

const meta: Meta = { title: "Editor/Localisation/Localise control" };
export default meta;

function Demo(props: { literal: string | null }) {
  const project = fixtureProject();
  const [bound, setBound] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  return (
    <div style={{ width: "320px" }}>
      <LocaliseControl
        field="text"
        boundKey={bound}
        boundPreview={bound ? keyPreview(project, bound, "fr") : null}
        previewLanguage="fr"
        literal={props.literal}
        findKeys={(s) => keyMatches(project, s, "fr")}
        tables={project.tables.map((t) => t.path)}
        suggestedTable={suggestTable(project, "ui/Menu.svelte")}
        suggestedKey={suggestKey(project, "ui/Menu.svelte", "hint", "p", "text")}
        disabled={null}
        onPick={setBound}
        onUnlink={() => setBound(null)}
        onExtract={(table, key) => {
          setSaid(`${key} in ${table}`);
          setBound(key);
        }}
      />
      <output aria-label="Said">{said}</output>
    </div>
  );
}

export const PickAndUnlink: StoryObj = {
  render: () => <Demo literal="Quit game" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Localise…" }));
    await userEvent.type(c.getByRole("searchbox", { name: "Find a key" }), "quitter");
    const keys = c.getByRole("list", { name: "Keys" });
    await expect(keys).toHaveTextContent("menu.quit");
    await userEvent.click(within(keys).getByRole("button"));
    await expect(c.getByText("fr: Quitter")).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Unlink" }));
    await expect(await c.findByRole("button", { name: "Localise…" })).toBeInTheDocument();
  },
};

export const Extract: StoryObj = {
  render: () => <Demo literal="Press any key" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Extract to string table…" }));
    await expect(c.getByRole("textbox", { name: "New key" })).toHaveValue("menu.hint");
    await expect(c.getByRole("combobox", { name: "String table" }) /* an input with a list of tables */).toHaveValue("strings/menu.strings.json");
    await userEvent.click(c.getByRole("button", { name: "Extract" }));
    await expect(c.getByLabelText("Said")).toHaveTextContent("menu.hint in strings/menu.strings.json");
  },
};
