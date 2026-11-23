// Stories (ADR 0219, 0351 §6, §8) for the Packages screen's Report tab over the story project: estimated figures for Web,
// past its 1 MB download budget (the bar in the danger colour and a warning), per package; a raised budget clears the
// warning; Convert now shows progress (a pretend run here) and then exact figures from the export's report.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { AudioReport } from "../../../export/audio";
import { studioPlan } from "../../encoding/studioPlan";
import { storyFacts, storyPlanSource, storyProject } from "./packagesStoryData";
import { configOfDoc, setBudget } from "./profilesModel";
import { estimatedReport, exactReport } from "./reportModel";
import { ReportView } from "./ReportView";
import "../samples/samples.css";
import "./packages.css";

/** The export's report a pretend Convert now answers for `platform`. */
const convertedReport = (platform: ImportPlatform): AudioReport => ({
  format: "myco.audioreport@1", platform, converted: true,
  sounds: [{ path: "audio/music/boss.wav", renderOf: null, sourceBytes: 40_320_044, shippedBytes: 3_100_000, codec: "vorbis", rate: 48_000, channels: 2, frames: 48_000 * 210, load: "stream", memoryBytes: 48_000, packages: ["Boss"], cached: false, settings: { codec: "vorbis", quality: 0.6, sampleRate: "source", channels: "source", load: "stream", prefetchMs: 250 }, from: {} as never, notes: [] }],
  packages: [{ name: "Core", preload: true, bytes: 70_000, memoryBytes: 70_000, sounds: ["audio/ui/click.wav", "audio/ui/hover.wav"], problems: [] }, { name: "Boss", preload: false, bytes: 50_000, memoryBytes: 48_000, sounds: ["audio/music/boss.wav"], problems: [] }],
  totals: { files: 7, sourceBytes: 82_540_308, shippedBytes: 5_400_000, memoryBytes: 118_000 },
  budgets: { warnings: [] }, problems: [],
});

function Demo() {
  const [p, setP] = useState<AudioProject>(storyProject);
  const [platform, setPlatform] = useState<ImportPlatform>("web");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [exact, setExact] = useState<AudioReport | null>(null);
  const report = exact && exact.platform === platform ? exactReport(exact, configOfDoc(p)) : estimatedReport(studioPlan(storyPlanSource(p), platform), storyFacts);
  const convert = () => {
    let done = 0;
    setProgress({ done, total: 4 });
    const t = setInterval(() => {
      done++;
      if (done < 4) return setProgress({ done, total: 4 });
      clearInterval(t);
      setProgress(null);
      setExact(convertedReport(platform));
    }, 60);
  };
  return (
    <div style={{ width: "900px" }}>
      <ReportView
        report={report}
        platform={platform}
        converting={progress}
        onPlatform={setPlatform}
        onConvert={convert}
        onCancel={() => setProgress(null)}
        onBudget={(key, mb) => {
          const r = setBudget(p, platform, key, mb);
          if ("next" in r) setP(r.next);
        }}
      />
    </div>
  );
}

const meta: Meta = { title: "Studio/Packages/Report", component: ReportView };
export default meta;

export const Report: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Estimated")).toBeInTheDocument();
    const download = c.getByRole("meter", { name: "Download against its budget" });
    await expect(download.closest(".pk-bar")).toHaveClass("over");
    await expect(c.getByRole("list", { name: "Budget warnings" })).toHaveTextContent("over the web budget of 1 MB");
    const packages = c.getByRole("table", { name: "Packages" });
    await expect(within(packages).getByRole("row", { name: /Core · preload/ })).toBeInTheDocument();

    // A raised budget clears the warning (a tripwire, never a failure).
    const budget = c.getByRole("spinbutton", { name: "Web download budget" });
    await userEvent.clear(budget);
    await userEvent.type(budget, "200");
    budget.blur();
    await waitFor(() => expect(c.queryByRole("list", { name: "Budget warnings" })).toBeNull());

    // Android ships no Boss package.
    await userEvent.click(within(c.getByRole("radiogroup", { name: "Report platform" })).getByRole("radio", { name: "Android" }));
    await waitFor(() => expect(within(c.getByRole("table", { name: "Packages" })).queryByRole("row", { name: /Boss/ })).toBeNull());

    // Convert now: progress, then exact figures.
    await userEvent.click(c.getByRole("button", { name: "Convert now" }));
    await expect(c.getByRole("status")).toHaveTextContent("/4");
    await waitFor(() => expect(c.getByText("Exact")).toBeInTheDocument());
    await expect(c.getByRole("table", { name: "Largest sounds" })).toHaveTextContent("audio/music/boss.wav");
  },
};
