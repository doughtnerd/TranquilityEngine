// The Samples screen's detection worker (ADR 0342): runs the tempo and root note analysers off the page, one request
// at a time, and replies with what they found (`sampleDetect.ts` is the client).
import { detectSample } from "../../../engine/audio/sample/detect/detect";
import type { DetectReply, DetectRequest } from "./sampleDetect";

const scope = self as unknown as { onmessage: ((ev: MessageEvent<DetectRequest>) => void) | null; postMessage(reply: DetectReply): void };

scope.onmessage = (ev) => {
  const { id, pcm, channels, rate, what } = ev.data;
  try {
    scope.postMessage({ id, result: detectSample({ pcm, channels, rate }, what) });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
