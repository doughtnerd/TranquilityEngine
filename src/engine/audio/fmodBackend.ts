/**
 * Internal (ADR 0099, Proposed): a stub FMOD adapter behind the audio backend interface (ADR 0098).
 * It loads the FMOD HTML5 SDK from a folder the project supplies (`audio.fmod.sdkPath`), because the SDK
 * needs a logged-in fmod.com download and can't ship with the engine.
 *
 * UNTESTED AGAINST THE REAL SDK. Every call into the `FMOD` module below is written from FMOD's
 * documented HTML5 examples (https://fmod.com/docs/2.03/api/platforms-html5.html) and has only been
 * exercised against a fake module in `engine/tests/fmodBackend.test.ts`. Names, argument order and the
 * `{val}` out-parameter convention need checking with the SDK in hand; see docs/guide/fmod.md.
 */
import { setAudioBackend, type AudioBackend, type AudioVoice, type Attenuation, type ListenerPose, type PlayRequest } from "./backend";
import type { Mixer, ResolvedBus } from "./mixer";
import type { Vec3Like } from "../core/math";

/** The slice of the FMOD HTML5 module this adapter calls. Deliberately loose: the real typings aren't available here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface FmodModule {
  [key: string]: any;
}

export interface FmodOptions {
  /** Folder (URL path) holding `fmodstudio.js` and `fmodstudio.wasm`, and the banks. */
  sdkPath: string;
  /** Bank files under `sdkPath` to load (include the Master bank and its `.strings.bank`). */
  banks: string[];
  /** Test seam: how the SDK script is loaded. Default injects a `<script>` tag. */
  loadScript?: (url: string) => Promise<void>;
  /** Test seam: where `FMODModule` is found once the script has run. */
  globalObject?: Record<string, unknown>;
}

const join = (base: string, file: string) => `${base.replace(/\/+$/, "")}/${file}`;

function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`could not load ${url}`));
    document.head.appendChild(el);
  });
}

/** Everything FMOD returns through `{ val }` out-parameters, with its error code checked. */
function check(result: unknown, what: string): void {
  if (result !== 0 && result !== undefined) throw new Error(`FMOD ${what} failed (result ${String(result)}). See docs/guide/fmod.md.`);
}

class FmodVoice implements AudioVoice {
  private ended = false;
  constructor(private backend: FmodBackend, private channel: any, private sound: any, private bus: string) {
    mixerRef?.voiceStarted(bus);
  }
  get playing(): boolean {
    if (this.ended) return false;
    const out: any = {};
    return this.channel.isPlaying(out) === 0 ? !!out.val : false;
  }
  setVolume(v: number): void { this.channel.setVolume(v); }
  setPitch(rate: number): void { this.channel.setPitch(rate); }
  setAttenuation(a: Attenuation): void {
    this.channel.set3DMinMaxDistance(a.minDistance, a.maxDistance);
    this.channel.setMode(this.backend.fmod.MODE_3D | (a.rolloff === "linear" ? this.backend.fmod.MODE_3D_LINEARROLLOFF : this.backend.fmod.MODE_3D_INVERSEROLLOFF));
  }
  setPosition(p: Vec3Like): void {
    const attrs = this.backend.vec(p);
    this.channel.set3DAttributes(attrs, this.backend.vec({ x: 0, y: 0, z: 0 }));
  }
  setBus(bus: string): void {
    if (bus === this.bus) return;
    mixerRef?.voiceEnded(this.bus);
    this.bus = bus;
    mixerRef?.voiceStarted(bus);
    const group = this.backend.groups.get(bus);
    if (group) this.channel.setChannelGroup(group);
  }
  pause(): void { this.channel.setPaused(true); }
  resume(): void { this.channel.setPaused(false); }
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.channel.stop();
    mixerRef?.voiceEnded(this.bus);
  }
}

let mixerRef: Mixer | null = null;

export class FmodBackend implements AudioBackend {
  readonly name = "fmod";
  /** Core ChannelGroup per mixer bus: the "bus tree" for clips played through the Core API. */
  groups = new Map<string, any>();
  private sounds = new Map<string, any>();
  private core: any;
  private system: any;
  private master = 1;

  private constructor(readonly fmod: FmodModule, private options: FmodOptions) {}

