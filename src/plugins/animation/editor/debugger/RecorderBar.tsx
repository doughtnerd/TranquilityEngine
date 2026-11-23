// The recorder's scrubber (ADR 0373 "A recorder keeps the last N seconds (default 10) … Scrub it to see the pose and
// graph at any frame"; T52): a slider over the kept frames with keyframe ticks, the scrubbed frame's time and inputs,
// Live to follow the game again, and how many seconds are kept. While the game is paused the scrubbed frame's pose is
// re-evaluated and shown on the character; while it runs only the graph is.
import type { AnimatorDebugFrame, DebugInput } from "../../runtime/features/debug/frame";

/** The lengths the recorder can keep, in seconds. */
export const RECORD_SECONDS = [5, 10, 20, 30] as const;

export interface RecorderBarProps {
  frames: readonly AnimatorDebugFrame[];
  isKeyframe(index: number): boolean;
  /** The scrubbed frame (null: live). */
  scrub: number | null;
  onScrub(index: number | null): void;
  seconds: number;
  onSeconds(seconds: number): void;
  paused: boolean;
  /** The scrubbed frame's pose shows on the character. */
  poseShown: boolean;
}

/** An input as a short label. */
export function inputText(i: DebugInput): string {
  switch (i.kind) {
    case "param":
      return `${i.name} = ${Array.isArray(i.value) ? `(${i.value.map((x) => x.toFixed(2)).join(", ")})` : typeof i.value === "number" ? (Number.isInteger(i.value) ? i.value : i.value.toFixed(3)) : String(i.value)}`;
    case "request":
      return `request ${i.name} (${i.lifetime.toFixed(2)} s)`;
    case "travel":
      return `travel ${i.machine} → ${i.state}`;
    case "jump":
      return `jump ${i.machine} → ${i.state}`;
    case "slotPlay":
      return `play ${i.clip} in ${i.slot}`;
    case "slotStop":
      return `stop ${i.slot}`;
    case "link":
      return `link ${i.linked}`;
    case "layerWeight":
      return `${i.layer} weight ${i.weight.toFixed(2)}`;
    case "ik":
      return "IK targets";
    case "other":
      return i.what;
  }
}

export function RecorderBar(props: RecorderBarProps) {
  const { frames } = props;
  const last = frames.length - 1;
  const at = props.scrub === null ? last : frames.findIndex((f) => f.index === props.scrub);
  const frame = at >= 0 ? frames[at] : undefined;
  const newest = frames[last];
  const ago = frame && newest ? newest.time - frame.time : 0;
  return (
    <div class="dbg-recorder" role="group" aria-label="Recorder">
      <button class={props.scrub === null ? "dbg-live active" : "dbg-live"} aria-pressed={props.scrub === null} onClick={() => props.onScrub(null)} title="Follow the game">Live</button>
      <span class="dbg-scrub">
        <input type="range" min={0} max={Math.max(0, last)} value={Math.max(0, at)} disabled={frames.length < 2} aria-label="Recorded frame"
          aria-valuetext={props.scrub === null ? "live" : `${ago.toFixed(2)} seconds ago`}
          onInput={(e) => { const i = Number((e.currentTarget as HTMLInputElement).value); const f = frames[i]; if (f) props.onScrub(i === last ? null : f.index); }} />
        <span class="dbg-ticks" aria-hidden="true">
          {last > 0 && frames.map((f, i) => (props.isKeyframe(f.index) ? <span key={f.index} class="dbg-tick" style={{ left: `${(i / last) * 100}%` }} /> : null))}
        </span>
      </span>
      <output class="dbg-when" aria-label="Scrubbed time">{props.scrub === null ? "live" : `−${ago.toFixed(2)} s`}</output>
      <label class="dbg-keep" title="Seconds the recorder keeps">
        <span>Keep</span>
        <select aria-label="Seconds kept" value={String(props.seconds)} onChange={(e) => props.onSeconds(Number((e.currentTarget as HTMLSelectElement).value))}>
          {RECORD_SECONDS.map((s) => <option key={s} value={String(s)}>{s} s</option>)}
        </select>
      </label>
      {props.scrub !== null && (
        <span class="dbg-muted dbg-hint" role="status">
          {props.poseShown ? "Showing this frame's pose" : props.paused ? "This frame's pose can't be re-evaluated" : "Pause to see this frame's pose"}
          {frame && frame.inputs.length > 0 && ` · ${frame.inputs.map(inputText).join(", ")}`}
        </span>
      )}
    </div>
  );
}
