/**
 * Internal (ADR 0337 §2, A1): the shapes of audio encoding settings, where they live (a sidecar's `encoding` block,
 * `audio.json`'s `encoding` section) and what the resolver answers. Pure types; no runtime code but the key lists.
 */
import type { ImportPlatform } from "../../scene/importSettings";

/** A codec a build ships (what the encoder writes). */
export type ShippedCodec = "pcm" | "adpcm" | "vorbis" | "opus";
/**
 * The `codec` setting: `auto` (lossless sources → Vorbis, lossy ones shipped as they are), `source` (never converted),
 * or a shipped codec.
 */
export type EncodingCodec = "auto" | "source" | ShippedCodec;
export const ENCODING_CODECS: readonly EncodingCodec[] = ["auto", "source", "pcm", "adpcm", "vorbis", "opus"];

/** Where a sound lives at runtime (ADR 0337 §3). */
export type LoadMode = "decode" | "compressed" | "stream";
export const LOAD_MODES: readonly LoadMode[] = ["decode", "compressed", "stream"];

/** The rate ceilings a setting may name, Hz (never upsampled; Opus is always 48 kHz). */
export const SAMPLE_RATES = [11025, 16000, 22050, 24000, 32000, 44100, 48000] as const;
export type SampleRateCeiling = (typeof SAMPLE_RATES)[number];
/** The `sampleRate` setting: the source's rate, or a ceiling. */
export type SampleRateSetting = "source" | SampleRateCeiling;

/** The `channels` setting: as the source, or downmixed to mono ((L+R)/2). */
export type ChannelsSetting = "source" | "mono";

/** One layer of encoding settings: every key optional; an absent key is inherited (`resolve.ts`). */
export interface EncodingSettings {
  codec?: EncodingCodec;
  /** 0..1: Vorbis `q = quality × 10`; Opus 16 + 112 × quality kbps per stereo pair; ignored by PCM and ADPCM. */
  quality?: number;
  sampleRate?: SampleRateSetting;
  channels?: ChannelsSetting;
  load?: LoadMode;
  /** 0..2000: `compressed`/`stream` sounds' first N ms decoded into the clip arena. */
  prefetchMs?: number;
}
export type EncodingKey = keyof EncodingSettings;
/** The keys in the order the Studio shows them. */
export const ENCODING_KEYS: readonly EncodingKey[] = ["codec", "quality", "sampleRate", "channels", "load", "prefetchMs"];

/** Every key decided. */
export type ResolvedEncoding = Required<EncodingSettings>;

/** A layer with per-platform overrides. */
export interface PlatformLayered extends EncodingSettings {
  platforms?: Partial<Record<ImportPlatform, EncodingSettings>>;
}

/** A named profile in `audio.json` (Wwise's Conversion Settings ShareSet); its name is its key in `profiles`. */
export type EncodingProfile = PlatformLayered;

/** A sidecar's (or derived sample's) `encoding` block: overrides, and optionally the profile the file uses. */
export interface SidecarEncoding extends PlatformLayered {
  profile?: string;
}

/** A folder rule: files whose project path matches `path` (a .gitignore-style glob) use `profile`. First match wins. */
export interface EncodingRule {
  path: string;
  profile: string;
}

/** A platform's tripwires (ADR 0337 §8): warnings, never failures. */
export interface AudioBudget {
  /** All audio in the build, MB. */
  downloadMB?: number;
  /** The preload packages plus the largest other package, MB. */
  memoryMB?: number;
}

/** `audio.json`'s `encoding` section. */
export interface EncodingConfig {
  /** The profile files fall back to when no sidecar or rule names one; null for none (the built-in defaults). */
  default: string | null;
  /** Profiles by name, in the file's order. */
  profiles: Record<string, EncodingProfile>;
  rules: EncodingRule[];
  budgets: Partial<Record<ImportPlatform, AudioBudget>>;
}

/** How a file came to use a profile. */
export type ProfileVia =
  | { kind: "sidecar"; file: string }
  | { kind: "rule"; index: number; path: string }
  | { kind: "default" };

/** Where one resolved value came from (the Studio's inheritance display). `platform` is set for a per-platform value. */
export type EncodingOrigin =
  | { level: "sidecar"; file: string; platform: ImportPlatform | null; legacy?: "stream" }
  | { level: "profile"; profile: string; platform: ImportPlatform | null; via: ProfileVia }
  | { level: "builtin"; platform: ImportPlatform };

/** The resolver's answer for one file on one platform. */
export interface EncodingResolution {
  settings: ResolvedEncoding;
  /** Where each value came from. */
  origins: Record<EncodingKey, EncodingOrigin>;
  /** The profiles consulted, nearest first (the file's chosen profile, then a rule's, then the default). */
  profiles: { name: string; via: ProfileVia }[];
  /** Names that match no profile, and similar; one line each. */
  problems: string[];
}
