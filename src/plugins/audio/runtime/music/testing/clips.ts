// @internal test fixture (ADR 0293): music test clips served the way a project serves them, so segment runs resolve their
// stems through the clip resolver as in production. Not shipped: only test files import it.
//
//   serveMusicClips(fake, { "a.ogg": { frames: 120 * 48_000, rate: 48_000, channels: 2, gapless: true } }, { stream: true });
//   serveMusicClips(fake, () => LONG);   // the same facts for every clip
import { Assets, type AssetSource } from "../../../../../engine/scene/Assets";
import type { MusicClipFacts } from "../../../../../engine/audio/musicValidate";
import type { FakeBackend } from "../../testing";
import { mixer } from "../../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../../engine/audio/settings";

/** Options of `serveMusicClips`. */
export interface ServeMusicClipsOptions {
  /** Every clip's sidecar asks `stream: true` (the stream-or-decode rule's answer while its facts are unknown). Default false: decoded. */
  readonly stream?: boolean;
}

/** The clip facts a test gives: by path, or one function for every path (undefined: not known yet). */
export type TestClipFacts = Readonly<Record<string, MusicClipFacts | undefined>> | ((path: string) => MusicClipFacts | undefined);

const AUDIO_FILE = /\.(ogg|wav|mp3|flac|opus|m4a)$/i;
const SIDECAR = /\.(ogg|wav|mp3|flac|opus|m4a)\.meta\.json$/i;
let served: AssetSource | null = null;

/**
 * Serves every audio file path as a project asset (URL `/assets/<path>`, a sidecar with `stream: true` when asked) and
 * gives `backend`'s clip cache the clips' facts (ADR 0286): a record goes into the fake's `facts` map; a function
 * answers `clipFacts` for every path (the fake's clip cache otherwise unchanged). Replaces what an earlier call served.
 */
export function serveMusicClips(backend: FakeBackend | null, facts: TestClipFacts = {}, options: ServeMusicClipsOptions = {}): void {
  if (served) Assets.removeSource(served);
  const sidecar = options.stream ? { format: "myco.import@1", stream: true } : undefined;
  served = {
    has: (path) => AUDIO_FILE.test(path) || (sidecar !== undefined && SIDECAR.test(path)),
    get: (path) => (AUDIO_FILE.test(path) ? `/assets/${path}` : sidecar),
  };
  Assets.addSource(served);
  if (!backend) return;
  if (typeof facts === "function") {
    backend.clipCache = Object.create(backend, { clipFacts: { value: facts } }) as FakeBackend;
    return;
  }
  for (const [path, f] of Object.entries(facts)) if (f) backend.facts.set(path, f);
}

/**
 * Configures the page's mixer with Master and `names` (each under Master), as a project's Audio settings would, so the
 * clip resolver keeps those bus names (an unknown one plays on Master). Returns the undo: the settings it had before.
 */
export function projectBuses(names: readonly string[]): () => void {
  const before = mixer.audioSettings;
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, ...names.map((name) => ({ name, parent: "Master" }))] }).settings);
  return () => mixer.configure(before);
}
