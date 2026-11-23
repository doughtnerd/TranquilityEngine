// Stories (ADR 0219, 0351 §6) for the Packages screen's Contents tab over the story project, edited through the screen's
// model: Forest's contents with dependencies ("needed by" the playlist and the derived sample), Core's click also in
// Boss, estimated sizes per platform, a glob-caught sound that can't be removed alone, adding a loose sound to the
// package and removing an include entry.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { EditResult } from "../../../plugins/audio/editor/editResult";
import { studioPlan } from "../../encoding/studioPlan";
import { ContentsView, type SoundFigures } from "./ContentsView";
import { addToPackage, defsOf, looseAssets, packageView, removeFromPackage, removeInclude } from "./packagesModel";
import { STORY_FILES, storyDeps, storyFacts, storyPlanSource, storyProject } from "./packagesStoryData";
import { estimatedReport } from "./reportModel";
import "../samples/samples.css";
import "./packages.css";

function Demo({ pkg }: { pkg: string }) {
  const [p, setP] = useState<AudioProject>(storyProject);
  const [opened, setOpened] = useState("");
  const apply = (r: EditResult<AudioProject>) => "next" in r && setP(r.next);
  const report = estimatedReport(studioPlan(storyPlanSource(p), "web"), storyFacts);
  const figures = (path: string): SoundFigures | null => {
    const s = report.sounds.find((x) => x.path === path);
    return s ? { profile: s.profile, codec: s.codec, load: s.load, bytes: s.bytes, memoryBytes: s.memoryBytes, exact: false } : null;
  };
  const view = packageView(p, pkg, STORY_FILES, storyDeps);
  return (
    <div style={{ width: "900px" }}>
      <ContentsView
        view={view}
        loose={looseAssets(p, STORY_FILES, storyDeps)}
        packages={defsOf(p).map((d) => d.name)}
        figures={figures}
        removeRefusal={(path) => {
          const r = removeFromPackage(p, pkg, path, { files: STORY_FILES, deps: storyDeps });
          return "refused" in r ? r.refused : null;
        }}
        onAdd={(name, path) => apply(addToPackage(p, name, path))}
        onRemove={(name, path) => apply(removeFromPackage(p, name, path))}
        onRemoveInclude={(name, inc) => apply(removeInclude(p, name, inc))}
        onOpen={setOpened}
      />
      <output aria-label="Opened">{opened}</output>
    </div>
  );
}

const meta: Meta = { title: "Studio/Packages/Contents", component: ContentsView };
export default meta;

export const Forest: StoryObj = {
  render: () => <Demo pkg="Forest" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const table = c.getByRole("table", { name: "What Forest holds" });
    // A row by the sound in its first cell (a dependency row names what needs it too).
    const row = (name: RegExp) => within(table).getAllByRole("row").find((r) => name.test(r.querySelector("td, th")?.textContent ?? "")) as HTMLElement;
    await expect(row(/birds\.ogg/)).toHaveTextContent("needed by day.playlist.json");
    await expect(row(/hit\.wav/)).toHaveTextContent("needed by hit_soft.sample.json");
    await expect(row(/forest_bed\.wav/)).toHaveTextContent("listed");
    await expect(row(/day\.playlist\.json/)).toHaveTextContent("playlists/forest/**");
    // A WAV converts to Vorbis by the Default profile: an estimate, marked ≈; the Ogg ships as it is.
    await expect(row(/forest_bed\.wav/)).toHaveTextContent(/vorbis.*≈/);
    await expect(row(/birds\.ogg/)).toHaveTextContent("source");

    // A dependency can't be removed alone: the menu says why.
    await userEvent.click(c.getByRole("button", { name: "birds.ogg menu" }));
    const remove = await body.findByRole("menuitem", { name: "Remove from Forest" });
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAttribute("title", expect.stringContaining("day.playlist.json needs audio/amb/birds.ogg"));
    await userEvent.keyboard("{Escape}");

    // Add a loose sound; remove an include entry.
    const loose = c.getByRole("region", { name: "In no package" });
    await userEvent.click(within(loose).getAllByRole("button", { name: "Add to Forest" })[0]!);
    await waitFor(() => expect(within(table).getByRole("row", { name: /credits\.wav/ })).toHaveTextContent("listed"));
    await userEvent.click(c.getByRole("button", { name: "Remove entry audio/amb/forest_bed.wav" }));
    await waitFor(() => expect(within(table).queryByRole("row", { name: /forest_bed\.wav/ })).toBeNull());
  },
};

export const SharedSound: StoryObj = {
  render: () => <Demo pkg="Core" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const table = c.getByRole("table", { name: "What Core holds" });
    await expect(within(table).getByRole("row", { name: /click\.wav/ })).toHaveTextContent("also in Boss");
    // A glob holds the hover sound: the refusal names the entry.
    await userEvent.click(c.getByRole("button", { name: "hover.wav menu" }));
    const remove = await within(canvasElement.ownerDocument.body).findByRole("menuitem", { name: "Remove from Core" });
    await expect(remove).toHaveAttribute("title", 'audio/ui/hover.wav is caught by "audio/ui/**"; edit that entry instead');
    await userEvent.keyboard("{Escape}");
  },
};
