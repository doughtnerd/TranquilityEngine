// Stories (ADR 0219, 0351 §6, §7) for the Packages screen's package inspector over the story project, edited through
// the screen's model: Preload, the platforms it ships on (the last one can't go), the project's Strict rule, its size for
// the platform, and a script naming a package that doesn't exist.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../editor/sdk/editResult";
import { studioPlan } from "../../encoding/studioPlan";
import { PackageInspectorView } from "./PackageInspectorView";
import { defsOf, lintPackageNames, setPreload, setShipsOn, setStrict, strictOf } from "./packagesModel";
import { storyFacts, storyPlanSource, storyProject } from "./packagesStoryData";
import { estimatedReport } from "./reportModel";
import "../samples/samples.css";
import "./packages.css";

const SCRIPTS = new Map([["scripts/level.ts", 'await Audio.package("Forest").load();\nawait Audio.package("Cave").load();\n']]);

function Demo() {
  const [p, setP] = useState<AudioProject>(storyProject);
  const [refused, setRefused] = useState("");
  const [opened, setOpened] = useState("");
  const apply = (r: EditResult<AudioProject>) => ("refused" in r ? setRefused(r.refused) : (setRefused(""), setP(r.next)));
  const def = defsOf(p).find((d) => d.name === "Boss")!;
  const report = estimatedReport(studioPlan(storyPlanSource(p), "web"), storyFacts);
  return (
    <div style={{ width: "320px" }}>
      <PackageInspectorView
        def={def}
        platform="web"
        figures={report.packages.find((x) => x.name === "Boss") ?? null}
        exact={false}
        strict={strictOf(p)}
        lint={lintPackageNames(SCRIPTS, defsOf(p).map((d) => d.name))}
        onPreload={(on) => apply(setPreload(p, "Boss", on))}
        onShipsOn={(pl, on) => apply(setShipsOn(p, "Boss", pl, on))}
        onStrict={(on) => apply(setStrict(p, on))}
        onOpenScript={setOpened}
      />
      <output aria-label="Refused">{refused}</output>
      <output aria-label="Opened">{opened}</output>
    </div>
  );
}

const meta: Meta = { title: "Studio/Packages/Inspector", component: PackageInspectorView };
export default meta;

export const Inspector: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("region", { name: "Boss settings" })).toHaveTextContent(/≈ .* · memory ≈/);
    const preload = c.getByRole("checkbox", { name: "Preload" });
    await userEvent.click(preload);
    await waitFor(() => expect(c.getByRole("checkbox", { name: "Preload" })).toBeChecked());
    // Boss ships on desktop and web; drop desktop, then web is the last one and can't go.
    await expect(c.getByRole("checkbox", { name: "Android" })).not.toBeChecked();
    await userEvent.click(c.getByRole("checkbox", { name: "Desktop" }));
    await waitFor(() => expect(c.getByRole("checkbox", { name: "Desktop" })).not.toBeChecked());
    await userEvent.click(c.getByRole("checkbox", { name: "Web" }));
    await expect(c.getByLabelText("Refused")).toHaveTextContent("a package ships on at least one platform");
    await userEvent.click(c.getByRole("checkbox", { name: "Strict" }));
    await waitFor(() => expect(c.getByRole("checkbox", { name: "Strict" })).not.toBeChecked());
    const lint = c.getByRole("list", { name: "Unknown package names in scripts" });
    await expect(lint).toHaveTextContent('names "Cave"');
    await userEvent.click(within(lint).getByRole("button", { name: "scripts/level.ts:2" }));
    await expect(c.getByLabelText("Opened")).toHaveTextContent("scripts/level.ts");
  },
};
