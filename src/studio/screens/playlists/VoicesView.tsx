// The Plays now / Voices panel's view (the prototype's Plays now and Voices, PL:1239–1325): what the audition plays
// now, voice by voice (gain bar, sample path, bus, instance), and the log of every voice it played (start, status,
// gain, instance, length) with refused triggers and why. With the scrub cursor set, the voices sounding then are
// marked. Read only; the data comes from the runtime's public `Audio.debug()` (`voiceLog.ts`).
import { EmptyState } from "../../../editor/ui/EmptyState";
import { aliveAt, REFUSAL_TEXT, STATUS_TEXT, type LogRow, type VoiceStatus } from "./voiceLog";
import { sampleTitle } from "./playlistPaths";

export interface VoicesViewProps {
  readonly now: readonly { readonly id: number; readonly instance: number; readonly clip: string; readonly bus: string; readonly status: VoiceStatus; readonly gain: number; readonly gainDb: number }[];
  readonly log: readonly LogRow[];
  readonly cursor: number | null;
  /** The audio clock now (the log's times are shown from its first start). */
  readonly time: number;
  /** Why nothing can play (the runtime isn't running), if so. */
  readonly blocked?: string;
  onClear(): void;
  onSeek(t: number): void;
}

const db = (v: number) => (v <= -119 ? "−∞" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`);

export function VoicesView(props: VoicesViewProps) {
  const start = props.log[0]?.start ?? 0;
  const alive = props.cursor !== null ? new Set(aliveAt(props.log, props.cursor).map((r) => r.key)) : null;
  return (
    <div class="pl-voices">
      <section class="pl-voices-now" aria-label="Plays now">
        <h3 class="pl-subhead">Plays now</h3>
        {props.blocked ? (
          <p class="pl-note">{props.blocked}</p>
        ) : props.now.length === 0 ? (
          <p class="pl-note">Nothing playing. Trigger (Space) plays the open playlist with the test parameters.</p>
        ) : (
          <ul class="pl-now-list">
            {props.now.map((v) => (
              <li key={v.id} class="pl-now">
                <span class="pl-gain" style={{ "--g": String(Math.min(1, v.gain)) }} title={`${db(v.gainDb)} dB`} />
                <span class="pl-now-name" title={v.clip}>{sampleTitle(v.clip)}</span>
                <span class="pl-row-meta">{v.bus} · #{v.instance} · {STATUS_TEXT[v.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="pl-voices-log" aria-label="Voice log">
        <h3 class="pl-subhead">
          Voices
          <button type="button" class="pl-small" disabled={props.log.length === 0} onClick={props.onClear}>Clear</button>
        </h3>
        {props.log.length === 0 ? (
          <EmptyState compact title="No voices yet" body="Each voice an audition plays is listed here: when it started, how it ended, its level and its instance." />
        ) : (
          <div class="pl-table pl-log" role="table" aria-label="Voices">
            <div class="pl-tr pl-th" role="row"><span role="columnheader">Start</span><span role="columnheader">Voice</span><span role="columnheader">Status</span><span role="columnheader">Gain</span><span role="columnheader" aria-label="Instance" title="Instance">#</span><span role="columnheader">Length</span></div>
            {props.log.map((r) => (
              <div key={r.key} role="row" class={`pl-tr pl-log-${r.status}${alive?.has(r.key) ? " pl-alive" : ""}`} onClick={() => props.onSeek(r.start)}>
                <span role="cell"><button type="button" class="pl-link pl-num-text" title="Move the voice log cursor here" onClick={(e) => (e.stopPropagation(), props.onSeek(r.start))}>{(r.start - start).toFixed(2)} s</button></span>
                <span role="cell" class="pl-log-voice" title={r.clip}>{r.kind === "refused" ? `Trigger not played: ${REFUSAL_TEXT[r.clip] ?? r.clip}` : sampleTitle(r.clip)}</span>
                <span role="cell">{STATUS_TEXT[r.status]}</span>
                <span role="cell" class="pl-num-text">{r.kind === "refused" ? "" : db(r.gainDb)}</span>
                <span role="cell" class="pl-num-text">{r.instance || ""}</span>
                <span role="cell" class="pl-num-text">{r.kind === "refused" ? "" : `${((r.end ?? props.time) - r.start).toFixed(2)} s`}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
