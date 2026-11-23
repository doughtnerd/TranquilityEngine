// Stories (ADR 0219, 0351 §6) for the Packages screen's package list over the story project, edited through the
// screen's model: New package, rename with F2 (a duplicate name refused), delete from the menu, a package that doesn't
// ship on Android dimmed.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { PackageListView } from "./PackageListView";
import { addPackage, addToPackage, deletePackage, packageList, renamePackage } from "./packagesModel";
import { STORY_FILES, storyDeps, storyProject } from "./packagesStoryData";
import "../samples/samples.css";
import "./packages.css";

function Demo() {
  const [p, setP] = useState<AudioProject>(storyProject);
  const [selected, setSelected] = useState<string | null>("Core");
  const [refused, setRefused] = useState("");
  const apply = (r: EditResult<AudioProject>) => ("refused" in r ? setRefused(r.refused) : (setRefused(""), setP(r.next)));
  return (
    <div style={{ width: "320px" }}>
      <PackageListView
        rows={packageList(p, STORY_FILES, storyDeps, "android")}
        selected={selected}
        platform="android"
        onSelect={setSelected}
        onAdd={() => apply(addPackage(p))}
        onRename={(from, to) => apply(renamePackage(p, from, to))}
        onDelete={(n) => apply(deletePackage(p, n))}
        onDropSound={(n, path) => apply(addToPackage(p, n, path))}
      />
      <output aria-label="Refused">{refused}</output>
    </div>
  );
}

const meta: Meta = { title: "Studio/Packages/PackageList", component: PackageListView };
export default meta;

export const List: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const list = c.getByRole("listbox", { name: "Packages" });
    await expect(within(list).getAllByRole("option").map((o) => o.querySelector(".pk-name")?.textContent)).toEqual(["Core", "Forest", "Boss"]);
    await expect(within(list).getByRole("option", { name: /Boss/ })).toHaveClass("off");
    await expect(within(list).getByRole("option", { name: /Core/ })).toHaveTextContent("Preload");

    await userEvent.click(c.getByRole("button", { name: "New package" }));
    await expect(within(list).getByRole("option", { name: /^Package/ })).toBeInTheDocument();

    // Rename with F2; a duplicate name is refused.
    within(list).getByRole("option", { name: /^Package/ }).focus();
    await userEvent.keyboard("{F2}");
    const input = c.getByRole("textbox", { name: "Rename Package" });
    await userEvent.clear(input);
    await userEvent.type(input, "Core{Enter}");
    await expect(c.getByLabelText("Refused")).toHaveTextContent('there\'s already a package named "Core"');
    await userEvent.dblClick(within(list).getByRole("option", { name: /^Package/ }));
    const again = c.getByRole("textbox", { name: "Rename Package" });
    await userEvent.clear(again);
    await userEvent.type(again, "Caves{Enter}");
    await expect(within(list).getByRole("option", { name: /Caves/ })).toBeInTheDocument();

    // Delete from the row's menu.
    await userEvent.click(c.getByRole("button", { name: "Caves menu" }));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("menuitem", { name: "Delete package" }));
    await waitFor(() => expect(within(list).queryByRole("option", { name: /Caves/ })).toBeNull());
  },
};

export const Empty: StoryObj = {
  render: () => <PackageListView rows={[]} selected={null} platform="web" onSelect={() => {}} onAdd={() => {}} onRename={() => {}} onDelete={() => {}} onDropSound={() => {}} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("No packages")).toBeInTheDocument();
  },
};
