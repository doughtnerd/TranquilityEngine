// The editor's clip compile worker (ADR 0370: "Pose-database baking and clip compression run in a Web Worker with
// their own instance, so the editor stays responsive"; T19). It loads the editor's compile module (`anim-editor-wasm`)
// once and compresses one clip per message.
//
// Messages in: `{ id, raw, skeleton, record }` (`ClipCompileRunner`'s job; the buffers are transferred). Out:
// `{ id, outcome }` (`CompileOutcome`; the compiled bytes transferred).
import { loadAnimationCompiler, type CompileOutcome } from "./compiler";

type Inbound = { id: number; raw: Uint8Array; skeleton: Uint8Array; record: Float32Array };

const scope = self as unknown as { onmessage: ((e: MessageEvent<Inbound>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

scope.onmessage = async (e) => {
  const { id, raw, skeleton, record } = e.data;
  let outcome: CompileOutcome;
  try {
    outcome = (await loadAnimationCompiler()).compressClip(raw, skeleton, record);
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage({ id, outcome }, outcome.ok ? [outcome.bytes.buffer as ArrayBuffer] : []);
};
