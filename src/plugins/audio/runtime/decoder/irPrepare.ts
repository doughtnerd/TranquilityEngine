// Zone impulse-response preparation in the decoder worker (ADR 0162 C9; contract K0 stub, filled by C2b).
//
// For `prepareIr` the worker fetches the IR asset and keeps its encoded bytes per kernel id; for `generateIr` it
// generates a preset (R10). Either way it prepares the kernel with the decoder's `myco_ir_prepare` / `myco_ir_generate`
// exports (C2a) at the context rate, sends it to the worklet as CLIP_BEGIN/CLIP_CHUNK format 3 over the worklet port
// (main never holds kernels or time-domain IRs: the only thing that goes to main is `irPrepared` / `irFailed`), and
// posts the reply. A repeat `prepareIr` for a kernel id whose asset is the one kept (a rate change, a hard rebuild: main's
// `reprepareAll`) prepares from the kept bytes without fetching again. `releaseIr` drops the kept bytes and unloads the
// kernel's clip in the worklet. Never throws.
import { CLIP_BEGIN_FIXED_END, CLIP_CHUNK_FIXED_END, CLIP_UNLOAD_FIXED_END, ClipFormat, Kind, writeClipBegin, writeClipChunk, writeClipUnload, writeEnvelope } from "../wire.generated";
import { hintFromName, type DecoderReply, type GenerateIrMessage, type IrRequest, type PrepareIrMessage, type StreamPortLike } from "./protocol";
import { DecoderError, type DecoderWasm, type PreparedIr } from "./wasm";

