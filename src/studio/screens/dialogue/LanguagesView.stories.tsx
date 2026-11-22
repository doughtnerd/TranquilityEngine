// Stories (ADR 0219, 0340 §1, §8) for the Languages tab: editing languages with no editor holding the project (add a
// regional language that falls back to its parent, change the chain), the read-only view while the editor holds the
// lock, and "Duck Music under Voice" adding an ordinary ducking rule.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { FIXTURE_LANGUAGES, fixtureData, fixtureLocalisation } from "./dialogueFixture";
import { languagesAccess } from "./languagesModel";
import { LanguagesView } from "./LanguagesView";
import { duckMusicUnder, duckOffer, unnormalised } from "./voiceMix";
import "./dialogue.css";

function Demo(props: { editorLock: "held" | "none" }) {
  const [languages, setLanguages] = useState(FIXTURE_LANGUAGES);
  const [audio, setAudio] = useState<AudioProject>(() => ({ ...parseAudioProject({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Voice", parent: "Master" }] }).project, localisation: fixtureLocalisation() }));
  const [preview, setPreview] = useState("en");
  const [said, setSaid] = useState("");
  const data = fixtureData({ languages, localisation: audio.localisation });
  return (
    <div style={{ width: "900px" }}>
      <LanguagesView
        languages={languages}
        access={languagesAccess({ canSave: true, editorLock: props.editorLock })}
        localisation={audio.localisation!}
        preview={preview}
        unnormalised={Object.fromEntries(languages.list.map((l) => [l.code, unnormalised(data, l.code).length]))}
        duckOffer={duckOffer(audio, data)}
        onLanguages={(label, edit) => {
          const r = edit(languages);
          if ("refused" in r) setSaid(`Can't ${label}: ${r.refused}`);
          else setLanguages(r.next);
        }}
        onAudio={(_label, edit) => {
          const r = edit(audio);
          if ("next" in r) setAudio(r.next);
        }}
        onPreview={setPreview}
        onNormalise={(code) => setSaid(`Normalise ${code}`)}
        onDuck={(bus) => {
          const r = duckMusicUnder(audio, bus);
          if ("next" in r) setAudio(r.next);
          setSaid(`${audio.ducking.length + 1} ducking rule`);
        }}
        onEditInEditor={() => setSaid("Open the editor's Project Settings")}
      />
      <p role="status">{said}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Languages", component: LanguagesView };
export default meta;

export const Editable: StoryObj = {
  render: () => <Demo editorLock="none" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.queryByRole("note", { name: "Languages are read-only" })).toBeNull();
    await userEvent.type(c.getByRole("textbox", { name: "New language code" }), "fr-be");
    await userEvent.click(c.getByRole("button", { name: "Add language" }));
    const table = c.getByRole("table", { name: "Languages" });
    await waitFor(() => expect(within(table).getByRole("rowheader", { name: "fr-BE" })).toBeInTheDocument());
    await expect(within(table).getByRole("textbox", { name: "Fallback of fr-BE" })).toHaveValue("fr");
    await expect(within(table).getByRole("row", { name: /fr-BE/ })).toHaveTextContent("fr-BE → fr → en");
    // The reference can't be removed; a refusal says why.
    await expect(within(table).getAllByRole("button", { name: "Remove" })[0]).toBeDisabled();
    await userEvent.click(c.getByRole("button", { name: "Duck Music under Voice" }));
    await waitFor(() => expect(c.queryByRole("button", { name: /Duck Music under/ })).toBeNull());
    await expect(c.getByRole("status")).toHaveTextContent("1 ducking rule");
    await userEvent.click(within(table).getAllByRole("button", { name: "Preview" })[1]);
    await expect(within(table).getByRole("rowheader", { name: "fr ·" })).toBeInTheDocument();
  },
};

export const EditorHoldsTheProject: StoryObj = {
  render: () => <Demo editorLock="held" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("note", { name: "Languages are read-only" })).toHaveTextContent("The editor has this project open");
    await expect(c.getByRole("checkbox", { name: "Ship de" })).toBeDisabled();
    await expect(c.getByRole("button", { name: "Add language" })).toBeDisabled();
    await userEvent.click(c.getByRole("button", { name: "Edit in the editor" }));
    await expect(c.getByRole("status")).toHaveTextContent("Project Settings");
  },
};
