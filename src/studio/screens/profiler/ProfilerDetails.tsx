// The Profiler's side panels as views over props (ADR 0348; spec §4.6.4-§4.6.6; the prototype's right dock and bottom
// log): At cursor (each bus as you hear it at the cursor with the reason it differs, and the loudness there), Voice (the
// selected voice's status chip, when it played, its playlist, sound and bus, what you hear of the bus, its start gain,
// what a capture doesn't record yet, and Open in Take), Why it played (the decision path as a flow chart, `whyModel.ts`,
// `WhyGraph.tsx`) and Messages (warnings, errors and notes in time order, with a filter; a click seeks and selects).
import { useState } from "preact/hooks";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { formatDb, gainToDb } from "../../../plugins/audio/editor/dbScale";
import type { CaptureReplayOf } from "../../../plugins/audio/runtime/capture/format";
import type { ScreenId } from "../../shell/screens";
import { CURSOR_KEYS_HINT } from "./cursorKeys";
import { breakdownText, reasonsText, type BusReadout } from "./cursorReadout";
import type { InstanceDecisions } from "./decisionModel";
import { WhyGraph } from "./WhyGraph";
import { KIND_TEXT, searchMessages, type ProfilerMessage } from "./messagesModel";
import { clockText } from "./timelineGeometry";
import { reasonWords, STATUS_SEVERITY, STATUS_TEXT, type VoiceBlock } from "./voiceModel";
import { whyChain } from "./whyModel";
import { GeneratorBadge } from "../playlists/generator/GeneratorParts";

