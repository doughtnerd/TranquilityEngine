// Which project files the Audio Studio opens, and on which of its screens (ADR 0341, 0349). The one
// list the editor's Open in Audio Studio action and the Studio's handoff read; add a format here when
// the Studio learns it. Pure: no DOM, no signals, so the Studio imports it as well as the editor.

/** The Studio's screens (ADR 0349): Author (Samples, Playlists), Mix (Mixer, Spatial), Run (Take, Profiler). */
export type StudioScreen = "samples" | "playlists" | "mixer" | "spatial" | "take" | "profiler";

export const STUDIO_SCREENS: readonly StudioScreen[] = ["samples", "playlists", "mixer", "spatial", "take", "profiler"];

/** A kind of file the Studio opens: matched by a suffix of its (lower-cased) name, or by its whole project path. */
interface StudioFile {
  readonly suffix?: string;
  readonly path?: string;
  readonly screen: StudioScreen;
}

/**
 * The files the Studio opens, first match wins (so a compound suffix comes before a plain one). Audio files and
 * `*.sample.json` (0342) open on Samples; `*.playlist.json` (0343) and the legacy `*.audioevent.json` it replaces on
 * Playlists; `audio.json` (0344) on the Mixer; `*.audioscene.json` (0347) on Spatial; recordings (`*.sporesample`,
 * 0348, 0409) on Take, which offers the Profiler for one without take data.
 */
const STUDIO_FILES: readonly StudioFile[] = [
  { suffix: ".sample.json", screen: "samples" },
  { suffix: ".playlist.json", screen: "playlists" },
  { suffix: ".audioevent.json", screen: "playlists" },
  { suffix: ".audioscene.json", screen: "spatial" },
  { path: "audio.json", screen: "mixer" },
  // ADR 0409: one recording type; the Take screen opens it, and one without take data offers the Profiler.
  { suffix: ".sporesample", screen: "take" },
  ...[".mp3", ".ogg", ".wav", ".flac", ".m4a"].map((suffix) => ({ suffix, screen: "samples" as const })),
];

/** The Studio screen that opens the project file at `path` (project-relative, "/"-separated), or null when the Studio doesn't open it. */
export function studioScreenFor(path: string): StudioScreen | null {
  const lower = path.toLowerCase();
  for (const f of STUDIO_FILES) {
    if (f.path !== undefined ? lower === f.path : lower.endsWith(f.suffix!)) return f.screen;
  }
  return null;
}

/** True when the Audio Studio opens the project file at `path`. */
export const opensInAudioStudio = (path: string): boolean => studioScreenFor(path) !== null;

/** What the editor asks the Studio to open (`myco://studio-open`): a project folder, and optionally a screen and an asset on it. */
export interface StudioOpenRequest {
  /** The project folder's path (as the file system names it), or null to show the Studio's start screen. */
  readonly project: string | null;
  /** A sample to open read-only instead of a folder (the editor has a sample open; ADR 0380), by its id. */
  readonly sample?: string;
  /** A project-relative asset to open; its screen is `studioScreenFor(asset)` unless `screen` says otherwise. */
  readonly asset?: string;
  readonly screen?: StudioScreen;
  /**
   * Open the debug link's Connect dialog (ADR 0403) once the request is handled: the launcher's Connect to Game…
   * (ADR 0380). With `project` null it leaves whatever the Studio has open as it is, rather than closing it.
   */
  readonly connect?: true;
  /**
   * ADR 0408: an absolute folder of take files to open as a takes workspace (Take and Profiler, no project) instead of
   * `project`, which is then null; `asset` is relative to it.
   */
  readonly takesFolder?: string;
  /** ADR 0408: the Profiler follows the connected build's live capture once the request is handled. */
  readonly follow?: true;
}

/** The screen a request opens: its own, else its asset's, else none (the Studio's last). */
export function requestScreen(request: StudioOpenRequest): StudioScreen | null {
  return request.screen ?? (request.asset !== undefined ? studioScreenFor(request.asset) : null);
}

/**
 * The Studio page's URL for `request`, relative to the editor's (the browser opens it in a new tab; ADR 0341):
 * `studio.html?project=<path>#/<screen>/<asset>`. The asset's path segments are encoded one by one, so its slashes stay.
 */
export function studioUrl(request: StudioOpenRequest, page = "studio.html"): string {
  const query = request.project !== null ? `?project=${encodeURIComponent(request.project)}` : request.sample ? `?sample=${encodeURIComponent(request.sample)}` : "";
  return `${page}${query}${studioHash(request)}`;
}

/** The hash route for `request` (`#/<screen>/<asset>`, `#/<screen>`), or "" when it names no screen. */
export function studioHash(request: StudioOpenRequest): string {
  const screen = requestScreen(request);
  if (!screen) return "";
  const asset = request.asset ? `/${request.asset.split("/").map(encodeURIComponent).join("/")}` : "";
  return `#/${screen}${asset}`;
}

/** The screen and asset a hash route names (`#/<screen>/<asset path>`), the inverse of `studioHash`; null fields for what it doesn't name. */
export function parseStudioHash(hash: string): { screen: StudioScreen | null; asset: string | null } {
  const parts = hash.replace(/^#?\/?/, "").split("/").filter((p) => p !== "");
  const screen = (STUDIO_SCREENS as readonly string[]).includes(parts[0] ?? "") ? (parts[0] as StudioScreen) : null;
  if (!screen) return { screen: null, asset: null };
  let asset: string | null = null;
  try {
    asset = parts.length > 1 ? parts.slice(1).map(decodeURIComponent).join("/") : null;
  } catch {
    asset = null; // a malformed escape: the screen alone
  }
  return { screen, asset };
}
