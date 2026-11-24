// The audio topic's `mix.op` command, build side (plan task A3; schema in `schema.ts`): the Studio's Mixer edits a
// connected build's live mix. The session calls the topic's `command` at the build's next frame start (ADR 0376), and
// the topic (`topic.ts`, A1) dispatches `mix.op` here: the op is read back from its byte form (`readMixOpCommand`, which
// maps the command's own name and bus tables to this build's strings, since interned ids differ between builds) and
// applied through the live mixer (`mixer.apply`, ADR 0175), the path live edits take, so a running capture records it
// as a MIXOP record. A command that doesn't read, an op the mixer refuses (an unknown bus or parameter, a value out of
// range), and an op it can't apply now (`ok: false`: the edit would wait for the next Play, or there is no live
// backend) all throw with the message, which the session sends the tool as an error. `ok: true` (including one that
// applies later this session, `waitsForSlot`) returns the mixer's answer.
//
// Origin: the op is applied inside `withMixOpOrigin("debugLink", ...)`, so a running capture's MIXOP record says a tool
// sent it over the link (`MixOpOrigin.debugLink`, 5), not the editor.
import { reasonMessage } from "../../../../engine/audio/busCapability";
import { isProjectOp, opRefusal, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { withMixOpOrigin } from "../capture/mixOpOrigin";
import { readMixOpCommand } from "./schema";

/** What `mix.op` applies ops to: the live `mixer` (its `audioSettings` give the refusal's reason); a stand-in in tests. */
export interface MixOpTarget {
  apply(op: MixOp): ApplyResult;
  /** The settings `opRefusal` checks a refused op against, for the message; without them the message is generic. */
  readonly audioSettings?: AudioSettings;
}

/** Applies one `mix.op` command's params to `target`; returns the mixer's answer, or throws with why it was refused. */
export function applyMixOpCommand(params: unknown, target: MixOpTarget): ApplyResult {
  const read = readMixOpCommand(params);
  if ("refused" in read) throw new Error(read.refused);
  const { op } = read;
  const result = withMixOpOrigin("debugLink", () => target.apply(op));
  if (result.ok) return result;
  if (result.reason !== undefined) throw new Error(`mix.op ${op.op} not applied: ${reasonMessage(result.reason)}`);
  const why = target.audioSettings && !isProjectOp(op) ? opRefusal(target.audioSettings, op) : null;
  throw new Error(`mix.op ${op.op} refused: ${why ?? "the mixer can't apply it"}`);
}
