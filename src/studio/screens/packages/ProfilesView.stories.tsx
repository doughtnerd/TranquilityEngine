// Stories (ADR 0219, 0337 §2, §6) for the Packages screen's Profiles and rules tab over the story project, edited through
// the screen's model: the default marked, a profile's key set for Android only (the profile's own value shown beside),
// back to Inherit, a profile in use refused on delete, a new rule with its preview, and rule order (first match wins).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { STORY_FILES, storyProject } from "./packagesStoryData";
import { addProfile, addRule, configOfDoc, deleteProfile, moveRule, removeRule, renameProfile, rulePreview, setDefaultProfile, setProfileKey, updateRule } from "./profilesModel";
import { ProfilesView, type ProfileScope } from "./ProfilesView";
import "../samples/samples.css";
import "./packages.css";

function Demo() {
  const [p, setP] = useState<AudioProject>(storyProject);
  const [selected, setSelected] = useState<string | null>("Default");
  const [scope, setScope] = useState<ProfileScope>("all");
  const [refused, setRefused] = useState("");
  const apply = (r: EditResult<AudioProject>) => ("refused" in r ? setRefused(r.refused) : (setRefused(""), setP(r.next)));
  const config = configOfDoc(p);
  return (
    <div style={{ width: "900px" }}>
      <ProfilesView
        config={config}
        previews={rulePreview(config, STORY_FILES)}
        selected={selected}
        scope={scope}
        onSelect={setSelected}
        onScope={setScope}
        onAdd={() => apply(addProfile(p))}
        onRename={(from, to) => apply(renameProfile(p, from, to))}
        onDelete={(n) => apply(deleteProfile(p, n))}
        onDefault={(n) => apply(setDefaultProfile(p, n))}
        onKey={(name, platform, key, value) => apply(setProfileKey(p, name, platform, key, value))}
        onAddRule={(path, profile) => apply(addRule(p, path, profile))}
        onUpdateRule={(i, patch) => apply(updateRule(p, i, patch))}
        onMoveRule={(i, d) => apply(moveRule(p, i, d))}
        onRemoveRule={(i) => apply(removeRule(p, i))}
      />
      <output aria-label="Refused">{refused}</output>
    </div>
  );
}

const meta: Meta = { title: "Studio/Packages/Profiles", component: ProfilesView };
export default meta;

export const Profiles: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const list = c.getByRole("listbox", { name: "Encoding profiles" });
    await expect(within(list).getByRole("option", { name: /Default/ })).toHaveTextContent("Default");

    // Music, quality for Android only: the profile's own value stays for the others.
    await userEvent.click(within(list).getByRole("option", { name: /Music/ }));
    await userEvent.click(within(c.getByRole("radiogroup", { name: "Edit for" })).getByRole("radio", { name: "Android" }));
    const keys = c.getByRole("table", { name: "Music for Android" });
    const quality = within(keys).getByRole("spinbutton", { name: "Quality" });
    await expect(quality).toHaveValue(null);
    await expect(within(keys).getByRole("row", { name: /Quality/ })).toHaveTextContent("profile: 0.6");
    await userEvent.clear(quality);
    await userEvent.type(quality, "0.3");
    quality.blur();
    await waitFor(() => expect(within(keys).getByRole("spinbutton", { name: "Quality" })).toHaveValue(0.3));
    await userEvent.click(within(keys).getByRole("button", { name: "Inherit quality" }));
    await waitFor(() => expect(within(keys).getByRole("spinbutton", { name: "Quality" })).toHaveValue(null));

    // Default is in use: the delete is refused with who uses it.
    await userEvent.click(within(list).getByRole("option", { name: /Default/ }));
    await userEvent.click(c.getByRole("button", { name: "Delete" }));
    await expect(c.getByLabelText("Refused")).toHaveTextContent("the default, rule audio/**/*.wav use it");

    // Rules: what each catches; a new rule; order.
    const rules = c.getByRole("table", { name: "Rules" });
    await expect(within(rules).getAllByRole("row")[1]).toHaveTextContent("2 files");
    await userEvent.type(c.getByRole("textbox", { name: "New rule path" }), "audio/amb/**");
    await userEvent.click(c.getByRole("button", { name: "Add rule for Default" }));
    await waitFor(() => expect(within(rules).getAllByRole("row")).toHaveLength(5));
    await expect(within(rules).getAllByRole("row")[4]).toHaveTextContent("taken by an earlier rule");
    await userEvent.click(c.getByRole("button", { name: "Move rule 4 up" }));
    await waitFor(() => expect(within(rules).getAllByRole("row")[3]).toHaveTextContent("2 files"));
    await expect(within(rules).getAllByRole("row")[4]).toHaveTextContent("1 file");
  },
};