  /** Load the SDK and start FMOD. Rejects with a readable error when the SDK is missing or its API differs. */
  static async load(options: FmodOptions): Promise<FmodBackend> {
    const g = options.globalObject ?? (globalThis as unknown as Record<string, unknown>);
    if (typeof g.FMODModule !== "function") await (options.loadScript ?? injectScript)(join(options.sdkPath, "fmodstudio.js"));
    const factory = g.FMODModule as ((m: FmodModule) => unknown) | undefined;
    if (typeof factory !== "function") throw new Error(`${join(options.sdkPath, "fmodstudio.js")} did not define FMODModule. Is this the FMOD HTML5 SDK?`);
    const fmod: FmodModule = {
      // Emscripten reads these: mount the banks before main runs, then tell us when the runtime is up.
      preRun: [] as (() => void)[],
      TOTAL_MEMORY: 64 * 1024 * 1024,
      locateFile: (file: string) => join(options.sdkPath, file),
    };
    const ready = new Promise<void>((resolve) => { fmod.onRuntimeInitialized = () => resolve(); });
    fmod.preRun.push(() => {
      for (const bank of options.banks) fmod.FS_createPreloadedFile("/", bank.split("/").pop()!, join(options.sdkPath, bank), true, false);
    });
    factory(fmod);
    await ready;
    const backend = new FmodBackend(fmod, options);
    backend.start();
    return backend;
  }

  private start(): void {
    const { fmod } = this;
    const out: any = {};
    check(fmod.Studio_System_Create(out), "Studio_System_Create");
    this.system = out.val;
    check(this.system.getCoreSystem(out), "getCoreSystem");
    this.core = out.val;
    check(this.core.setSoftwareFormat(0, fmod.SPEAKERMODE_DEFAULT, 0), "setSoftwareFormat");
    check(this.system.initialize(1024, fmod.STUDIO_INITFLAGS.NORMAL, fmod.INITFLAGS.NORMAL, null), "Studio initialize");
    for (const bank of this.options.banks) check(this.system.loadBankFile(`/${bank.split("/").pop()}`, fmod.STUDIO_LOAD_BANK_NORMAL, out), `loadBankFile ${bank}`);
  }

  /** Vector in the shape FMOD's 3D calls take. */
  vec(p: Vec3Like): any {
    const v = (this.fmod.FMOD_VECTOR ? new this.fmod.FMOD_VECTOR() : {}) as any;
    v.x = p.x; v.y = p.y; v.z = p.z;
    return v;
  }

  configureBuses(m: Mixer): void {
    mixerRef = m;
    const out: any = {};
    this.groups.clear();
    for (const b of m.resolveAll()) {
      check(this.core.createChannelGroup(b.name, out), `createChannelGroup ${b.name}`);
      this.groups.set(b.name, out.val);
    }
    for (const b of m.resolveAll()) {
      const parent = b.parent ? this.groups.get(b.parent) : this.masterGroup();
      parent?.addGroup(this.groups.get(b.name));
    }
  }

  private masterGroup(): any {
    const out: any = {};
    this.core.getMasterChannelGroup(out);
    return out.val;
  }

  applyMix(buses: readonly ResolvedBus[]): void {
    for (const b of buses) this.groups.get(b.name)?.setVolume(b.gain);
    // Effects (lowpass/highpass/compressor/reverb) are not mapped yet: FMOD would use DSPs here or
    // Studio bus effects authored in FMOD Studio. See ADR 0099.
  }

  play(req: PlayRequest): AudioVoice | null {
    let sound = this.sounds.get(req.path);
    if (!sound) {
      const out: any = {};
      const mode = this.fmod.DEFAULT | (req.loop ? this.fmod.LOOP_NORMAL : this.fmod.LOOP_OFF);
      if (this.core.createSound(req.url, mode, null, out) !== 0) return null; // Core can't read every format in the HTML5 build
      sound = out.val;
      this.sounds.set(req.path, sound);
    }
    const out: any = {};
    if (this.core.playSound(sound, this.groups.get(req.bus) ?? null, false, out) !== 0) return null;
    return new FmodVoice(this, out.val, sound, req.bus);
  }

  setListener(p: ListenerPose): void {
    this.system.setListenerAttributes(0, { position: p.position, velocity: { x: 0, y: 0, z: 0 }, forward: p.forward, up: p.up });
  }

  update(): void {
    this.system.update();
  }

  get masterVolume(): number { return this.master; }
  set masterVolume(v: number) { this.master = v; this.masterGroup()?.setVolume(v); }
  set muted(m: boolean) { this.masterGroup()?.setMute(m); }
  get muted(): boolean { return false; }

  dispose(): void {
    this.system?.release();
  }
}

/** Start the FMOD backend if the project asks for it; on any failure say why and keep the default. */
export async function useFmodBackendIfConfigured(audio: { backend: string; fmod?: { sdkPath: string; banks: string[] } }): Promise<boolean> {
  if (audio.backend !== "fmod" || !audio.fmod) return false;
  try {
    setAudioBackend(await FmodBackend.load(audio.fmod));
    return true;
  } catch (e) {
    console.warn(`[myco] FMOD backend unavailable, using Howler: ${(e as Error).message}`);
    return false;
  }
}
