// The Samples screen's render worker (ADR 0342 "rendered offline in a worker"): runs the offline sample render
// (`renderSample`, the Rust kernels in `myco_audio_offline.wasm`) off the page and replies with the rendered PCM
// (`sampleRenderClient.ts` is the client).
import { renderSample } from "../../../engine/audio/sample/sampleRender";
import type { RenderReply, RenderRequest } from "./sampleRenderClient";

const scope = self as unknown as { onmessage: ((ev: MessageEvent<RenderRequest>) => void) | null; postMessage(reply: RenderReply, transfer?: Transferable[]): void };

scope.onmessage = async (ev) => {
  const { id, pcm, channels, rate, edits } = ev.data;
  try {
    const out = await renderSample({ pcm, channels, rate }, edits);
    scope.postMessage({ id, pcm: out.pcm, channels: out.channels, rate: out.rate, frames: out.frames, warnings: [...out.warnings] }, [out.pcm.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
