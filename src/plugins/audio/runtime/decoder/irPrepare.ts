// Zone impulse-response preparation in the decoder worker (ADR 0162 C9; contract K0 stub, filled by C2b).
//
// For `prepareIr` the worker fetches the IR asset and keeps its encoded bytes; for `generateIr` it generates a preset
// (R10). Either way it prepares the kernel with the decoder's `myco_ir_prepare` / `myco_ir_generate` exports (C2a), sends
// it to the worklet as CLIP_BEGIN/CLIP_CHUNK format 3 over the worklet port (main never holds kernels or time-domain IRs),
// and posts `irPrepared` or `irFailed` to main. `releaseIr` drops the kept bytes. Never throws.
//
// Until C2b fills it, every request fails with a clear message, so a zone reads "IR failed" rather than hanging.
import type { DecoderReply, IrRequest, StreamPortLike } from "./protocol";
import type { DecoderWasm } from "./wasm";

export interface IrPreparerOptions {
  post(reply: DecoderReply, transfer?: Transferable[]): void;
  /** The handler's wasm load (null before `init`). */
  wasm(): Promise<DecoderWasm> | null;
  /** Fetches an IR asset's bytes (the worker passes `fetch`). */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

export class IrPreparer {
  private port: StreamPortLike | null = null;

  constructor(private readonly options: IrPreparerOptions) {}

  /** The worklet's end of the channel (a later one replaces it after a hard rebuild). */
  connectWorklet(port: StreamPortLike): void {
    this.port = port;
  }

  async handle(request: IrRequest): Promise<void> {
    switch (request.type) {
      case "prepareIr":
      case "generateIr":
        // C2b: prepare and send the kernel. Stub: refuse, so callers see the failure path.
        this.options.post({ type: "irFailed", token: request.token, kernelId: request.kernelId, code: 0, message: "zone impulse responses aren't available yet" });
        return;
      case "releaseIr":
        return;
    }
  }
}
