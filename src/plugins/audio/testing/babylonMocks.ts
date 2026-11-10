// @internal Test mocks of the Babylon AudioV2 modules the fallback backend uses (ADR 0157 BB1, leaf L1), written from
// their `.d.ts` (`@babylonjs/core` 9.32.0) and recording every call. The backend imports one module,
// `@babylonjs/core/AudioV2/webAudio/webAudioEngine` (`CreateAudioEngineAsync`); everything else it reaches through the
// engine it gets back. A test mocks that module with this file's `webAudioEngineModule`:
//
//   vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);
//
// and drives and inspects the fakes through `babylonMock`. `makeFakeContext()` stands in for the `AudioContext`.

/** A promise a test settles by hand. */
interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Babylon's `Observable`, as far as the backend uses it. */
export class MockObservable<T> {
  private readonly observers: ((value: T) => void)[] = [];
  add(callback: (value: T) => void): (value: T) => void {
    this.observers.push(callback);
    return callback;
  }
  addOnce(callback: (value: T) => void): (value: T) => void {
    const once = (value: T) => {
      this.remove(once);
      callback(value);
    };
    this.observers.push(once);
    return once;
  }
  remove(observer: (value: T) => void): boolean {
    const i = this.observers.indexOf(observer);
    if (i < 0) return false;
    this.observers.splice(i, 1);
    return true;
  }
  clear(): void {
    this.observers.length = 0;
  }
  notify(value: T): void {
    for (const o of [...this.observers]) o(value);
  }
}

/** The in-place `Vector3`/`Quaternion` the backend writes (`set`). */
export class MockVector {
  x = 0;
  y = 0;
  z = 0;
  w = 1;
  sets = 0;
  set(x: number, y: number, z: number, w?: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    if (w !== undefined) this.w = w;
    this.sets++;
    return this;
  }
}

/** A sound's (or bus's) `spatial` property. */
export class MockSpatial {
  distanceModel = "inverse";
  minDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  panningModel = "equalpower";
  panningEnabled = true;
  readonly position = new MockVector();
  updates = 0;
  update(): void {
    this.updates++;
  }
}

export interface MockRamp {
  readonly value: number;
  readonly duration: number | null;
}

