/**
 * The default audio backend (ADR 0074, 0097, 0098): Howler for playback, with the mixer's buses as Web
 * Audio nodes on Howler's own AudioContext. Sounds are re-routed from Howler's master gain to their
 * bus's input. Streamed (HTML5 audio) clips can't be routed, so their bus level is applied as volume.
 */
import { Howl, Howler } from "howler";
import type { Vec3Like } from "../core/math";
import { BusGraph } from "./busGraph";
import { mixer, registerDefaultBackend, type AudioBackend, type AudioDebugInfo, type AudioReason, type AudioStatus, type AudioVoice, type Attenuation, type ListenerPose, type PlayRequest } from "./backend";
import type { Mixer, ResolvedBus } from "./mixer";

const howls = new Map<string, Howl>();
function howlFor(req: PlayRequest): Howl {
  const key = `${req.path}|${req.loop}|${req.stream}`;
  let h = howls.get(key);
  if (!h) {
    h = new Howl({ src: [req.url], loop: req.loop, preload: true, html5: req.stream });
    howls.set(key, h);
  }
  return h;
}

type SoundInternals = { _node?: AudioNode; _panner?: AudioNode };

let nextVoiceId = 1;

class HowlerVoice implements AudioVoice {
  readonly id = nextVoiceId++;
  /** The fallback has no stealing, virtual or locked voices (api-and-models §1 "Fallback backend"). */
  readonly reason: AudioReason | null = null;
  private ended = false;
  private routed: AudioNode | null = null;
  private volume = 1;
  constructor(private backend: HowlerBackend, private howl: Howl, private howlId: number, private req: PlayRequest, private bus: string) {
    mixer.voiceStarted(bus);
    if (!req.loop && typeof howl.once === "function") howl.once("end", () => this.finish(), howlId);
    this.route();
  }
  get playing(): boolean { return !this.ended && this.howl.playing(this.howlId); }
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    mixer.voiceEnded(this.bus);
  }
  /** Connect the sound's last node (its panner once spatial) to its bus. No-op for streamed clips or without Web Audio. */
  private route(): void {
    const graph = this.backend.graph;
    if (!graph || this.req.stream) return;
    const sound = (this.howl as unknown as { _soundById?: (id: number) => SoundInternals | null })._soundById?.(this.howlId);
    const last = sound?._panner ?? sound?._node;
    if (!last || last === this.routed) return;
    try {
      last.disconnect();
      last.connect(graph.input(this.bus));
      this.routed = last;
    } catch { /* a node already gone: the sound is ending */ }
  }
  /** Streamed clips: scale volume by the bus's effective gain, since they bypass the graph. */
  private apply(): void {
    const g = this.req.stream ? (this.backend.gains.get(this.bus) ?? 1) : 1;
    this.howl.volume(this.volume * g, this.howlId);
  }
  /** @internal */ _remix(): void { if (this.req.stream && !this.ended) this.apply(); }
  setVolume(v: number): void { this.volume = v; this.apply(); }
  /** Ease the gain to `to` times the voice's volume. Instant when `seconds` is 0 or the clip streams. */
  fade(to: number, seconds: number): void {
    const target = Math.min(4, Math.max(0, Number.isFinite(to) ? to : 1));
    const g = this.req.stream ? (this.backend.gains.get(this.bus) ?? 1) : 1;
    if (seconds > 0 && typeof this.howl.fade === "function") this.howl.fade(this.howl.volume(this.howlId) as number, this.volume * g * target, seconds * 1000, this.howlId);
    else this.howl.volume(this.volume * g * target, this.howlId);
  }
  /** Priority has no meaning here: Howler never steals. */
  setPriority(priority: number): void { void priority; }
  setPitch(rate: number): void { this.howl.rate(rate, this.howlId); }
  setAttenuation(a: Attenuation): void {
    const min = Math.max(0, a.minDistance);
    this.howl.pannerAttr(
      { distanceModel: a.rolloff as "linear" | "inverse", refDistance: min, maxDistance: Math.max(min, a.maxDistance), rolloffFactor: 1, panningModel: "HRTF" },
      this.howlId,
    );
    this.route();
  }
  setPosition(p: Vec3Like): void { this.howl.pos(p.x, p.y, p.z, this.howlId); this.route(); }
  setBus(bus: string): void {
    if (bus === this.bus) return;
    mixer.voiceEnded(this.bus);
    this.bus = bus;
    mixer.voiceStarted(bus);
    this.routed = null;
    this.route();
    this.apply();
  }
  pause(): void { this.howl.pause(this.howlId); }
  resume(): void { this.howl.play(this.howlId); }
  stop(fadeSeconds = 0): void {
    if (fadeSeconds > 0 && typeof this.howl.fade === "function" && !this.ended) {
      this.ended = true; // `playing` goes false now; the sound dies when its fade ends
      mixer.voiceEnded(this.bus);
      this.howl.fade(this.howl.volume(this.howlId) as number, 0, fadeSeconds * 1000, this.howlId);
      setTimeout(() => this.howl.stop(this.howlId), fadeSeconds * 1000);
      return;
    }
    this.howl.stop(this.howlId);
    this.finish();
  }
}

