// The graph editor's debugger strip (ADR 0373 "Live debugger"; T52), shown while the game runs: which Animator is
// debugged (the Hierarchy's live selection by default, or one picked here), the status, and the recorder's scrubber.
import { RecorderBar } from "./RecorderBar";
import type { LiveDebug } from "./useLiveDebug";

export interface DebugBarProps {
  debug: Pick<LiveDebug, "status" | "targets" | "target" | "chosen" | "choose" | "recording" | "scrub" | "setScrub" | "poseShown"> & { readonly paused: boolean };
}

const FOLLOW = "";

export function DebugBar(props: DebugBarProps) {
  const d = props.debug;
  return (
    <div class="dbg-bar" role="region" aria-label="Live debugger">
      <span class="dbg-dot" aria-hidden="true" />
      <label class="dbg-target">
        <span class="dbg-muted">Animator</span>
        <select aria-label="Debugged Animator" value={d.chosen ?? FOLLOW} disabled={d.targets.length === 0} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; d.choose(v === FOLLOW ? null : v); }}>
          <option value={FOLLOW}>Follow selection</option>
          {d.targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <span class="dbg-status" role="status">{d.status}</span>
      {d.target && d.recording && (
        <RecorderBar frames={d.recording.frames} isKeyframe={(i) => d.recording!.isKeyframe(i)} scrub={d.scrub} onScrub={d.setScrub}
          seconds={d.recording.seconds} onSeconds={(s) => { d.recording!.seconds = s; }} paused={d.paused} poseShown={d.poseShown} />
      )}
    </div>
  );
}
