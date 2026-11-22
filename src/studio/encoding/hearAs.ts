// Hear as (ADR 0337 §6): the Studio's runtime plays what a platform would ship instead of the source. Choosing Web,
// Desktop or Android converts each sound the Studio asks for (`prepare`, on demand, through the conversion service and its
// cache) and serves the converted bytes under the sound's own project path through an asset source placed ahead of the
// project's (`Assets.addSource`, the public seam every play resolves through), so auditions, playlists and take replay
// play the converted sound wherever it is named, and the runtime decodes it with the game's own decoder. Sidecars,
// sample edits and loop points still come from the project (loop points are in seconds, so a new rate doesn't move them).
// ADPCM has no loose container, so its blocks are decoded to a 16-bit WAV first (`toWav`). Source plays the project's
// files again; `toggle` flips between Source and the last platform (A/B with one key). Each change of what a path serves
// is announced (`Assets.notifyChanged`), so the runtime drops what it had decoded of it.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import type { AssetSource } from "../../engine/scene/Assets";
import type { ImportPlatform } from "../../engine/scene/importSettings";
import type { PlannedSound } from "../../export/audio";
import type { ConvertedSound } from "./conversion";

/** What the Studio plays: the project's files, or a platform's converted audio. */
export type HearAsChoice = "source" | ImportPlatform;

export const HEAR_AS_CHOICES: readonly { value: HearAsChoice; label: string }[] = [
  { value: "source", label: "Source" },
  { value: "web", label: "Web" },
  { value: "desktop", label: "Desktop" },
  { value: "android", label: "Android" },
];

export interface HearAsSeams {
  /** The build plan's sound for `path` on `platform` (null: not an audio file a build ships). */
  planned(path: string, platform: ImportPlatform): PlannedSound | null;
  convert(sound: PlannedSound): Promise<ConvertedSound>;
  /** ADPCM blocks as a playable 16-bit WAV (decoded with the game's decoder). */
  toWav(converted: ConvertedSound, path: string): Promise<Uint8Array>;
  /** The page's asset lookup (`Assets`). */
  readonly assets: { addSource(source: AssetSource): void; removeSource(source: AssetSource): void; notifyChanged(path: string): void };
  /** Object URLs for bytes. */
  readonly urls: { make(bytes: Uint8Array): string; revoke(url: string): void };
}

/** What a path serves while a platform is chosen. */
interface Served {
  readonly platform: ImportPlatform;
  /** The converted bytes' URL; null when the sound ships as its source (the project's file is what it ships). */
  readonly url: string | null;
  readonly codec: string;
}

export interface HearAsService {
  readonly choice: ReadonlySignal<HearAsChoice>;
  /** Conversions running for the current choice. */
  readonly busy: ReadonlySignal<number>;
  /** The last conversion's failure, for the chip (cleared by the next choice). */
  readonly failure: ReadonlySignal<string | null>;
  /** What each prepared path plays as now (`"vorbis"`, `"source"`…), for the chip's tooltip. */
  readonly served: ReadonlySignal<ReadonlyMap<string, string>>;
  set(choice: HearAsChoice): void;
  /** A/B: Source ↔ the last platform chosen (Web the first time). */
  toggle(): void;
  /** Convert `paths` for the current platform and serve them; resolves true when every one is served (Source: at once). */
  prepare(paths: readonly string[]): Promise<boolean>;
  /** `prepare([path])`, then `play(path)`: an audition of what the chosen platform ships. */
  audition<T>(path: string, play: (path: string) => T): Promise<T | null>;
  /** Serve the project's files again and drop the asset source. */
  dispose(): void;
}

export function createHearAs(seams: HearAsSeams): HearAsService {
  const choice = signal<HearAsChoice>("source");
  const busy = signal(0);
  const failure = signal<string | null>(null);
  const servedMap = new Map<string, Served>();
  const served = signal<ReadonlyMap<string, string>>(new Map());
  let last: ImportPlatform = "web";
  let generation = 0;
  let installed = false;

  const source: AssetSource = {
    has: (p) => servedMap.get(p)?.url != null,
    get: (p) => servedMap.get(p)?.url ?? undefined,
  };
  const publish = () => (served.value = new Map([...servedMap].map(([p, s]) => [p, s.codec])));
  /** Ahead of every other source, also of one added after it (a project reopened). */
  const install = () => {
    seams.assets.removeSource(source);
    seams.assets.addSource(source);
    installed = true;
  };
  const clear = () => {
    const paths = [...servedMap.keys()];
    for (const s of servedMap.values()) if (s.url) seams.urls.revoke(s.url);
    servedMap.clear();
    publish();
    for (const p of paths) seams.assets.notifyChanged(p);
  };

  const prepareOne = async (path: string, platform: ImportPlatform, mine: number): Promise<boolean> => {
    if (servedMap.get(path)?.platform === platform) return true;
    const sound = seams.planned(path, platform);
    if (!sound) return false;
    const converted = await seams.convert(sound);
    const bytes = converted.codec === "source" ? null : converted.codec === "adpcm" ? await seams.toWav(converted, path) : converted.bytes;
    if (mine !== generation) return false; // the choice changed meanwhile
    const before = servedMap.get(path);
    if (before?.url) seams.urls.revoke(before.url);
    servedMap.set(path, { platform, url: bytes ? seams.urls.make(bytes) : null, codec: converted.codec });
    publish();
    install();
    seams.assets.notifyChanged(path);
    return true;
  };

  const service: HearAsService = {
    choice,
    busy,
    failure,
    served,
    set(next) {
      if (next === choice.peek()) return;
      generation++;
      if (next !== "source") last = next;
      choice.value = next;
      failure.value = null;
      clear();
    },
    toggle() {
      service.set(choice.peek() === "source" ? last : "source");
    },
    async prepare(paths) {
      const now = choice.peek();
      if (now === "source") return true;
      const mine = generation;
      busy.value += 1;
      try {
        const results = await Promise.all(paths.map((p) => prepareOne(p, now, mine)));
        return results.every(Boolean);
      } catch (err) {
        if (mine === generation) failure.value = `Couldn't convert for ${now}: ${err instanceof Error ? err.message : String(err)}`;
        return false;
      } finally {
        busy.value -= 1;
      }
    },
    async audition(path, play) {
      await service.prepare([path]);
      return play(path);
    },
    dispose() {
      generation++;
      clear();
      if (installed) seams.assets.removeSource(source);
      installed = false;
    },
  };
  return service;
}

/** The chip's words for a service's state ("Converting for Android…", "Hearing Web", "Source"). */
export function hearAsStatus(choice: HearAsChoice, busy: number, failure: string | null): { text: string; tone: "neutral" | "accent" | "warning" | "danger" } {
  if (failure) return { text: "Conversion failed", tone: "danger" };
  if (choice === "source") return { text: "Source", tone: "neutral" };
  const name = HEAR_AS_CHOICES.find((c) => c.value === choice)!.label;
  return busy > 0 ? { text: `Converting for ${name}…`, tone: "warning" } : { text: `Hearing ${name}`, tone: "accent" };
}

/** A computed of the chip's words, for a view. */
export const hearAsStatusOf = (s: HearAsService) => computed(() => hearAsStatus(s.choice.value, s.busy.value, s.failure.value));
