// The Profiler's side panels as views over props (ADR 0348; the prototype's right dock and bottom log): At cursor (each
// bus's level and why it differs at the cursor, and the loudness there), Voice (the selected voice's status, when it
// played, its sound and bus, its start gain, and what a capture doesn't record yet), Why it played (the decision path,
// `whyModel.ts`) and Messages (warnings, errors and notes in time order; a click seeks and selects).
import { EmptyState } from "../../../editor/ui/EmptyState";
import { formatDb, gainToDb } from "../../../plugins/audio/editor/dbScale";
import type { CaptureReplayOf } from "../../../plugins/audio/runtime/capture/format";
import type { ScreenId } from "../../shell/screens";
import { CURSOR_KEYS_HINT } from "./cursorKeys";
import { reasonsText, type BusReadout } from "./cursorReadout";
import { KIND_TEXT, type ProfilerMessage } from "./messagesModel";
import { clockText } from "./timelineGeometry";
import { reasonWords, STATUS_SEVERITY, STATUS_TEXT, type VoiceBlock } from "./voiceModel";
import { whyChain } from "./whyModel";
import { GeneratorBadge } from "../playlists/generator/GeneratorParts";

// ---- Replay of a take -------------------------------------------------------------------------------------------------

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const takeTitle = (path: string): string => fileName(path).replace(/\.mycotake$/i, "");

/** "Open in Take" (spec §2.16): the capture's take on the Take screen, at the same playhead (one review position). */
export function OpenInTake(props: { readonly take: string; onOpen(path: string): void }) {
  return (
    <button type="button" class="pf-toggle pf-open-take" title={`Open ${takeTitle(props.take)} in Take at the same playhead`} onClick={() => props.onOpen(props.take)}>
      Open in Take
    </button>
  );
}

/**
 * ADR 0348: a replay capture names the take it recorded the Studio playing. "Open in Take" shows only when the project
 * has that take (`onOpenTake` given).
 */
export function ReplayOrigin(props: { readonly take: CaptureReplayOf; onOpenTake?(path: string): void }) {
  return (
    <span class="pf-replay-of" title={`${props.take.path}${props.take.audioHash ? ` · recorded against audio.json ${props.take.audioHash}` : ""}`}>
      Replay of <strong>{fileName(props.take.path)}</strong>
      {props.onOpenTake && <OpenInTake take={props.take.path} onOpen={props.onOpenTake} />}
    </span>
  );
}

// ---- At cursor ----------------------------------------------------------------------------------------------------------

export interface AtCursorProps {
  readonly time: number;
  readonly readouts: readonly BusReadout[];
  /** The loudness at the cursor, if the capture is metered. */
  readonly loudness?: { readonly name: string; readonly lufs: number | null; readonly target: number | null } | null;
  /** A capture is open. */
  readonly open: boolean;
}

