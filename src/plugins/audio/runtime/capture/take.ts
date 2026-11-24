// ADR 0348: `Audio.take`, one recording of a game run for the audio designer: what the game asked of audio (the request
// records) and the engine's profile of how it played (the capture ring's records), saved as one `*.sporesample` file. It
// mirrors `Audio.capture` (`capture.ts`): `start()` loads the recorder chunk and joins the shared ring as an owner,
// `stop()` ends the take (the ring's span is copied then, so the file ends where the take did), `save()` writes it.
//
// **Lazy.** The recorder (`takeRecorder.ts`) and the saver (`save.ts`, and through them `format.ts`) are reached by
// `import()` only, so a game that never records a take loads none of them; the hooks (`takeTap.ts`) cost one comparison.
//
// **Budgets (ADR 0348).** The profile keeps the ring's budget (its oldest data dropped behind GAP records on a long run);
// the requests are never dropped: a take that would pass the take cap (256 MiB) stops recording with a message, and what
// it holds can still be saved. A take stops by itself when Play stops (or the Engine goes): it is kept for a `save()`.
import { mixer } from "../../../../engine/audio/mixer";
import { takeSources, type TakeSourceRun } from "../../../../engine/audio/take/extensions";
import type { Engine } from "../../../../engine/core/Engine";
import { World } from "../../../../engine/core/World";
import { onAudioSessionReleased } from "../audioSession";
import { playlistHost } from "../playlists/host";
import { captureTakeRing, onCapturePlayStopped, type CaptureTakeRing } from "./capture";
import type { SaveTake } from "./save";
import { activeWorldRandomState } from "./takeSeed";
import { takeTap } from "./takeTap";

/** `Audio.take` (ADR 0348). */
export interface AudioTake {
  /** "idle" -> "loading" (the recorder chunk fetching) -> "recording" -> "stopped" (a take exists to save). */
  readonly state: AudioTakeState;
  /** Seconds recorded (the running take's, else the last take's); 0 while idle. */
  readonly seconds: number;
  /** Load the recorder (a lazy chunk) and begin a take, with a capture of the engine's profile beside it. Resolves once recording; rejects with a message if the audio core isn't available. A second call while recording does nothing. */
  start(): Promise<void>;
  /** End the take. It is kept for `save()` until the next `start()`. */
  stop(): void;
  /** A marker on the take's timeline (and the profile's) at now. No-op while no take records. */
  mark(text: string): void;
  /** Compress and save the take (`*.sporesample`); resolves with the web file name or the app-data path. Stops a running take first. Rejects with "nothing recorded: call Audio.take.start() first" when there is no take. */
  save(name?: string): Promise<string>;
}

/** `AudioTake.state`. */
export type AudioTakeState = "idle" | "loading" | "recording" | "stopped";

const NOTHING_RECORDED = "nothing recorded: call Audio.take.start() first";

/**
 * ADR 0348: whether a take records pictures of the game view (`FRAME`, a 320 px JPEG about once a second; nothing headless).
 * On by default; a game build turns it off with game.json `audioTakeFrames: false` beside `audioTake` (the player calls
 * `setTakeFrames`). Read when a take starts.
 */
let takePictures = true;

/** @internal ADR 0348: whether takes started from now on record pictures (game.json `audioTakeFrames`; default on). */
export function setTakeFrames(on: boolean): void {
  takePictures = on;
}

type TakeRecorderModule = typeof import("./takeRecorder");
type TakeRecorder = ReturnType<TakeRecorderModule["createTakeRecorder"]>;

/**
 * @internal 32-bit FNV-1a of `text`, as 8 hex digits: a take's `audioHash`, and the build audio index's JSON file hashes
 * (ADR 0410). Kept here, in the module the player loads anyway, so the lazy recorder chunks stay lazy (ADR 0230).
 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The hash of the mix settings in force now, as a take records it in META `take.audioHash` (which `audio.json` it was
 * recorded against). ADR 0410: the build audio index names it, so the Studio matches takes to the audio it downloads.
 */
