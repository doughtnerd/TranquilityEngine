// The Plays now and Voices panels' views (the prototype's two tabs; spec 4.2.8). Plays now: before a trigger, "Next
// trigger · current parameters" with the resolution as dimmed cards (a Queue's pick of N, a Switch label's entry, a
// Blend's weighted entries); while playing, one card per voice (badge, name, gain and level, a level bar, the path from
// the open playlist down to it), and a Switch's label change as a transition card. Voices: every voice the audition
// played, newest first: when it started, a status chip (icon and colour, never colour only), its name, gain and
// instance, a progress bar with the time left (or "until stopped"), "Rule ›" for a trigger the playback rules refused,
// and its path. Read only; the data comes from the runtime's public `Audio.debug()` (`voiceLog.ts`).
import type { PlaylistType } from "../../../engine/audio/playlist/types";
import { Icon, type IconName } from "../../components/Icon";
import { TypeBadge } from "../../components/TypeBadge";
import { dbText, secondsText } from "./entryRowModel";
import type { PreviewCard } from "./liveModel";
import { sampleTitle } from "./playlistPaths";
import { aliveAt, REFUSAL_TEXT, type LogRow, type VoiceStatus } from "./voiceLog";

export interface NowVoice {
  readonly id: number;
  readonly instance: number;
  readonly clip: string;
  readonly status: VoiceStatus;
  /** Linear gain, 0..1. */
  readonly gain: number;
  readonly gainDb: number;
  /** From the open playlist down to it. */
  readonly path: readonly string[];
}

/** A Switch label change heard while auditioning. */
export interface TransitionNote {
  readonly playlist: string;
  readonly from: string;
  readonly to: string;
  /** "on the next bar · crossfade 16 beats". */
  readonly how: string;
}

export interface PlaysNowProps {
  readonly now: readonly NowVoice[];
  /** The next trigger's resolution at the test values. */
  readonly preview: readonly PreviewCard[];
  /** Why there's nothing to preview: no playlist open, no entries. */
  readonly empty?: string;
  readonly transition?: TransitionNote | null;
  /** The view is frozen (Pause). */
  readonly paused?: boolean;
  /** Why nothing can play (the runtime isn't running), if so. */
  readonly blocked?: string;
}

const db = (v: number) => (v <= -119 ? "−∞ dB" : dbText(v));

