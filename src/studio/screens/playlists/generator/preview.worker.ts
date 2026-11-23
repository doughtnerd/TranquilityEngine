// The Generator editor's preview worker (ADR 0360 §9): renders the patch through G5's offline render in the offline
// module (`previewRender.ts`; the wasm loads on the first request) off the page and replies with the waveform's base
// peak level and the envelope, or why it couldn't (`previewClient.ts` is the client).
import type { PreviewReplyMessage, PreviewRequestMessage } from "./previewClient";
import { previewBase, renderGeneratorPreview } from "./previewRender";

const scope = self as unknown as { onmessage: ((ev: MessageEvent<PreviewRequestMessage>) => void) | null; postMessage(reply: PreviewReplyMessage, transfer?: Transferable[]): void };

scope.onmessage = (ev) => {
  const { id, body, maxSeconds } = ev.data;
  renderGeneratorPreview(body, maxSeconds).then(
    (r) => {
      const base = previewBase(r.samples);
      scope.postMessage({ id, base, frames: r.samples.length, rate: r.rate, seconds: r.seconds, keyOff: r.keyOff, endless: r.endless, envelope: r.envelope }, [base.data.buffer]);
    },
    (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
