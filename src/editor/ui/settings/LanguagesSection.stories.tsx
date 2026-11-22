// Stories (ADR 0219) for Project Settings > Languages and > Subtitles, each over a draft held by the story (the Project
// panel holds it in the editor): add a language, mark one as not recorded, switch voice to separate; set the subtitle
// size and add a speaker the line tables name.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { SettingsDraft } from "../../projectSettingsModel";
import { LanguagesSection } from "./LanguagesSection";
import { SubtitlesSection } from "./SubtitlesSection";

const meta: Meta = { title: "Editor/Project settings/Languages and subtitles" };
export default meta;

const START: SettingsDraft = { languages: { list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], reference: "en", default: "en" } };

function LanguagesDemo() {
  const [draft, setDraft] = useState<SettingsDraft>(START);
  return (
    <div class="project-settings" style={{ width: "760px" }}>
      <LanguagesSection draft={draft} problems={[]} set={(_label, d) => setDraft(d)} refresh={() => setDraft({ ...draft })} files={["fonts/NotoSansJP-Regular.woff2", "strings/menu.strings.json"]} />
      <pre aria-label="Written">{JSON.stringify(draft.languages)}</pre>
    </div>
  );
}

export const Languages: StoryObj = {
  render: () => <LanguagesDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByRole("textbox", { name: "New language code" }), "ja{Enter}");
    await expect(c.getByRole("textbox", { name: "ja code" })).toBeInTheDocument();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Add a font to ja" }), "fonts/NotoSansJP-Regular.woff2");
    await userEvent.click(c.getByRole("checkbox", { name: "ja has voice-over" }));
    await userEvent.click(c.getByRole("radio", { name: "Separate" }));
    const written = c.getByLabelText("Written");
    await expect(written).toHaveTextContent('"fonts":["fonts/NotoSansJP-Regular.woff2"],"voice":false');
    await expect(written).toHaveTextContent('"voice":"separate"');
    await expect(c.getByRole("button", { name: "Remove en" })).toBeDisabled();
  },
};

function SubtitlesDemo() {
  const [draft, setDraft] = useState<SettingsDraft>({});
  const files: [string, unknown][] = [["audio/vo/ch1.lines.json", { lines: [{ key: "intro_01", speaker: "Ava" }] }]];
  return (
    <div class="project-settings" style={{ width: "560px" }}>
      <SubtitlesSection draft={draft} problems={[]} set={(_label, d) => setDraft(d)} refresh={() => setDraft({ ...draft })} files={files} />
      <pre aria-label="Written">{JSON.stringify(draft.subtitles ?? null)}</pre>
    </div>
  );
}

export const Subtitles: StoryObj = {
  render: () => <SubtitlesDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Size" }), "large");
    await userEvent.type(c.getByRole("textbox", { name: "New speaker id" }), "Ava{Enter}");
    await expect(c.getByRole("table", { name: "Speakers" })).toHaveTextContent("Ava");
    await expect(c.getByLabelText("Written")).toHaveTextContent('{"defaults":{"size":"large"},"speakers":{"Ava":{}}}');
  },
};