export interface IrPreparerOptions {
  post(reply: DecoderReply, transfer?: Transferable[]): void;
  /** The handler's wasm load (null before `init`). */
  wasm(): Promise<DecoderWasm> | null;
  /** Fetches an IR asset's bytes (the worker passes `fetch`). */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

/** Bytes of kernel per CLIP_CHUNK message: the worklet applies up to this much per quantum (`CLIP_BYTES_PER_QUANTUM`). */
export const IR_CHUNK_BYTES = 256 * 1024;

/** The encoded file kept for re-preparation. */
interface Kept {
  readonly assetUrl: string;
  readonly bytes: ArrayBuffer;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class IrPreparer {
  private port: StreamPortLike | null = null;
  private readonly kept = new Map<number, Kept>();
  /** The newest request per kernel id; an older one that finishes later is dropped, and a release removes it. */
  private readonly latest = new Map<number, number>();
  /** Kernel ids whose CLIP_BEGIN went to the current worklet (so a new BEGIN or a release unloads first). */
  private readonly sent = new Set<number>();
  private seq = 0;

  constructor(private readonly options: IrPreparerOptions) {}

  /** The worklet's end of the channel (a later one replaces it after a hard rebuild; the new worklet holds no kernels). */
  connectWorklet(port: StreamPortLike): void {
    this.port = port;
    this.sent.clear();
  }

  async handle(request: IrRequest): Promise<void> {
    try {
      switch (request.type) {
        case "prepareIr":
        case "generateIr":
          return await this.prepare(request);
        case "releaseIr":
          this.latest.delete(request.kernelId);
          this.kept.delete(request.kernelId);
          if (this.sent.delete(request.kernelId)) this.postUnload(request.kernelId);
          return;
      }
    } catch (e) {
      // Never thrown to the handler; a last resort for what the paths below don't catch.
      if (request.type !== "releaseIr") this.fail(request, e);
    }
  }

  private fail(request: PrepareIrMessage | GenerateIrMessage, e: unknown): void {
    this.options.post({ type: "irFailed", token: request.token, kernelId: request.kernelId, code: e instanceof DecoderError ? e.code : 0, message: describe(e) });
  }

  private async prepare(request: PrepareIrMessage | GenerateIrMessage): Promise<void> {
    const { kernelId, token } = request;
    this.latest.set(kernelId, token);
    const superseded = () => this.latest.get(kernelId) !== token;
    const loading = this.options.wasm();
    if (!loading) return this.fail(request, new DecoderError("audio decoder: not initialised"));
    let decoder: DecoderWasm;
    try {
      decoder = await loading;
    } catch (e) {
      return this.fail(request, e);
    }
    let bytes: ArrayBuffer | null = null;
    if (request.type === "prepareIr") {
      const kept = this.kept.get(kernelId);
      if (kept && kept.assetUrl === request.assetUrl) bytes = kept.bytes;
      else {
        if (!this.options.fetchBytes) return this.fail(request, new DecoderError("audio decoder: no way to fetch the impulse response"));
        try {
          bytes = await this.options.fetchBytes(request.assetUrl);
        } catch (e) {
          if (!superseded()) this.fail(request, new DecoderError(`couldn't load "${request.assetUrl}" (${describe(e)})`));
          return;
        }
        if (superseded()) return; // released or asked again while fetching
        this.kept.set(kernelId, { assetUrl: request.assetUrl, bytes });
      }
    } else if (superseded()) return;
    if (!this.port) return this.fail(request, new DecoderError("audio decoder: no worklet port for zone impulse responses"));
    const started = now();
    let prepared: PreparedIr;
    try {
      prepared =
        request.type === "prepareIr"
          ? decoder.prepareIr(new Uint8Array(bytes!), hintFromName(request.assetUrl.split(/[?#]/)[0]), request.contextRate, request.maxFrames)
          : decoder.generateIr(request.preset, request.contextRate, request.maxFrames);
    } catch (e) {
      // A trap (not a DecoderError) leaves the instance's memory in an unknown state: start a fresh one.
      if (!(e instanceof DecoderError)) decoder.reset();
      return this.fail(request, e);
    }
    if (prepared.kernel.length === 0 || prepared.kernel.length % 4 !== 0) return this.fail(request, new DecoderError("audio decoder: the prepared kernel has a bad size"));
    this.send(kernelId, prepared.kernel, request.contextRate);
    this.options.post({ type: "irPrepared", token, kernelId, frames: prepared.frames, truncated: prepared.truncated, prepareMs: now() - started });
  }

  /** CLIP_BEGIN format 3 then the chunks, each message one transferred buffer. */
  private send(kernelId: number, kernel: Uint8Array, sampleRate: number): void {
    const port = this.port!;
    if (this.sent.has(kernelId)) this.postUnload(kernelId);
    this.sent.add(kernelId);
    const words = kernel.length / 4;
    const begin = new ArrayBuffer(CLIP_BEGIN_FIXED_END);
    const bv = new DataView(begin);
    writeEnvelope(bv, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++ >>> 0, bodyBytes: CLIP_BEGIN_FIXED_END - 16 });
    writeClipBegin(bv, 0, { clipId: kernelId, frames: words, channels: 1, sampleRate, format: ClipFormat.ZoneKernel });
    port.postMessage(begin, [begin]);
    for (let at = 0; at < kernel.length; at += IR_CHUNK_BYTES) {
      const n = Math.min(IR_CHUNK_BYTES, kernel.length - at);
      const total = CLIP_CHUNK_FIXED_END + n;
      const buffer = new ArrayBuffer(total);
      const view = new DataView(buffer);
      writeEnvelope(view, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++ >>> 0, bodyBytes: total - 16 });
      writeClipChunk(view, 0, { clipId: kernelId, frameOffset: at / 4, frames: n / 4, reserved: 0 });
      new Uint8Array(buffer, CLIP_CHUNK_FIXED_END, n).set(kernel.subarray(at, at + n));
      port.postMessage(buffer, [buffer]);
    }
  }

  private postUnload(kernelId: number): void {
    if (!this.port) return;
    const buffer = new ArrayBuffer(CLIP_UNLOAD_FIXED_END);
    const view = new DataView(buffer);
    writeEnvelope(view, 0, { kind: Kind.CLIP_UNLOAD, seq: this.seq++ >>> 0, bodyBytes: CLIP_UNLOAD_FIXED_END - 16 });
    writeClipUnload(view, 0, { clipId: kernelId });
    this.port.postMessage(buffer, [buffer]);
  }
}