// ---- Replay of a take -------------------------------------------------------------------------------------------------

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const takeTitle = (path: string): string => fileName(path).replace(/\.sporesample$/i, "");

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
    <div class="pf-cursor-panel" title={`At ${clockText(props.time)} · ${CURSOR_KEYS_HINT}`}>
      <table class="pf-cap-grid" aria-label={`Buses at the cursor, ${clockText(props.time)}`}>
        <thead>
          <tr>
            <th scope="col">Bus</th>
            <th scope="col" class="num">You hear</th>
          </tr>
        </thead>
        <tbody>
          {props.loudness && (
            <tr>
              <th scope="row">
                {props.loudness.name} · loudness <span class="pf-why-word">short-term{props.loudness.target !== null ? ` · target ${props.loudness.target}` : ""}</span>
              </th>
              <td class={`num${props.loudness.target !== null && props.loudness.lufs !== null && props.loudness.lufs > props.loudness.target ? " over" : ""}`}>{props.loudness.lufs === null ? "—" : props.loudness.lufs.toFixed(1)}</td>
            </tr>
          )}
          {props.readouts.map((r) => (
            <tr key={r.slot} data-bus={r.name}>
              <th scope="row">
                {r.removed ? `${r.name} (removed)` : r.name}
                {reasonsText(r) && <span class="pf-why-word"> {reasonsText(r)}</span>}
              </th>
              <td class="num">{formatDb(r.db).replace(" dB", "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.readouts.length === 0 && <EmptyState compact title="No bus levels yet" body="The bus levels start at the capture's first keyframe." />}
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

export interface VoiceDetailsProps {
  readonly voice: VoiceBlock | null;
  /** Its playlist instance, when the capture ties it to one (the Playlist row and the chain's start). */
  readonly decision?: InstanceDecisions | null;
  /** Its bus at the cursor (You hear). */
  readonly bus?: BusReadout | null;
  onOpenBus?(bus: string): void;
  onOpenPlaylist?(path: string): void;
  /** The take behind the capture, when the project has it ("Open in Take"). */
  readonly take?: string | null;
  onOpenTake?(path: string): void;
}

export function VoiceDetails(props: VoiceDetailsProps) {
  const v = props.voice;
  if (!v) return <EmptyState compact title="No voice selected" body="Click a voice on the timeline, or a message, to see what happened to it." />;
  const played = v.end > v.start ? `${clockText(v.start)} – ${v.open ? "end of capture" : clockText(v.end)} (${(v.end - v.start).toFixed(2)} s)` : `${clockText(v.start)} (never started)`;
  const why = reasonWords(v);
  const d = props.decision;
  return (
    <div class="pf-voice-panel">
      <p class="pf-voice-status">
        <span class="pf-chip" data-severity={STATUS_SEVERITY[v.status]}>
          {STATUS_TEXT[v.status]}
        </span>
        {why && <span class="pf-reason"> {why}</span>}
      </p>
      <dl class="pf-facts">
        <dt>Played</dt>
        <dd>{v.fromKeyframe ? `before the capture – ${v.open ? "end of capture" : clockText(v.end)}` : played}</dd>
        <dt>Playlist</dt>
        <dd>
          {d ? (
            props.onOpenPlaylist ? (
              <button type="button" class="link pf-open-mixer" title={`Open ${d.asset} in Playlists`} onClick={() => props.onOpenPlaylist!(d.asset)}>
                {assetTitle(d.asset)}
              </button>
            ) : (
              assetTitle(d.asset)
            )
          ) : (
            <span class="pf-missing" title="This capture doesn't tie this voice to a game request">Not tied to a request</span>
          )}
        </dd>
        <dt>Sound</dt>
        <dd>
          {v.generator && <GeneratorBadge kind={v.generator} />} {v.clipName}
        </dd>
        <dt>Bus</dt>
        <dd>
          {v.busName}
          {v.busName && props.onOpenBus && <> <OpenInMixer bus={v.busName} onOpen={props.onOpenBus} /></>}
        </dd>
        {props.bus && (
          <>
            <dt>You hear</dt>
            <dd title={breakdownText(props.bus)}>
              {formatDb(props.bus.db)}
              {reasonsText(props.bus) && <span class="pf-why-word"> {reasonsText(props.bus)}</span>}
            </dd>
          </>
        )}
        <dt>Peak</dt>
        <dd>{v.startGain === null ? "—" : formatDb(gainToDb(v.startGain))}</dd>
        <dt>Distance</dt>
        <dd class="pf-missing" title="Captures don't record the emitter's distance yet">Not recorded</dd>
        <dt>Version</dt>
        <dd class="pf-missing" title="Captures don't record which version of the sound played (edits during Play) yet">Not recorded</dd>
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
      {props.take && props.onOpenTake && (
        <p class="pf-why-take">
          <OpenInTake take={props.take} onOpen={props.onOpenTake} />
        </p>
      )}
    </div>
  );
}

const assetTitle = (path: string): string => {
  const parts = path.split("/");
  const file = parts.pop() ?? path;
  const dot = file.indexOf(".");
  const folder = parts.pop();
  return `${folder ? `${folder} / ` : ""}${dot > 0 ? file.slice(0, dot) : file}`;
};

// ---- Why it played ----------------------------------------------------------------------------------------------------------

export interface WhyItPlayedProps {
  readonly voice: VoiceBlock | null;
  /** Its playlist instance, when the capture ties it to one. */
  readonly decision?: InstanceDecisions | null;
  /** Open a step's asset on its screen. */
  onOpen?(screen: ScreenId, target: string): void;
}

export function WhyItPlayed(props: WhyItPlayedProps) {
  const v = props.voice;
  if (!v) return <EmptyState compact title="Why it played" body="Select a voice to follow the path from the game's request to the sample and the bus." />;
  const chain = whyChain(v, props.decision);
  return (
    <div class="pf-why">
      <WhyGraph steps={chain.steps} id={v.key} label={`Why ${v.clipName} played`} onOpen={props.onOpen} />
      {chain.note && (
        <p class="pf-why-note">
          Partial chain <InfoTip text={chain.note} />
        </p>
      )}
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
  const [query, setQuery] = useState("");
  if (!props.open) return <EmptyState compact title="No capture open" body="Warnings, errors and notes of the open capture show here in time order." />;
  if (props.messages.length === 0) return <EmptyState compact title="No messages" body="Nothing was stolen, blocked, missing or off the loudness target in this capture." />;
  const shown = searchMessages(props.messages, query);
  return (
    <div class="pf-messages-panel">
      <div class="pf-messages-bar">
        <input type="search" class="rft-search" placeholder="Filter messages" aria-label="Filter messages" title="Show the messages whose text or kind holds every word" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <span class="pf-msg-count" role="status">{query.trim() ? `${shown.length} of ${props.messages.length}` : `${props.messages.length}`}</span>
      </div>
      {shown.length === 0 ? (
        <p class="rft-none" role="status">No matches</p>
      ) : (
        <ul class="pf-messages" aria-label="Messages">
          {shown.map((m) => (
            <li key={m.key} class="pf-message-row">
              <button type="button" class={`pf-message${m.voice !== null && m.voice === props.selected ? " selected" : ""}`} data-kind={m.kind} title={`Jump to ${clockText(m.time)}`} onClick={() => props.onPick(m)}>
                <span class="pf-msg-time">{clockText(m.time)}</span>
                <span class="pf-msg-kind">{KIND_TEXT[m.kind]}</span>
                <span class="pf-msg-text">{m.text}</span>
              </button>
              {m.bus && m.kind !== "info" && props.onOpenBus && <OpenInMixer bus={m.bus} onOpen={props.onOpenBus} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
