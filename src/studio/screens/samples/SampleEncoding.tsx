// The Encoding section over the open sample (ADR 0337 §6): the plan for each platform over the project, with this
// file's sidecar as its document holds it (edits not yet written included), the source's facts from its peaks, exact
// figures from the conversion service once "Exact sizes" (or Hear as) converted it, and edits through the sidecar
// document as one undo step each (`applyEdit`).
import { signal } from "@preact/signals";
import { ENCODING_PLATFORMS } from "../../../engine/audio/encoding/defaults";
import { resolveEncoding } from "../../../engine/audio/encoding/resolve";
import type { EncodingKey, EncodingSettings } from "../../../engine/audio/encoding/types";
import type { ImportPlatform, ImportSettings } from "../../../engine/scene/importSettings";
import { applyEdit } from "../../../plugins/audio/editor/editResult";
import { persisted } from "../../../editor/preferences";
import type { PlannedSound } from "../../../export/audio";
import { conversionsFor, projectPlanSource } from "../../encoding/studioEncoding";
import type { ConvertedSound } from "../../encoding/conversion";
import type { SourceFacts } from "../../encoding/estimate";
import { configOf, plannedSound, studioPlan } from "../../encoding/studioPlan";
import { EncodingSection, type OverrideScope } from "./EncodingSection";
import { encodingRows, overrideKey, platformReadout, profileMatches, resetKey, setProfile, KEY_LABELS } from "./encodingModel";
import { peaksOf, type SampleSession } from "./sampleSession";

/** Per user: the platform the section shows, and where overrides go. */
const platformPref = persisted<ImportPlatform>("myco.studio.samples.encodingPlatform", "web");
const scopePref = persisted<OverrideScope>("myco.studio.samples.encodingScope", "platform");

/** Exact conversions by request (platform, path, its asset URL and settings), and the requests running. */
const exact = signal<ReadonlyMap<string, ConvertedSound>>(new Map());
const running = signal<ReadonlySet<string>>(new Set());

const requestKey = (platform: ImportPlatform, sound: PlannedSound, url: unknown) =>
  `${platform}|${sound.path}|${String(url)}|${sound.codec}|${JSON.stringify(sound.resolution.settings)}`;

export function SampleEncoding(props: { session: SampleSession }) {
  const { session } = props;
  const project = session.project;
  const settings = session.settings.value;
  const path = session.path;
  const derived = session.derived.value !== null;
  const platform = platformPref.value;
  const source = projectPlanSource(project, (p) => (p === path && settings ? settings : undefined));
  const config = configOf(source.audio);
  const plans = ENCODING_PLATFORMS.map((p) => [p, studioPlan(source, p)] as const);
  const planned = (p: ImportPlatform) => plannedSound(plans.find(([x]) => x === p)![1], derived ? session.source.value : path);
  const here = planned(platform);
  if (!here) return null;
  // The rows resolve the file itself (a derived sample: its source with its own block on top).
  const resolution = derived ? here.resolution : resolveEncoding({ path, encoding: settings?.encoding ?? null, legacyStream: settings?.stream ?? false }, platform, config);
  const peaks = peaksOf(project, session.source.value);
  const facts: SourceFacts = { bytes: project.sizeOf(here.path) ?? 0, frames: peaks?.frames ?? null, rate: peaks?.rate ?? null, channels: peaks?.channels ?? null };
  const url = project.assets.get(here.path);
  const readouts = ENCODING_PLATFORMS.map((p) => {
    const sound = planned(p)!;
    return platformReadout(p, sound, facts, exact.value.get(requestKey(p, sound, url)) ?? null);
  });
  const keys = ENCODING_PLATFORMS.map((p) => requestKey(p, planned(p)!, url));
  const commit = (result: ReturnType<typeof overrideKey>, label: string) =>
    applyEdit<ImportSettings>(result, label, (next) => session.setSettings(next, label), settings ?? undefined);
  const convert = () => {
    for (const p of ENCODING_PLATFORMS) {
      const sound = planned(p)!;
      const key = requestKey(p, sound, url);
      if (exact.peek().has(key) || running.peek().has(key)) continue;
      running.value = new Set([...running.peek(), key]);
      void conversionsFor(project)
        .convert(sound)
        .then((c) => (exact.value = new Map([...exact.peek(), [key, c]])))
        .catch((err: unknown) => console.warn(`[myco] Couldn't convert ${sound.path} for ${p}:`, err))
        .finally(() => {
          const next = new Set(running.peek());
          next.delete(key);
          running.value = next;
        });
    }
  };
  return (
    <EncodingSection
      platform={platform}
      scope={scopePref.value}
      rows={encodingRows(resolution, path)}
      profiles={Object.keys(config.profiles)}
      profile={settings?.encoding?.profile ?? null}
      matches={profileMatches(resolution, config, path)}
      readouts={readouts}
      converting={keys.some((k) => running.value.has(k))}
      readOnly={derived ? "A derived sample ships its source's conversion: edit the encoding on the source file." : session.readOnly || !settings ? "This sample's settings are read-only." : null}
      problems={resolution.problems}
      onPlatform={(p) => (platformPref.value = p)}
      onScope={(s) => (scopePref.value = s)}
      onProfile={(name) => settings && commit(setProfile(settings, name, config), name ? `Use ${name} profile` : "Clear profile")}
      onOverride={(key: EncodingKey, value: EncodingSettings[EncodingKey]) => {
        if (!settings) return;
        const where = scopePref.peek() === "all" ? null : platform;
        commit(overrideKey(settings, where, key, value), `Override ${KEY_LABELS[key].toLowerCase()}${where ? ` · ${where}` : ""}`);
      }}
      onReset={(key) => settings && commit(resetKey(settings, platform, key), `Reset ${KEY_LABELS[key].toLowerCase()}`)}
      onConvert={convert}
    />
  );
}