export function PlaysNowView(props: PlaysNowProps) {
  return (
    <section class="pl-plays" aria-label="Plays now">
      {props.blocked && <p class="pl-note">{props.blocked}</p>}
      {props.transition && (
        <div class="pl-trb" role="status">
          <b>{props.transition.playlist}: {props.transition.from} → {props.transition.to}</b>
          <span class="pl-faint">{props.transition.how}</span>
        </div>
      )}
      {props.now.length > 0 ? (
        <>
          {props.paused && <p class="pl-u">Paused: what played at that moment</p>}
          <ul class="pl-cards">
            {props.now.map((v) => (
              <li key={v.id} class="pl-card">
                <div class="pl-card-head">
                  <span class="pl-note-glyph" aria-hidden="true">♪</span>
                  <b class="pl-nm" title={v.clip}>{sampleTitle(v.clip)}</b>
                  <span class="pl-u">{db(v.gainDb)} · {Math.round(v.gain * 100)}%</span>
                </div>
                <span class="pl-wb a2"><em style={{ width: `${Math.min(100, v.gain * 100)}%` }} /></span>
                <span class="pl-path">{v.path.join(" › ")}{v.status !== "playing" ? ` · ${STATUS[v.status].text}` : ""}</span>
              </li>
            ))}
          </ul>
        </>
      ) : props.empty ? (
        <p class="pl-u">{props.empty}</p>
      ) : props.preview.length === 0 ? (
        <>
          {/* "Nothing playing" stays the panel's word for silence (the e2e reads it). */}
          <p class="pl-u">Nothing playing · nothing plays with these values</p>
        </>
      ) : (
        <>
          <p class="pl-u">Nothing playing · next trigger · current parameters</p>
          <ul class="pl-cards preview">
            {props.preview.map((c, k) => (
              <li key={k} class="pl-card">
                <div class="pl-card-head">
                  {c.kind === "sample" ? <span class="pl-note-glyph" aria-hidden="true">♪</span> : <TypeBadge playlist={c.kind as PlaylistType} axes={c.axes} />}
                  <b class="pl-nm">{c.name}</b>
                  <span class="pl-u">{db(c.gainDb)} · {Math.round(c.weight * 100)}%</span>
                </div>
                <span class="pl-wb a2"><em style={{ width: `${Math.round(c.weight * 100)}%` }} /></span>
                <span class="pl-path">{c.path.join(" › ")}{c.kind === "sequence" ? " · starts on trigger" : ""}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const STATUS: Record<VoiceStatus, { text: string; cls: string; icon: IconName }> = {
  playing: { text: "Playing", cls: "ply", icon: "play" },
  virtual: { text: "Virtual", cls: "fad", icon: "mute" },
  stolen: { text: "Stolen", cls: "stl", icon: "close" },
  waiting: { text: "Scheduled", cls: "sch", icon: "history" },
  muted: { text: "Bus muted", cls: "fad", icon: "mute" },
  finished: { text: "Ended", cls: "", icon: "check" },
  refused: { text: "Rejected", cls: "rej", icon: "warning" },
};

export interface VoicesLogProps {
  readonly log: readonly LogRow[];
  readonly cursor: number | null;
  /** The audio clock now (the log's times are shown from its first start). */
  readonly time: number;
  /** A sample's length (a playing voice's progress and time left), null when unknown. */
  lengthOf?(clip: string): number | null;
  /** The path from the open playlist down to a voice's sample. */
  pathOf?(clip: string): readonly string[];
  onClear(): void;
  onSeek(t: number): void;
  /** "Rule ›": show Playback, where the refusing rule is. */
  onRule?(): void;
}

export function VoicesLogView(props: VoicesLogProps) {
  const start = props.log[0]?.start ?? 0;
  const alive = props.cursor !== null ? new Set(aliveAt(props.log, props.cursor).map((r) => r.key)) : null;
  const playing = props.log.filter((r) => r.kind === "voice" && r.end === null).length;
  const triggers = new Set(props.log.map((r) => r.instance || r.key)).size;
  const rows = [...props.log].reverse();
  return (
    <section class="pl-vlog" aria-label="Voice log">
      {props.log.length === 0 ? (
        <p class="pl-u">Trigger to start capturing. Every voice is listed here, newest first, with when it started, its status and gain.</p>
      ) : (
        <>
          <div class="pl-vsum">
            <span class="pl-u">{playing} playing · {triggers} {triggers === 1 ? "trigger" : "triggers"}</span>
            <button type="button" class="pl-small" onClick={props.onClear}>Clear</button>
          </div>
          <ul class="pl-vrows" aria-label="Voices">
            {rows.map((r) => {
              const st = STATUS[r.status];
              const len = r.kind === "voice" ? (props.lengthOf?.(r.clip) ?? null) : null;
              const ran = (r.end ?? props.time) - r.start;
              const progress = r.end !== null ? 1 : len ? Math.min(1, ran / len) : null;
              const left = r.kind === "refused" ? "" : r.end !== null ? `${secondsText(Math.max(0, r.end - r.start))}` : len ? `${secondsText(Math.max(0, len - ran))} left` : "until stopped";
              return (
                <li key={r.key} class={`pl-vrow${r.end !== null ? " ended" : ""}${alive?.has(r.key) ? " alive" : ""}`} onClick={() => props.onSeek(r.start)}>
                  <div class="pl-vrow-head">
                    <button type="button" class="pl-link pl-vt" title="Move the voice log cursor here" onClick={(e) => (e.stopPropagation(), props.onSeek(r.start))}>{(r.start - start).toFixed(2)}</button>
                    <span class={`pl-vst ${st.cls}`}><Icon name={st.icon} size={9} /> {st.text}</span>
                    <b class="pl-nm" title={r.clip}>{r.kind === "refused" ? `Not played: ${REFUSAL_TEXT[r.clip] ?? r.clip}` : sampleTitle(r.clip)}</b>
                    {r.kind !== "refused" && <span class="pl-u">{db(r.gainDb)}</span>}
                    {r.instance > 0 && <span class="pl-u" title="Instance">#{r.instance}</span>}
                  </div>
                  {r.kind === "voice" && (
                    <div class="pl-vrow-bar">
                      <span class="pl-wb a2"><em style={{ width: `${(progress ?? 0) * 100}%` }} /></span>
                      <span class="pl-u">{left}</span>
                    </div>
                  )}
                  {r.kind === "refused" && props.onRule && (
                    <div class="pl-vrow-bar"><span class="pl-faint">A playback rule refused this trigger</span><button type="button" class="pl-vlink" onClick={(e) => (e.stopPropagation(), props.onRule!())}>Rule ›</button></div>
                  )}
                  {r.kind === "voice" && props.pathOf && <span class="pl-path">{props.pathOf(r.clip).join(" › ")}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