export function currentAudioHash(): string {
  let json = "";
  try {
    json = JSON.stringify(mixer.audioSettings);
  } catch {
    // Data only: an unserialisable section leaves the hash of what remains.
  }
  return fnv1a(json);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

class Take implements AudioTake {
  private rec: TakeRecorder | null = null;
  private ring: CaptureTakeRing | null = null;
  private flight: Promise<void> | null = null;
  private token = 0;
  private saved: SaveTake | null = null;
  private lastSeconds = 0;
  private seedFacts = { seed: 0, seeded: false, audioHash: "" };
  /** The plugins' take sources recording beside this take (ADR 0348, `engine/audio/take/extensions.ts`). */
  private runs: TakeSourceRun[] = [];
  /** Why the last take stopped by itself (the cap, the recorder released); null when it was stopped. */
  stopMessage: string | null = null;

  get state(): AudioTakeState {
    if (this.rec) return "recording";
    if (this.flight) return "loading";
    return this.saved ? "stopped" : "idle";
  }

  get seconds(): number {
    return this.rec ? this.rec.seconds : this.saved ? this.lastSeconds : 0;
  }

  start(): Promise<void> {
    if (this.rec) return Promise.resolve();
    if (this.flight) return this.flight;
    const flight = this.doStart().finally(() => {
      if (this.flight === flight) this.flight = null;
    });
    this.flight = flight;
    return flight;
  }

  private async doStart(): Promise<void> {
    const token = ++this.token;
    const mod = await import("./takeRecorder");
    let rec: TakeRecorder | null = null;
    const ring = await captureTakeRing({ parameter: (name, value, instance) => rec?.parameter(name, value, instance) });
    if (token !== this.token) {
      ring.release(); // stopped while loading
      return;
    }
    const settings = mixer.audioSettings;
    // ADR 0348: the World's pick generator state now, so replay restarts from where the game's picks were (`takeSeed.ts`).
    const random = activeWorldRandomState();
    this.seedFacts = { seed: random ?? 0, seeded: random !== null, audioHash: currentAudioHash() };
    rec = mod.createTakeRecorder(ring, {
      randomState: activeWorldRandomState,
      frames: takePictures ? {} : null,
      globals: () => {
        const out: Record<string, number> = {};
        for (const p of settings.parameters ?? []) {
          const g = playlistHost().globalParameter(p.name);
          if (g) out[p.name] = g.value;
        }
        return out;
      },
      onStop: (message) => {
        this.stopMessage = message;
        console.warn(`[myco] Audio.take: ${message}.`);
        queueMicrotask(() => this.stop(message));
      },
    });
    this.ring = ring;
    this.rec = rec;
    this.saved = null;
    this.stopMessage = null;
    takeTap.sink = rec;
    await this.startSources(rec, token);
  }

  /** Starts each registered plugin source on the active World's Engine; one that fails to load or start is logged and left out. */
  private async startSources(rec: TakeRecorder, token: number): Promise<void> {
    const engine = World.active?._owner as Engine | null | undefined;
    if (!engine || typeof engine.worlds !== "function") return; // a World with no Engine (a bare test World)
    for (const [name, load] of takeSources()) {
      try {
        const source = await load();
        if (token !== this.token || this.rec !== rec) return; // stopped while loading
        this.runs.push(source.start({ engine, get seconds() { return rec.seconds; }, write: (type, payload) => rec.writeExtension(type, payload) }));
      } catch (e) {
        console.warn(`[myco] Audio.take: the "${name}" source couldn't start (${messageOf(e)}).`);
      }
    }
  }

  private stopSources(): void {
    const runs = this.runs;
    this.runs = [];
    for (const r of runs) {
      try {
        r.stop();
      } catch (e) {
        console.warn(`[myco] Audio.take: a source couldn't stop (${messageOf(e)}).`);
      }
    }
  }

  stop(message: string | null = null): void {
    this.token++;
    const rec = this.rec;
    const ring = this.ring;
    if (!rec || !ring) return;
    if (takeTap.sink === rec) takeTap.sink = null;
    this.rec = null;
    this.ring = null;
    if (message !== null) this.stopMessage = message;
    this.lastSeconds = rec.seconds;
    this.stopSources();
    try {
      const { requests, section } = rec.finish(this.seedFacts);
      const frozen = ring.freeze();
      this.saved = { ...frozen, meta: { ...frozen.meta, take: section }, requests };
    } catch (e) {
      console.warn(`[myco] Audio.take: the take couldn't be kept (${messageOf(e)}).`);
      this.saved = null;
    } finally {
      ring.release();
    }
  }

  mark(text: string): void {
    this.rec?.mark(String(text));
  }

  save(name?: string): Promise<string> {
    if (this.rec) this.stop();
    const take = this.saved;
    if (!take) return Promise.reject(new Error(NOTHING_RECORDED));
    return import("./save").then((s) => s.saveCapture(take, name));
  }

  /** The stopped take's file bytes (compressed where the runtime can), for a caller that writes the file itself. */
  bytes(): Promise<Uint8Array> {
    if (this.rec) this.stop();
    const take = this.saved;
    if (!take) return Promise.reject(new Error(NOTHING_RECORDED));
    return import("./save").then((s) => s.captureFileBytes(take));
  }

  /** The Engine is disposed: a running take stops (kept for a save), nothing else. */
  released(): void {
    if (this.rec) this.stop("the take stopped: the audio engine was released");
  }
}

const take = new Take();

/** ADR 0348: Play stops (the ring is freed): a running take stops and is kept for `save()`. */
onCapturePlayStopped(() => take.released());
onAudioSessionReleased(() => take.released());

/** `Audio.take`: only the public members. */
export const audioTake: AudioTake = {
  get state() {
    return take.state;
  },
  get seconds() {
    return take.seconds;
  },
  start: () => take.start(),
  stop: () => take.stop(),
  mark: (text) => take.mark(text),
  save: (name) => take.save(name),
};

/** @internal The editor's Record take toggle: the stopped take's bytes, to write into the project's `recordings/` folder itself. */
export function takeFileBytes(): Promise<Uint8Array> {
  return take.bytes();
}

/** @internal Why the last take stopped by itself (the take cap reached, the recorder released); null when it was stopped. */
export function takeStopMessage(): string | null {
  return take.stopMessage;
}
