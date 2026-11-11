// Zone impulse-response preparation, main's side (ADR 0162; architecture §2.2; C9; K0's `ZoneIrService`). The zone
// manager (`zones.ts`) asks for a kernel from an IR asset or a built-in preset at the context rate; the decoder worker
// decodes or generates it, builds its spectra and sends them straight to the worklet as format-3 clip chunks under the
// kernel's id (main never holds kernels or time-domain IRs), then answers `irPrepared` or `irFailed` here.
//
// C2b fills this file over the decoder worker (`decoder/protocol.ts` `prepareIr` / `generateIr`, `decoder/irPrepare.ts`).
// K4 (the skeleton): a service that refuses every request (`onFailed`, on a microtask), so a zone that asks reads
// "IR failed" and stays dry. No zone asks before C5.
import type { ZoneIrService } from "../backend";

/** @internal What C2b's service is built on; the core backend passes what it has. */
export interface ZoneIrDeps {
  /** The context's rate now (kernels are prepared at it). */
  readonly sampleRate?: number;
}

/** @internal `irFailed` code for the skeleton's refusal. */
export const ZONE_IR_NOT_AVAILABLE = 1;

/** @internal The zone IR service the core backend constructs. K4: refuses every request. */
export function createZoneIrService(deps: ZoneIrDeps = {}): ZoneIrService {
  void deps;
  let nextToken = 1;
  const service: ZoneIrService = {
    onPrepared: null,
    onFailed: null,
    prepare(request) {
      const token = nextToken++;
      queueMicrotask(() => service.onFailed?.({ token, kernelId: request.kernelId, code: ZONE_IR_NOT_AVAILABLE, message: "zone impulse responses can't be prepared yet" }));
      return token;
    },
    release() {},
    reprepareAll() {},
    dispose() {},
  };
  return service;
}
