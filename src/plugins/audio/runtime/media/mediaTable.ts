/**
 * Internal (ADR 0351 §7, A5): a build's media table (`game.json`'s `audio`, written by the export): which sounds were
 * converted or packaged, what they ship as, and the build's packages. The player installs it before the game starts
 * (`installAudioMedia`); the clip resolver and the package registry (`packages.ts`) read it. Without one (editor Play, a
 * build with no converted audio) every lookup answers "nothing": sounds play from their project files, and packages come
 * from `audio.json` over the sources.
 *
 * References stay project paths everywhere; only this table knows a sound's package or its loose streamed media.
 */
import type { AudioManifest, AudioMediaEntry } from "../../../../export/format";

interface Installed {
  readonly audio: AudioManifest;
  /** A build file's URL from its path relative to the build's root. */
  readonly url: (buildPath: string) => string;
}

let installed: Installed | null = null;

/**
 * Installs a build's media table (null removes it). `url` turns a build path (`audio/packages/Core.mycopak`) into the URL
 * the game fetches.
 */
export function installAudioMedia(audio: AudioManifest | null | undefined, url: (buildPath: string) => string = (p) => p): void {
  installed = audio ? { audio, url } : null;
}

/** The installed table's platform and packages, or null without one. */
export function installedAudio(): Installed | null {
  return installed;
}

/** The media entry of the sound at project path `path`, or undefined (not converted, not packaged, or no table). */
export function mediaEntry(path: string): AudioMediaEntry | undefined {
  const media = installed?.audio.media;
  return media && Object.hasOwn(media, path) ? media[path] : undefined;
}

/** The packages a build's media entry says hold a sound (every one of them), in `audio.json`'s order. */
export function entryPackages(entry: AudioMediaEntry): readonly string[] {
  return entry.packages ?? (entry.package ? [entry.package] : []);
}

/** The URL of a build file (`AudioMediaEntry.url`, a package's `url`). */
export function buildUrl(buildPath: string): string {
  return installed ? installed.url(buildPath) : buildPath;
}
