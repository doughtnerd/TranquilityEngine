// Stories (ADR 0219, 0351 §6) for the Samples Inspector's Encoding section over a music file caught by a folder rule,
// edited through the section's model: where each value comes from, an override for Android only (the row marked, its
// origin "this file · Android"), Reset back to the profile's value, an override for every platform, the profile and
// rule matches, and the readouts per platform (estimates, then exact after Exact sizes).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ENCODING_PLATFORMS } from "../../../engine/audio/encoding/defaults";
import { parseAudioProject } from "../../../engine/audio/project/format";
import { resolveEncoding } from "../../../engine/audio/encoding/resolve";
import { defaultImportSettings, type ImportPlatform, type ImportSettings } from "../../../engine/scene/importSettings";
import { plannedSound, studioPlan, configOf } from "../../encoding/studioPlan";
import { EncodingSection, type OverrideScope } from "./EncodingSection";
import { encodingRows, overrideKey, platformReadout, profileMatches, resetKey, setProfile } from "./encodingModel";
import "./samples.css";

const PATH = "audio/music/theme.wav";
const AUDIO = parseAudioProject({
  format: "myco.audio@1",
  encoding: {
    default: "Default",
    profiles: { Default: { codec: "auto", quality: 0.5 }, Music: { codec: "vorbis", quality: 0.6, load: "stream", prefetchMs: 250, platforms: { android: { quality: 0.3 } } }, Dialogue: { codec: "opus", channels: "mono", load: "compressed" } },
    rules: [{ path: "audio/music/**", profile: "Music" }, { path: "audio/**/*.wav", profile: "Default" }],
  },
  packages: [{ name: "Score", include: ["audio/music/**"] }],
}).project;
const FACTS = { bytes: 21_168_044, frames: 44_100 * 120, rate: 44_100, channels: 2 };

function Demo() {
  const [settings, setSettings] = useState<ImportSettings>(defaultImportSettings);
  const [platform, setPlatform] = useState<ImportPlatform>("android");
  const [scope, setScope] = useState<OverrideScope>("platform");
  const [exact, setExact] = useState(false);
  const [refused, setRefused] = useState("");
  const apply = (r: ReturnType<typeof overrideKey>) => ("refused" in r ? setRefused(r.refused) : (setRefused(""), setSettings(r.next)));
  const source = { files: ["audio.json", PATH], audio: AUDIO, json: () => undefined, sidecar: () => settings };
  const config = configOf(AUDIO);
  const resolution = resolveEncoding({ path: PATH, encoding: settings.encoding, legacyStream: settings.stream }, platform, config);
  const readouts = ENCODING_PLATFORMS.map((p) => {
    const sound = plannedSound(studioPlan(source, p), PATH)!;
    // "Exact sizes" here pretends the conversion gave the estimate's figures, rounded.
    const est = platformReadout(p, sound, FACTS, null);
    return exact && est.figures ? platformReadout(p, sound, FACTS, { key: p, codec: est.figures.codec, bytes: new Uint8Array(Math.round(est.figures.bytes / 1000) * 1000), rate: est.figures.rate, channels: est.figures.channels, frames: est.figures.frames, sourceBytes: FACTS.bytes, cached: false, notes: [] }) : est;
  });
  return (
    <div class="smp-insp-body" style={{ width: "380px" }}>
      <EncodingSection
        platform={platform}
        scope={scope}
        rows={encodingRows(resolution, PATH)}
        profiles={Object.keys(config.profiles)}
        profile={settings.encoding?.profile ?? null}
        matches={profileMatches(resolution, config, PATH)}
        readouts={readouts}
        converting={false}
        readOnly={null}
        onPlatform={setPlatform}
        onScope={setScope}
        onProfile={(n) => apply(setProfile(settings, n, config))}
        onOverride={(key, value) => apply(overrideKey(settings, scope === "all" ? null : platform, key, value))}
        onReset={(key) => apply(resetKey(settings, platform, key))}
        onConvert={() => setExact(true)}
      />
      <output aria-label="Refused">{refused}</output>
    </div>
  );
}

const meta: Meta = { title: "Studio/Samples/EncodingSection", component: EncodingSection };
export default meta;

export const Inheritance: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const rows = () => c.getByRole("table", { name: /^Encoding for/ });
    const row = (key: string) => rows().querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    await expect(row("quality")).toHaveTextContent("Music profile (rule audio/music/**) · Android");
    await expect(row("sampleRate")).toHaveTextContent("built-in (Android)");
    await expect(c.getByRole("list", { name: "Profile and rule matches" })).toHaveTextContent("rule audio/**/*.wav (Default) also matches");

    // Override the codec for Android only.
    await userEvent.selectOptions(within(row("codec")).getByRole("combobox", { name: "Codec override" }), "opus");
    await waitFor(() => expect(row("codec")).toHaveTextContent("this file · Android"));
    await expect(row("codec")).toHaveClass("overridden");
    const readouts = c.getByRole("table", { name: "Size and memory per platform" });
    await expect(within(readouts).getByRole("row", { name: /Android/ })).toHaveTextContent("opus · 48 kHz");
    await expect(within(readouts).getByRole("row", { name: /^Web/ })).toHaveTextContent("vorbis");
    // Reset: back to the profile's.
    await userEvent.click(within(row("codec")).getByRole("button", { name: "Reset Codec" }));
    await waitFor(() => expect(row("codec")).toHaveTextContent("Music profile (rule audio/music/**)"));

    // Every platform: mono, then Web shows it too.
    await userEvent.click(within(c.getByRole("radiogroup", { name: "Override for" })).getByRole("radio", { name: "All platforms" }));
    await userEvent.selectOptions(within(row("channels")).getByRole("combobox", { name: "Channels override" }), "mono");
    await userEvent.click(within(c.getByRole("radiogroup", { name: "Platform" })).getByRole("radio", { name: "Web" }));
    await waitFor(() => expect(row("channels")).toHaveTextContent("this file"));
    await expect(within(readouts).getByRole("row", { name: /^Web/ })).toHaveTextContent("mono");

    // Estimates are marked ≈ until Exact sizes.
    await expect(readouts).toHaveTextContent("≈");
    await userEvent.click(c.getByRole("button", { name: "Exact sizes" }));
    await waitFor(() => expect(c.getByRole("table", { name: "Size and memory per platform" }).querySelector("tbody")).not.toHaveTextContent("≈"));
  },
};