export class HowlerBackend implements AudioBackend {
  readonly name = "howler";
  graph: BusGraph | null = null;
  gains = new Map<string, number>();
  private voices = new Set<HowlerVoice>();

  play(req: PlayRequest): AudioVoice | null {
    const howl = howlFor(req);
    this.ensureGraph(); // Howler's AudioContext exists once the first Howl has
    const id = howl.play();
    const voice = new HowlerVoice(this, howl, id, req, req.bus);
    if (req.volume !== undefined) voice.setVolume(req.volume);
    if (req.pitch !== undefined) voice.setPitch(req.pitch);
    if (req.attenuation) voice.setAttenuation(req.attenuation);
    if (req.position) voice.setPosition(req.position);
    this.voices.add(voice);
    if (typeof howl.once === "function") howl.once("end", () => this.voices.delete(voice), id);
    return voice;
  }

  setListener(p: ListenerPose): void {
    Howler.pos(p.position.x, p.position.y, p.position.z);
    Howler.orientation(p.forward.x, p.forward.y, p.forward.z, p.up.x, p.up.y, p.up.z);
  }

  private mixerRef: Mixer | null = null;
  configureBuses(m: Mixer): void {
    this.graph?.dispose();
    this.graph = null;
    this.mixerRef = m;
    this.ensureGraph();
  }

  private ensureGraph(): void {
    const m = this.mixerRef;
    if (this.graph || !m) return;
    const ctx = (Howler as unknown as { ctx?: AudioContext | null }).ctx;
    const master = (Howler as unknown as { masterGain?: AudioNode }).masterGain;
    if (ctx && master) {
      this.graph = new BusGraph(ctx, master, m);
      this.graph.apply(m.resolveAll());
    }
  }

  applyMix(buses: readonly ResolvedBus[]): void {
    for (const b of buses) this.gains.set(b.name, b.effectiveGain);
    this.graph?.apply(buses);
    for (const v of this.voices) v._remix();
  }

  /** The fallback is always "running": Howler does its own unlocking (the host's unlock layer covers it from BB1). */
  readonly status: AudioStatus = "running";
  /** The heard clock, from Howler's context (0 before it exists). */
  get time(): number { return (Howler as unknown as { ctx?: AudioContext | null }).ctx?.currentTime ?? 0; }
  update(dt: number): void { void dt; }
  setBackground(): void { /* no background policy on the fallback */ }
  debug(): AudioDebugInfo {
    const ctx = (Howler as unknown as { ctx?: AudioContext | null }).ctx;
    return {
      status: "running",
      sampleRate: ctx?.sampleRate ?? 0,
      time: this.time,
      background: "mute",
      counters: { underruns: 0, lateCommands: 0, minSlackFrames: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: this.voices.size, mixedCap: 0, logicalVoices: this.voices.size, queuedPlays: 0, droppedPlays: 0, traps: 0, refusedLoads: 0, hrtfVoices: 0, hrtfLoadFailure: 0 },
      buses: [],
      voices: [],
      core: { backend: "howler" },
    };
  }

  get masterVolume(): number { return Howler.volume(); }
  set masterVolume(v: number) { Howler.volume(v); }
  set muted(m: boolean) { this.isMuted = m; Howler.mute(m); }
  private isMuted = false;
  get muted(): boolean { return this.isMuted; }
}

registerDefaultBackend(() => new HowlerBackend());