export function AtCursor(props: AtCursorProps) {
  if (!props.open) return <EmptyState compact title="No capture open" body="Open a capture to read each bus at the cursor." />;
  return (
    <div class="pf-cursor-panel" title={CURSOR_KEYS_HINT}>
      <p class="pf-panel-caption">
        At {clockText(props.time)} <span class="pf-hint">{CURSOR_KEYS_HINT}</span>
      </p>
      <div class="pf-scroll">
        <table class="pf-table" aria-label="Buses at the cursor">
          <thead>
            <tr>
              <th scope="col">Bus</th>
              <th scope="col">You hear</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {props.loudness && (
              <tr>
                <th scope="row">{props.loudness.name} loudness</th>
                <td class="num">{props.loudness.lufs === null ? "—" : `${props.loudness.lufs.toFixed(1)} LUFS`}</td>
                <td class="pf-why-cell">{props.loudness.target !== null && props.loudness.lufs !== null ? (props.loudness.lufs > props.loudness.target ? `above target ${props.loudness.target}` : `target ${props.loudness.target}`) : ""}</td>
              </tr>
            )}
            {props.readouts.map((r) => (
              <tr key={r.slot} data-bus={r.name}>
                <th scope="row">{r.removed ? `${r.name} (removed)` : r.name}</th>
                <td class="num">{formatDb(r.db)}</td>
                <td class="pf-why-cell">{reasonsText(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.readouts.length === 0 && <p class="pf-note">No keyframe before the cursor: the bus levels start at the first keyframe.</p>}
    </div>
  );
}

// ---- Voice ----------------------------------------------------------------------------------------------------------------

/** "Open in Mixer ›": the Mixer with bus `bus` selected (J10.4). */
function OpenInMixer(props: { bus: string; onOpen(bus: string): void }) {
  return (
    <button type="button" class="link pf-open-mixer" title={`Open the Mixer with ${props.bus} selected`} onClick={() => props.onOpen(props.bus)}>
      Open in Mixer ›
    </button>
  );
}

export function VoiceDetails(props: { readonly voice: VoiceBlock | null; onOpenBus?(bus: string): void }) {
  const v = props.voice;
  if (!v) return <EmptyState compact title="No voice selected" body="Click a voice on the timeline, or a message, to see what happened to it." />;
  const played = v.end > v.start ? `${clockText(v.start)} – ${v.open ? "end of capture" : clockText(v.end)} (${(v.end - v.start).toFixed(2)} s)` : `${clockText(v.start)} (never started)`;
  const why = reasonWords(v);
  return (
    <div class="pf-voice-panel">
      <p>
        <span class="pf-pill" data-severity={STATUS_SEVERITY[v.status]}>
          {STATUS_TEXT[v.status]}
        </span>
        {why && <span class="pf-reason"> {why}</span>}
      </p>
      <dl class="pf-facts">
        <dt>Played</dt>
        <dd>{v.fromKeyframe ? `before the capture – ${v.open ? "end of capture" : clockText(v.end)}` : played}</dd>
        <dt>Sound</dt>
        <dd>
          {v.generator && <GeneratorBadge kind={v.generator} />} {v.clipName}
        </dd>
        <dt>Playlist</dt>
        <dd class="pf-missing">Not in this capture</dd>
        <dt>Bus</dt>
        <dd>
          {v.busName}
          {v.busName && props.onOpenBus && <> <OpenInMixer bus={v.busName} onOpen={props.onOpenBus} /></>}
        </dd>
        <dt>Start gain</dt>
        <dd>{v.startGain === null ? "—" : formatDb(gainToDb(v.startGain))}</dd>
        <dt>Distance</dt>
        <dd class="pf-missing">Not recorded</dd>
        <dt>Version</dt>
        <dd class="pf-missing">Not recorded</dd>
        {v.voice !== null && (
          <>
            <dt>Voice</dt>
            <dd>
              #{v.voice}
              {v.thief !== null ? ` (stolen for #${v.thief})` : ""}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

// ---- Why it played ----------------------------------------------------------------------------------------------------------

export interface WhyItPlayedProps {
  readonly voice: VoiceBlock | null;
  /** Open a step's asset on its screen. */
  onOpen?(screen: ScreenId, target: string): void;
}

export function WhyItPlayed(props: WhyItPlayedProps) {
  const v = props.voice;
  if (!v) return <EmptyState compact title="Why it played" body="Select a voice to follow the path from the game's request to the sample and the bus." />;
  const chain = whyChain(v);
  return (
    <div class="pf-why">
      <ol class="pf-chain" aria-label={`Why ${v.clipName} played`}>
        {chain.steps.map((s, i) => (
          <li key={i} class="pf-step" data-severity={s.severity}>
            <span class="pf-step-kind">{s.label}</span>
            {s.screen && s.target && props.onOpen ? (
              <button type="button" class="link pf-step-name" title={`Open in ${s.screen}`} onClick={() => props.onOpen!(s.screen!, s.target!)}>
                {s.name}
              </button>
            ) : (
              <span class="pf-step-name">{s.name}</span>
            )}
            <span class="pf-step-why">{s.why}</span>
          </li>
        ))}
      </ol>
      {chain.note && <p class="pf-note">{chain.note}</p>}
    </div>
  );
}

// ---- Messages ---------------------------------------------------------------------------------------------------------------

export interface MessageListProps {
  readonly messages: readonly ProfilerMessage[];
  /** The selected voice (its message is highlighted). */
  readonly selected: string | null;
  readonly open: boolean;
  onPick(message: ProfilerMessage): void;
  /** "Open in Mixer ›" on a message about a bus: the Mixer with that bus selected (J10.4). */
  onOpenBus?(bus: string): void;
}

export function MessageList(props: MessageListProps) {
  if (!props.open) return <EmptyState compact title="No capture open" body="Warnings, errors and notes of the open capture show here in time order." />;
  if (props.messages.length === 0) return <EmptyState compact title="No messages" body="Nothing was stolen, blocked, missing or off the loudness target in this capture." />;
  return (
    <ul class="pf-messages" aria-label="Messages">
      {props.messages.map((m) => (
        <li key={m.key} class="pf-message-row">
          <button type="button" class={`pf-message${m.voice !== null && m.voice === props.selected ? " selected" : ""}`} data-kind={m.kind} onClick={() => props.onPick(m)}>
            <span class="pf-msg-time">{clockText(m.time)}</span>
            <span class="pf-msg-kind">{KIND_TEXT[m.kind]}</span>
            <span class="pf-msg-text">{m.text}</span>
          </button>
          {m.bus && m.kind !== "info" && props.onOpenBus && <OpenInMixer bus={m.bus} onOpen={props.onOpenBus} />}
        </li>
      ))}
    </ul>
  );
}
