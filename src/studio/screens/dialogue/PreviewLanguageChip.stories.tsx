// Stories (ADR 0219, 0354 §1) for the header's preview-language chip: choosing a language, and no chip for a project
// with one language.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { defaultLanguages } from "../../../engine/localisation/languages";
import { FIXTURE_LANGUAGES } from "./dialogueFixture";
import { PreviewLanguageChip } from "./PreviewLanguageChip";

function Demo() {
  const [value, setValue] = useState("en");
  return (
    <div>
      <PreviewLanguageChip languages={FIXTURE_LANGUAGES.list} value={value} onChange={setValue} />
      <p aria-label="Chosen">{value}</p>
      <div aria-label="Single"><PreviewLanguageChip languages={defaultLanguages().list} value="en" onChange={() => undefined} /></div>
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Preview language chip", component: PreviewLanguageChip };
export default meta;

export const Chip: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Preview language" });
    await expect(within(select).getByRole("option", { name: "de (not shipped)" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "fr-CA");
    await expect(c.getByLabelText("Chosen")).toHaveTextContent("fr-CA");
    await expect(c.getByLabelText("Single")).toBeEmptyDOMElement();
  },
};
