// The AudioWorklet processor (ADR 0157; architecture §1 "Processor shell"). Loaded with `audioWorklet.addModule`
// as its own bundle (`loader.ts`), never imported by main-thread code: importing it would call
// `registerProcessor`, which only exists in AudioWorkletGlobalScope. All logic is in `coreDriver.ts`; this file
// binds it to the worklet's globals (`sampleRate`, `currentFrame`, `Date.now`) and its port.
//
// A trap inside the core is caught in `CoreDriver.process` (silence, one `trap` event, the driver dead); anything
// thrown outside that catch reaches the node as `processorerror`, which the host treats the same way (A3.4a). When the
// host replaces the node (the hard rebuild) it posts `retire`: `process` then returns false so the node can be collected.
import { CoreDriver, instantiateCore, PROCESSOR_NAME, type CoreControlMessage, type CoreProcessorOptions, type CoreShellEvent } from "./coreDriver";

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
  /** Set by `retire` (A3.4a): this node has been replaced, so it stops rendering for good. */
  private retired = false;

  constructor(options: { processorOptions: CoreProcessorOptions }) {
    super(options);
    this.port.onmessage = (event: MessageEvent<ArrayBuffer | CoreControlMessage>) => this.onMessage(event.data);
    try {
      const { wasm, preset } = options.processorOptions;
      const core = instantiateCore(wasm, preset, sampleRate);
      this.driver = new CoreDriver(core, (message, transfer) => this.port.postMessage(message, transfer ?? []), Date.now());
    } catch (error) {
      const event: CoreShellEvent = { type: "error", message: error instanceof Error ? error.message : String(error) };
      this.port.postMessage(event);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.retired) return false;
    const driver = this.driver;
    const out = outputs[0];
    if (!driver || !out) return true;
    driver.process(currentFrame, Date.now());
    out[0]?.set(driver.left);
    out[1]?.set(driver.right);
    return true;
  }

  private onMessage(data: ArrayBuffer | CoreControlMessage): void {
    if (!(data instanceof ArrayBuffer) && data && data.type === "retire") {
      this.retired = true;
      this.port.onmessage = null;
      return;
    }
    const driver = this.driver;
    if (!driver) return;
    if (data instanceof ArrayBuffer) driver.onMessage(data, currentFrame, Date.now());
    else if (data && data.type === "debugTone") driver.onControl(data);
  }
}

registerProcessor(PROCESSOR_NAME, CoreProcessor);
