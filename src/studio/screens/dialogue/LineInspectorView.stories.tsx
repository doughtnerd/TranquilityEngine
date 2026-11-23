// Stories (ADR 0219, 0354 §9, 0357 §6) for the Line inspector over the fixture project: per language status, file and
// length, lip-sync, the subtitle strip with its reading-speed warning, audition per language, and the line's settings.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { findLine } from "./dialogueData";
import { fixtureData, fixtureTable } from "./dialogueFixture";
import { inspectorLanguages } from "./inspectorModel";
import { LineInspectorView } from "./LineInspectorView";
import { setCooldown, setOnce } from "./linesModel";
import "./dialogue.css";

function Demo(props: { lineKey: string }) {
  const [table, setTable] = useState(fixtureTable);
  const [playing, setPlaying] = useState<string | null>(null);
  const data = fixtureData({ table, lipsync: { "audio/vo/en/ch1/intro_02.wav": 42 } });
  const ref = findLine(data, props.lineKey)!;
  const apply = (r: { next: typeof table } | { refused: string }) => "next" in r && setTable(r.next);
  return (
    <div style={{ width: "420px" }}>
      <LineInspectorView
        line={ref.line}
        table={ref.doc.path}
        languages={inspectorLanguages(data, ref)}
        preview="fr"
        auditioning={playing}
        onAudition={setPlaying}
        onStop={() => setPlaying(null)}
        onOpenFile={() => undefined}
        onText={() => undefined}
        onNotes={() => undefined}
        onTags={() => undefined}
        onCooldown={(s) => apply(setCooldown(table, props.lineKey, s))}
        onOnce={(o) => apply(setOnce(table, props.lineKey, o))}
        onSubtitled={() => undefined}
      />
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Line inspector", component: LineInspectorView };
export default meta;

export const LongSubtitle: StoryObj = {
  render: () => <Demo lineKey="intro_02" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const en = c.getByRole("region", { name: "English (en)" });
    await expect(en).toHaveTextContent("3.00 s");
    await expect(en).toHaveTextContent("lip-sync 42 keys");
    await expect(within(en).getByRole("list", { name: "Subtitle warnings in en" })).toHaveTextContent("29 cps, max 15");
    // French has no recording of its own: it plays the English file.
    const fr = c.getByRole("region", { name: "Français (fr)" });
    await expect(fr).toHaveTextContent("audio/vo/en/ch1/intro_02.wav");
    await userEvent.click(within(fr).getByRole("button", { name: "Audition" }));
    await expect(within(fr).getByRole("button", { name: "Stop" })).toHaveAttribute("aria-pressed", "true");
    // Settings.
    const cooldown = c.getByRole("textbox", { name: "Cooldown" });
    await userEvent.clear(cooldown);
    await userEvent.type(cooldown, "6{Enter}");
    await waitFor(() => expect(c.getByRole("textbox", { name: "Cooldown" })).toHaveValue("6")); // the box drops trailing zeros (numberBoxText)
    await userEvent.click(c.getByRole("checkbox", { name: "Once" }));
    await expect(c.getByRole("checkbox", { name: "Once" })).toBeChecked();
  },
};

export const NeverSubtitled: StoryObj = {
  render: () => <Demo lineKey="breath_03" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("checkbox", { name: "Subtitled" })).not.toBeChecked();
    await expect(c.queryByRole("group", { name: /Subtitle timing/ })).toBeNull();
  },
};
