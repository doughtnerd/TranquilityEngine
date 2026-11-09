// The core's `AudioBackend` (ADR 0157 K3; api-and-models §3 "Mixer counting", §6 "AudioBackend changes"; architecture
// §3.2): plays through the voice table and the command writer, reads the core through the status mirror, loads
// clips through the clip registry (K9), and keeps time with the clock map. `service.ts` registers a factory for it
// (`registerCoreBackend`) once the core has loaded.
//
// Frame flow (`update(dt)`, called by the audio system once per frame): clock.beginFrame, mirror.beginFrame, free ended
// voices, apply clip events (resident clips start their waiting voices), drain the table's STOP and FADE commands
// into the writer, flush the batch at `clock.nextFirstFrame()`. Everything in `onmessage` (the mirror) is separate.
//
// A1.6 adds `volume, pitch, priority, oneShot, at, attenuation, position` to `PlayRequest` and `id, reason, fade,
// setPriority, stop(fadeSeconds)` to `AudioVoice` (§6); until then `CorePlayRequest` and `CoreVoice` carry them as
// optional extras, so this class implements today's `AudioBackend` and A1.6's change is a rename.
import type { Vec3Like } from "../../../../engine/core/math";
import type { Attenuation, AudioBackend, AudioVoice, ListenerPose, PlayRequest } from "../backend";
import type { Mixer, ResolvedBus } from "../../../../engine/audio/mixer";
import type { AudioReason } from "./handle";
import type { AudioHost } from "./context";
import type { ClipRegistry } from "./clipRegistry";
import type { HostClock } from "./hostClock";
import type { AudioDebugInfo } from "./debug";
import { AudioHandle } from "./handle";
import { CommandWriter } from "./commandWriter";
import { ClockMap } from "./clock";
import { StatusMirror } from "./mirror";
import { VoiceTable } from "./voiceTable";

/** §1 `OneShotOptions`, as `PlayRequest` will carry them (A1.6). */
export interface CorePlayRequest extends PlayRequest {
  volume?: number;
  pitch?: number;
  priority?: number;
  oneShot?: boolean;
  /** Start at this audio-clock time (seconds, `Audio.time`'s base). */
  at?: number;
  attenuation?: Attenuation;
  position?: Vec3Like;
  /** The World key of the playing World (0 or omitted: none). */
  world?: number;
}

/** One voice as `AudioVoice` (today's members) plus §6's additions. */
export interface CoreVoice extends AudioVoice {
  readonly id: number;
  readonly reason: AudioReason | null;
  readonly handle: AudioHandle;
  fade(to: number, seconds: number): void;
  setPriority(priority: number): void;
  stop(fadeSeconds?: number): void;
}

/** What `createCoreBackend` takes beyond the host (tests inject fakes). */
export interface CoreBackendDeps {
  /** The registry for clips; defaults to `createClipRegistry()` (K9). */
  clips?: ClipRegistry;
  clock?: HostClock;
  mixer?: Mixer;
  /** The table; defaults to one of `host.preset.maxLogical` slots. */
  table?: VoiceTable;
}

export class CoreBackend implements AudioBackend {
  readonly name = "core";
  readonly table: VoiceTable;
  readonly mirror: StatusMirror;
  readonly writer: CommandWriter;
  readonly clockMap: ClockMap;

  constructor(
    readonly host: Pick<AudioHost, "link" | "context" | "status" | "preset" | "busNames" | "addLifecycleListener">,
    deps: CoreBackendDeps = {},
  ) {
    void deps;
    this.table = undefined as unknown as VoiceTable;
    this.mirror = undefined as unknown as StatusMirror;
    this.writer = undefined as unknown as CommandWriter;
    this.clockMap = undefined as unknown as ClockMap;
    throw new Error("not implemented: A1.4 (CoreBackend)");
  }

  /** §1 `Audio.time`. */
  get time(): number {
    throw new Error("not implemented: A1.4 (CoreBackend.time)");
  }

  /** §1 `Audio.status`. */
  get status(): "locked" | "running" | "failed" {
    throw new Error("not implemented: A1.4 (CoreBackend.status)");
  }

  /** Starts a clip; always returns a voice unless the table refused it (then null). */
  play(req: CorePlayRequest): CoreVoice | null {
    void req;
    throw new Error("not implemented: A1.4 (CoreBackend.play)");
  }

  setListener(pose: ListenerPose): void {
    void pose;
    throw new Error("not implemented: A1.4 (CoreBackend.setListener)");
  }

  applyMix(buses: readonly ResolvedBus[]): void {
    void buses;
    throw new Error("not implemented: A1.4 (CoreBackend.applyMix)");
  }

  configureBuses(mixer: Mixer): void {
    void mixer;
    throw new Error("not implemented: A1.4 (CoreBackend.configureBuses)");
  }

  masterVolume = 1;
  muted = false;

  update(dt: number): void {
    void dt;
    throw new Error("not implemented: A1.4 (CoreBackend.update)");
  }

  /** `Audio.debug()` (K10): delegates to `debug.ts`. */
  debug(): AudioDebugInfo {
    throw new Error("not implemented: A1.4 (CoreBackend.debug)");
  }

  dispose(): void {
    throw new Error("not implemented: A1.4 (CoreBackend.dispose)");
  }
}

/** The factory `service.ts` registers with `registerCoreBackend`. */
export function createCoreBackend(host: CoreBackend["host"], deps: CoreBackendDeps = {}): CoreBackend {
  return new CoreBackend(host, deps);
}
