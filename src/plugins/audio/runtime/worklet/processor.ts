// The AudioWorklet processor (ADR 0157; architecture §1 "Processor shell"). Loaded with `audioWorklet.addModule`
// as its own bundle (`loader.ts`), never imported by main-thread code: importing it would call
// `registerProcessor`, which only exists in AudioWorkletGlobalScope. All logic is in `coreDriver.ts`; this file
// binds it to the worklet's globals (`sampleRate`, `currentFrame`, `Date.now`) and its port.
import { CoreDriver, type CoreControlMessage, type CoreProcessorOptions } from "./coreDriver";

// AudioWorkletGlobalScope (the DOM lib doesn't declare it).
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: CoreProcessorOptions }) => AudioWorkletProcessor): void;

class CoreProcessor extends AudioWorkletProcessor {
  private readonly driver: CoreDriver | null = null;

  constructor(options: { processorOptions: CoreProcessorOptions }) {
    super(options);
    throw new Error("not implemented: A0.3");
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    throw new Error("not implemented: A0.3");
  }

  private onMessage(data: ArrayBuffer | CoreControlMessage): void {
    throw new Error("not implemented: A0.3");
  }
}

registerProcessor("myco-audio-core", CoreProcessor);