/** An `AudioBus` or the main bus. */
export class MockBus {
  volume: number;
  outBus: MockBus | null;
  disposed = false;
  readonly ramps: MockRamp[] = [];
  constructor(readonly name: string, readonly options: Record<string, unknown> = {}, readonly main = false) {
    this.volume = typeof options.volume === "number" ? options.volume : 1;
    this.outBus = (options.outBus as MockBus | undefined) ?? null;
  }
  setVolume(value: number, options?: { duration?: number } | null): void {
    this.volume = value;
    this.ramps.push({ value, duration: options?.duration ?? null });
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A decoded clip (`StaticSoundBuffer`). */
export class MockBuffer {
  duration = 1;
  constructor(readonly url: string) {}
}

export interface MockPlayCall {
  readonly waitTime?: number;
  readonly [key: string]: unknown;
}

/** A `StaticSound` or `StreamingSound`. `finish()` ends it the way a clip reaching its end does. */
export class MockSound {
  volume: number;
  loop: boolean;
  playbackRate: number;
  maxInstances: number;
  outBus: MockBus | null;
  state: "stopped" | "started" | "paused" = "stopped";
  disposed = false;
  readonly plays: MockPlayCall[] = [];
  readonly ramps: MockRamp[] = [];
  readonly stops: unknown[] = [];
  pauses = 0;
  resumes = 0;
  /** True once the backend touched `spatial` (which makes a Babylon sound spatial). */
  spatialTouched: boolean;
  readonly onEndedObservable = new MockObservable<MockSound>();
  readonly stereo = { pan: 0 };
  private spatialProp: MockSpatial | null = null;

  constructor(
    readonly kind: "static" | "streaming",
    readonly name: string,
    readonly source: unknown,
    readonly options: Record<string, unknown>,
  ) {
    this.volume = typeof options.volume === "number" ? options.volume : 1;
    this.loop = options.loop === true;
    this.playbackRate = typeof options.playbackRate === "number" ? options.playbackRate : 1;
    this.maxInstances = typeof options.maxInstances === "number" ? options.maxInstances : Infinity;
    this.outBus = (options.outBus as MockBus | undefined) ?? null;
    this.spatialTouched = options.spatialEnabled === true;
    if (this.spatialTouched) {
      const s = this.spatial;
      if (typeof options.spatialDistanceModel === "string") s.distanceModel = options.spatialDistanceModel;
      if (typeof options.spatialMinDistance === "number") s.minDistance = options.spatialMinDistance;
      if (typeof options.spatialMaxDistance === "number") s.maxDistance = options.spatialMaxDistance;
      if (typeof options.spatialRolloffFactor === "number") s.rolloffFactor = options.spatialRolloffFactor;
      if (typeof options.spatialPanningModel === "string") s.panningModel = options.spatialPanningModel;
    }
  }

  get spatial(): MockSpatial {
    this.spatialTouched = true;
    return (this.spatialProp ??= new MockSpatial());
  }
  play(options: MockPlayCall = {}): void {
    this.plays.push(options);
    this.state = "started";
  }
  pause(): void {
    this.pauses++;
    this.state = "paused";
  }
  resume(): void {
    this.resumes++;
    this.state = "started";
  }
  stop(options?: unknown): void {
    this.stops.push(options);
    this.state = "stopped";
    this.onEndedObservable.notify(this);
  }
  setVolume(value: number, options?: { duration?: number } | null): void {
    this.volume = value;
    this.ramps.push({ value, duration: options?.duration ?? null });
  }
  dispose(): void {
    this.disposed = true;
  }
  /** The clip reached its end. */
  finish(): void {
    this.state = "stopped";
    this.onEndedObservable.notify(this);
  }
}

/** The audio engine, with the listener, buses and sounds it made. */
export class MockEngine {
  volume: number;
  currentTime = 0;
  state = "running";
  disposed = false;
  readonly listener = { position: new MockVector(), rotation: new MockVector(), rotationQuaternion: new MockVector(), updates: 0, update() { this.updates++; } };
  readonly defaultMainBus = new MockBus("default", {}, true);
  readonly buses: MockBus[] = [];
  readonly sounds: MockSound[] = [];
  /** The URLs `createSoundBufferAsync` decoded, in order. */
  readonly bufferLoads: string[] = [];
  readonly streamLoads: string[] = [];

  constructor(readonly options: Record<string, unknown>) {
    this.volume = typeof options.volume === "number" ? options.volume : 1;
  }

  private async gate(): Promise<void> {
    await Promise.resolve();
    await babylonMock.gatePromise();
  }
  async createBusAsync(name: string, options: Record<string, unknown> = {}): Promise<MockBus> {
    await this.gate();
    const bus = new MockBus(name, options);
    this.buses.push(bus);
    return bus;
  }
  async createMainBusAsync(name: string): Promise<MockBus> {
    await this.gate();
    return new MockBus(name, {}, true);
  }
  async createSoundBufferAsync(source: string): Promise<MockBuffer> {
    await this.gate();
    this.bufferLoads.push(source);
    if (babylonMock.failUrls.has(source)) throw new Error(`mock: cannot decode ${source}`);
    return new MockBuffer(source);
  }
  async createSoundAsync(name: string, source: MockBuffer | string, options: Record<string, unknown> = {}): Promise<MockSound> {
    await this.gate();
    if (typeof source === "string") source = await this.createSoundBufferAsync(source);
    const sound = new MockSound("static", name, source, options);
    this.sounds.push(sound);
    return sound;
  }
  async createStreamingSoundAsync(name: string, source: string, options: Record<string, unknown> = {}): Promise<MockSound> {
    await this.gate();
    this.streamLoads.push(source);
    if (babylonMock.failUrls.has(source)) throw new Error(`mock: cannot stream ${source}`);
    const sound = new MockSound("streaming", name, source, options);
    this.sounds.push(sound);
    return sound;
  }
  /** Like Babylon's: disposing the engine closes the context it was given. */
  dispose(): void {
    this.disposed = true;
    (this.options.audioContext as { close?: () => unknown } | undefined)?.close?.();
  }
}

/** The controls and the record of the mocked module. Call `reset()` in `beforeEach`. */
export const babylonMock = {
  /** Every engine `CreateAudioEngineAsync` made, oldest first. */
  engines: [] as MockEngine[],
  /** URLs whose decode or stream fails. */
  failUrls: new Set<string>(),
  /** When set, `CreateAudioEngineAsync` rejects with it. */
  failEngine: null as Error | null,
  /** How many times `CreateAudioEngineAsync` was called. */
  creates: 0,
  gate: null as Deferred | null,
  get engine(): MockEngine {
    const e = this.engines.at(-1);
    if (!e) throw new Error("no mock engine yet");
    return e;
  },
  /** Every sound of the newest engine. */
  get sounds(): MockSound[] {
    return this.engine.sounds;
  },
  /** Makes every asynchronous create wait until the returned function is called (a load still in flight). */
  hold(): () => void {
    const gate = deferred();
    this.gate = gate;
    return () => {
      if (this.gate === gate) this.gate = null;
      gate.resolve();
    };
  },
  gatePromise(): Promise<void> {
    return this.gate ? this.gate.promise : Promise.resolve();
  },
  reset(): void {
    this.engines = [];
    this.failUrls.clear();
    this.failEngine = null;
    this.creates = 0;
    this.gate = null;
  },
};

/** The mocked `@babylonjs/core/AudioV2/webAudio/webAudioEngine`. */
export const webAudioEngineModule = {
  async CreateAudioEngineAsync(options: Record<string, unknown> = {}): Promise<MockEngine> {
    babylonMock.creates++;
    await babylonMock.gatePromise();
    if (babylonMock.failEngine) throw babylonMock.failEngine;
    const engine = new MockEngine(options);
    babylonMock.engines.push(engine);
    return engine;
  },
};

/** An `AudioContext` stand-in: a mutable state, `resume`, `statechange` events, a clock and a recorded `close`. */
export function makeFakeContext(state = "suspended") {
  const listeners = new Set<() => void>();
  const context = {
    state,
    currentTime: 0,
    sampleRate: 48_000,
    resumes: 0,
    suspends: 0,
    closed: false,
    resume(): Promise<void> {
      context.resumes++;
      context.setState("running");
      return Promise.resolve();
    },
    suspend(): Promise<void> {
      context.suspends++;
      context.setState("suspended");
      return Promise.resolve();
    },
    close(): Promise<void> {
      context.closed = true;
      context.state = "closed";
      return Promise.resolve();
    },
    addEventListener(_type: string, listener: () => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void): void {
      listeners.delete(listener);
    },
    setState(next: string): void {
      if (context.state === next) return;
      context.state = next;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
  return context;
}

export type FakeContext = ReturnType<typeof makeFakeContext>;
