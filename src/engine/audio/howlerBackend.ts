/**
 * The default audio backend (ADR 0074, 0097, 0098): Howler for playback, with the mixer's buses as Web
 * Audio nodes on Howler's own AudioContext. Sounds are re-routed from Howler's master gain to their
 * bus's input. Streamed (HTML5 audio) clips can't be routed, so their bus level is applied as volume.
 */
import { Howl, Howler } from "howler";
import type { Vec3Like } from "../core/math";
import { BusGraph } from "./busGraph";
import { mixer, registerDefaultBackend, type AudioBackend, type AudioVoice, type Attenuation, type ListenerPose, type PlayRequest } from "./backend";
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

class HowlerVoice implements AudioVoice {
  private ended = false;
  private routed: AudioNode | null = null;
  private volume = 1;
  constructor(private backend: HowlerBackend, private howl: Howl, private id: number, private req: PlayRequest, private bus: string) {
    mixer.voiceStarted(bus);
    if (!req.loop && typeof howl.once === "function") howl.once("end", () => this.finish(), id);
    this.route();
  }
  get playing(): boolean { return !this.ended && this.howl.playing(this.id); }
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    mixer.voiceEnded(this.bus);
  }
  /** Connect the sound's last node (its panner once spatial) to its bus. No-op for streamed clips or without Web Audio. */
  private route(): void {
    const graph = this.backend.graph;
    if (!graph || this.req.stream) return;
    const sound = (this.howl as unknown as { _soundById?: (id: number) => SoundInternals | null })._soundById?.(this.id);
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
    this.howl.volume(this.volume * g, this.id);
  }
  /** @internal */ _remix(): void { if (this.req.stream && !this.ended) this.apply(); }
  setVolume(v: number): void { this.volume = v; this.apply(); }
  setPitch(rate: number): void { this.howl.rate(rate, this.id); }
  setAttenuation(a: Attenuation): void {
    const min = Math.max(0, a.minDistance);
    this.howl.pannerAttr(
      { distanceModel: a.rolloff as "linear" | "inverse", refDistance: min, maxDistance: Math.max(min, a.maxDistance), rolloffFactor: 1, panningModel: "HRTF" },
      this.id,
    );
    this.route();
  }
  setPosition(p: Vec3Like): void { this.howl.pos(p.x, p.y, p.z, this.id); this.route(); }
  setBus(bus: string): void {
    if (bus === this.bus) return;
    mixer.voiceEnded(this.bus);
    this.bus = bus;
    mixer.voiceStarted(bus);
    this.routed = null;
    this.route();
    this.apply();
  }
  pause(): void { this.howl.pause(this.id); }
  resume(): void { this.howl.play(this.id); }
  stop(): void { this.howl.stop(this.id); this.finish(); }
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

  get masterVolume(): number { return Howler.volume(); }
  set masterVolume(v: number) { Howler.volume(v); }
  set muted(m: boolean) { Howler.mute(m); }
  get muted(): boolean { return false; }
}

registerDefaultBackend(() => new HowlerBackend());
