// The audio topic's `mix.op` command, build side (plan task A3; schema in `schema.ts`): the Studio's Mixer edits a
// connected build's live mix. The session calls the topic's `command` at the build's next frame start (ADR 0376), and
// the topic (`topic.ts`, A1) dispatches `mix.op` here: the op is read back from its byte form (`readMixOpCommand`) and
// applied through the live mixer (`mixer.apply`, ADR 0175). A command that doesn't read, or an op the mixer refuses
// (`ok: false` without a reason), throws with the message, which the session sends the tool as an error; an op kept for
// the next Play or a later slot (`ok: false` or `true` with a reason) is applied as the mixer says and doesn't throw.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";

/** What `mix.op` applies ops to (the live `mixer`; a stand-in in tests). */
export interface MixOpTarget {
  apply(op: MixOp): ApplyResult;
}

/** Applies one `mix.op` command's params to `target`; returns the mixer's answer, or throws with why it was refused. */
export function applyMixOpCommand(params: unknown, target: MixOpTarget): ApplyResult {
  void params;
  void target;
  throw new Error("A3: not implemented");
}
