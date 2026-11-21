// The project context (ADR 0319): the process globals a project registers while something runs it (asset sources,
// the storage backend, the mixer's buses, the graphics tiers), applied by one acquire and undone by its release.
// Engines acquire one on create and release it on dispose; `launchGame`, the editor's open project and the exporter
// acquire one holding just their asset sources.
//
// Contexts nest (the editor's Engine and its play Engine coexist), so each registration has one rule for release:
// - Asset sources: the ones this context added are removed; the others stay, whatever order contexts go in.
// - Storage: the most recently acquired live context that set one is the backend in use. Releasing it puts back the
//   next most recent live one's, or the backend in use before the first of them; releasing an earlier context changes
//   nothing in use.
// - Mixer and graphics: configured on acquire and kept on release. They are the player's settings for the last project
//   configured; nested Engines configure the same project, and putting an older configuration back would revert live
//   mix edits made during Play (ADR 0175) and the tier the player picked.
import { mixer } from "../audio/mixer";
import type { AudioSettings } from "../audio/settings";
import { Storage, type StorageBackend } from "../platform/Storage";
import { Graphics } from "../render/Graphics";
import { Assets, type AssetSource } from "../scene/Assets";
import { notifyAudioConfigured } from "./audioConfigure";
import type { GraphicsSettings } from "./graphics";

export interface ProjectContextParts {
  /** Asset sources, registered in front of the ones already there. */
  readonly assets?: AssetSource | readonly AssetSource[];
  /** The storage backend for saves and settings (ADR 0024). */
  readonly storage?: StorageBackend;
  /** The mixer's buses (ADR 0097); listeners of `onAudioConfigured` hear them. */
  readonly audio?: AudioSettings;
  /** The graphics tiers (ADR 0050), with the player's saved tier and the one detection chose (ADR 0055). */
  readonly graphics?: { readonly settings: GraphicsSettings; readonly saved?: unknown; readonly auto?: unknown };
}

export interface ProjectContext {
  /** Undo this context's registrations by the rules above. Idempotent. */
  release(): void;
}

/** Live contexts that set a storage backend, oldest first; the last one's is in use. */
const storageOwners: { backend: StorageBackend }[] = [];
/** The backend in use before the first live context set one. */
let storageBefore: StorageBackend | null = null;

/** Apply `parts` to the process globals, all at once (nothing here can fail part-way); returns the release. */
export function acquireProjectContext(parts: ProjectContextParts): ProjectContext {
  const sources = ([] as AssetSource[]).concat(parts.assets ?? []);
  for (const source of sources) Assets.addSource(source);
  let owner: { backend: StorageBackend } | null = null;
  if (parts.storage) {
    owner = { backend: parts.storage };
    const replaced = Storage.use(parts.storage);
    if (storageOwners.length === 0) storageBefore = replaced;
    storageOwners.push(owner);
  }
  if (parts.audio) {
    mixer.configure(parts.audio);
    // Listeners (the audio core's page host) remap live voices to the new buses.
    notifyAudioConfigured(parts.audio);
  }
  if (parts.graphics) Graphics._configure(parts.graphics.settings, parts.graphics.saved, parts.graphics.auto);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      for (const source of sources) Assets.removeSource(source);
      if (owner) releaseStorage(owner);
    },
  };
}

function releaseStorage(owner: { backend: StorageBackend }): void {
  const i = storageOwners.indexOf(owner);
  if (i < 0) return;
  const wasInUse = i === storageOwners.length - 1;
  storageOwners.splice(i, 1);
  if (!wasInUse) return;
  const next = storageOwners.at(-1)?.backend ?? storageBefore;
  if (next) Storage.use(next);
  if (storageOwners.length === 0) storageBefore = null;
}
