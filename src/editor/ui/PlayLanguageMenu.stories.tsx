// Stories (ADR 0219) for the Play toolbar's Language menu (shipped languages, then the pseudo-languages) and the
// Subtitles overlay toggle.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { parseLanguages } from "../../engine/localisation/languages";
import { playLanguageChoices } from "../playLanguage";
import { PlayLanguageMenu, SubtitlesOverlayToggle } from "./PlayLanguageMenu";

const meta: Meta = { title: "Editor/Play toolbar/Language and subtitles" };
export default meta;

const languages = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }, { code: "ar", name: "العربية" }], reference: "en" }).languages;

function Demo() {
  const [code, setCode] = useState("en");
  const [on, setOn] = useState(false);
  return (
    <div class="group play-controls" style={{ display: "flex", gap: "6px" }}>
      <PlayLanguageMenu choices={playLanguageChoices(languages)} value={code} onChange={setCode} />
      <SubtitlesOverlayToggle on={on} unavailable={null} onToggle={setOn} />
      <output aria-label="Chosen">{code}</output>
    </div>
  );
}

export const Menu: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Preview language" });
    await expect(c.getByRole("option", { name: "Pseudo, right to left" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "qps-ploc");
    await expect(c.getByLabelText("Chosen")).toHaveTextContent("qps-ploc");
    await userEvent.click(c.getByRole("button", { name: "Subtitles" }));
    await expect(c.getByRole("button", { name: "Subtitles" })).toHaveAttribute("aria-pressed", "true");
  },
};
