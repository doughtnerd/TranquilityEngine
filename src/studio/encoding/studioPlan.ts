// The export's audio plan (ADR 0351 §5, `planAudio` in `src/export/audio.ts`) over what the Studio holds of a project:
// its files, `audio.json` as its document holds it (edits not yet written included) and each file's JSON (sidecars,
// derived samples, playlists). So the Samples Inspector, Hear as and the Packages screen decide what a sound ships as
// exactly as a build would: the codec after the placement rules (ADPCM only in packages, Opus mono and stereo), the
// load mode, the packages holding it and where every setting came from. Pure.
import { parseSidecarEncoding } from "../../engine/audio/encoding/format";
import type { EncodingSubject } from "../../engine/audio/encoding/resolve";
import { defaultEncodingConfig } from "../../engine/audio/encoding/format";
import type { EncodingConfig } from "../../engine/audio/encoding/types";
import { audioDependencies, type PackageDef } from "../../engine/audio/packaging/definitions";
import type { AudioProject } from "../../engine/audio/project/types";
import { isDerivedSamplePath } from "../../engine/audio/sample/format";
import { parseImportSettings, sidecarPath, type ImportPlatform, type ImportSettings } from "../../engine/scene/importSettings";
import { AUDIO_FILE, planAudio, type AudioPlan, type AudioPlanInput, type AudioSidecarFacts, type PlannedSound } from "../../export/audio";

/** What the plan reads of a project. */
export interface StudioPlanSource {
  /** Every project path. */
  readonly files: readonly string[];
  /** `audio.json`'s value (null: none, every sound takes the built-in defaults and no package exists). */
  readonly audio: Pick<AudioProject, "encoding" | "packages"> | null;
  /** A project JSON file's parsed value (undefined when missing or unreadable). */
  json(path: string): unknown;
  /** A sidecar's settings as its document holds them (null: no sidecar); undefined reads it from `json`. */
  sidecar?(audioPath: string): ImportSettings | null | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The encoding section `source` resolves against. */
export const configOf = (audio: StudioPlanSource["audio"]): EncodingConfig => audio?.encoding ?? defaultEncodingConfig();
/** The packages `source` defines. */
export const packagesOf = (audio: StudioPlanSource["audio"]): readonly PackageDef[] => audio?.packages ?? [];

/** The facts the planner needs of one audio file's sidecar. */
function sidecarFacts(source: StudioPlanSource, path: string): AudioSidecarFacts | null {
  let s: ImportSettings | null | undefined = source.sidecar?.(path);
  if (s === undefined) {
    const raw = source.json(sidecarPath(path));
    s = isRecord(raw) ? parseImportSettings(raw, sidecarPath(path)).settings : null;
  }
  return s ? { encoding: s.encoding, legacyStream: s.stream, ambisonic: s.ambisonic !== null } : null;
}

/** The render each sample names (a sidecar's or derived sample's `sample.source`), mapped to the sample it belongs to. */
function renderOwners(source: StudioPlanSource, facts: (p: string) => AudioSidecarFacts | null): Map<string, EncodingSubject & { ambisonic: boolean }> {
  const out = new Map<string, EncodingSubject & { ambisonic: boolean }>();
  const renderPath = (src: string, name: string) => (name.includes("/") ? name : `${src.slice(0, src.lastIndexOf("/") + 1)}${name}`);
  for (const p of source.files) {
    if (AUDIO_FILE.test(p)) {
      const raw = source.json(sidecarPath(p));
      const name = isRecord(raw) && isRecord(raw.sample) && typeof raw.sample.source === "string" ? raw.sample.source : "";
      if (!name) continue;
      const f = facts(p);
      out.set(renderPath(p, name), { path: p, encoding: f?.encoding ?? null, legacyStream: f?.legacyStream ?? false, ambisonic: f?.ambisonic ?? false });
    } else if (isDerivedSamplePath(p)) {
      const raw = source.json(p);
      if (!isRecord(raw)) continue;
      const src = typeof raw.source === "string" ? raw.source : "";
      const name = isRecord(raw.sample) && typeof raw.sample.source === "string" ? raw.sample.source : "";
      if (!name) continue;
      const sf = AUDIO_FILE.test(src) ? facts(src) : null;
      out.set(renderPath(src || p, name), {
        path: p,
        encoding: parseSidecarEncoding(raw.encoding, `${p}: encoding`, []),
        source: AUDIO_FILE.test(src) ? { path: src, encoding: sf?.encoding ?? null, legacyStream: sf?.legacyStream ?? false } : null,
        ambisonic: sf?.ambisonic ?? false,
      });
    }
  }
  return out;
}

/** The planner's input for `platform` (`convert`: false plans every sound as its source, `--no-audio-convert`). */
export function studioPlanInput(source: StudioPlanSource, platform: ImportPlatform, convert = true): AudioPlanInput {
  const cache = new Map<string, AudioSidecarFacts | null>();
  const facts = (p: string) => {
    if (!cache.has(p)) cache.set(p, sidecarFacts(source, p));
    return cache.get(p)!;
  };
  const owners = renderOwners(source, facts);
  return {
    platform,
    files: source.files,
    config: configOf(source.audio),
    packages: packagesOf(source.audio),
    sidecar: facts,
    renderOwner: (p) => owners.get(p) ?? null,
    dependencies: audioDependencies((p) => source.json(p)),
    convert,
  };
}

/** The build's audio plan for `platform` over `source`. */
export const studioPlan = (source: StudioPlanSource, platform: ImportPlatform): AudioPlan => planAudio(studioPlanInput(source, platform));

/** One sound's plan (null when `path` isn't an audio file the plan ships). */
export function plannedSound(plan: AudioPlan, path: string): PlannedSound | null {
  return plan.sounds.find((s) => s.path === path) ?? null;
}
