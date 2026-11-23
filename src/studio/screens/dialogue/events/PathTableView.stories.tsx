// Stories (ADR 0219, 0355 §7) for the path table over the fixture event: label menus per argument, weighted line chips
// with recorded/missing in the preview language, an argument change previewed before applying (removing a label removes
// the path naming it), and the tree grouping.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { fixtureDialogue } from "../dialogueFixture";
import { addPath, applyArgumentChange, changeArgument, pathLints, setPathEntry, setPathLines, type EventContext } from "./eventsModel";
import { PathTableView } from "./PathTableView";
import "../dialogue.css";

const ctx: EventContext = { parameterLabels: (n) => (n === "time" ? ["Day", "Night"] : null) };
const KEYS = ["intro_01", "intro_02", "guard_01", "breath_03"];

function Demo() {
  const [asset, setAsset] = useState(fixtureDialogue);
  const e = asset.events[0];
  const apply = (r: { next: typeof asset } | { refused: string }) => "next" in r && setAsset(r.next);
  return (
    <div style={{ width: "1000px" }}>
      <PathTableView
        event={e} ctx={ctx} parameters={["time"]} lints={pathLints(e, ctx, new Set(KEYS))} bench={null}
        lineKeys={KEYS} recorded={(k) => k !== "intro_02"} preview="fr"
        impactOf={(change) => {
          const r = changeArgument(e, change, ctx);
          return "refused" in r ? r : { next: { impact: r.next.impact } };
        }}
        onArgument={(change) => apply(applyArgumentChange(asset, e.name, change, ctx))}
        onEntry={(i, a, v) => apply(setPathEntry(asset, e.name, i, a, v))}
        onLines={(i, lines) => apply(setPathLines(asset, e.name, i, lines))}
        onNumbers={() => undefined}
        onAddPath={() => apply(addPath(asset, e.name))}
        onRemovePath={() => undefined}
      />
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Events/Path table", component: PathTableView };
export default meta;

export const PathTable: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const table = c.getByRole("table", { name: "Paths" });
    await expect(within(table).getByRole("combobox", { name: "Path 1 speaker" })).toHaveValue("Guard");
    await expect(within(table).getByTitle("intro_02: missing in fr")).toBeInTheDocument();
    // A new path is all *; its first cell set to Captain.
    await userEvent.click(c.getByRole("button", { name: "Add path" }));
    await userEvent.selectOptions(within(table).getByRole("combobox", { name: "Path 4 speaker" }), "Captain");
    await userEvent.type(within(table).getByRole("textbox", { name: "Add a line to path 4" }), "guard_01{Enter}");
    await waitFor(() => expect(within(table).getByRole("row", { name: /Path 4: Captain · \* · \*/ })).toHaveTextContent("guard_01"));
    // Removing the label Rain shows the path it removes before applying.
    const labels = within(table).getByRole("textbox", { name: "Labels of weather" });
    await userEvent.clear(labels);
    await userEvent.type(labels, "Clear, Fog{Enter}");
    const change = c.getByRole("region", { name: "Argument change" });
    await expect(within(change).getByRole("list", { name: "Affected paths" })).toHaveTextContent('Path 2 (Guard · Rain · *) is removed: names "Rain", which is removed');
    await userEvent.click(within(change).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(within(table).queryByRole("row", { name: /Rain/ })).toBeNull());
    // Linking a global adds a column of *.
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Link a global parameter" }), "time");
    await waitFor(() => expect(within(table).getByRole("combobox", { name: "Path 1 time" })).toHaveValue("*"));
    // The tree view.
    await userEvent.click(within(c.getByRole("radiogroup", { name: "Path view" })).getByRole("radio", { name: "Group by argument" }));
    await expect(c.getByRole("list", { name: "Paths by argument" })).toHaveTextContent("Guard");
  },
};
