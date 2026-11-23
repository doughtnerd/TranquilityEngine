// The player bar's game session over the page's replay store (spec §3.5/§3.7; owner decision, UI pass #1: the
// "Game session" pill and "Linked to game" badge show on every screen but drive take replay until a live game link is
// built). With a take open, the pill plays and pauses its replay and its clock is the take's time, and the badge says
// edits are heard against it; with none open, the pill takes you to the Take screen to open one. The Mixer has no
// transport of its own, so its big button is the session (`SessionTransport`), as in the prototype.
import { GameSession, LiveLabel, TransportButton, type PlayerBarSlots } from "../components/PlayerBar";
import { formatClock } from "../components/replayControlsModel";
import { replayStore } from "./replay";
import { studioRouter } from "./studioServices";

const LINKED_TITLE = "Edits are heard against the open take's replay right away (the live game link comes later)";

/** What pressing the session does now, for its tooltip. */
function sessionTitle(open: boolean, playing: boolean): string {
  if (!open) return "Game session: open a take to replay it here (the live game link comes later)";
  return playing ? "Pause the game session (the take's replay)" : "Play the game session: the open take replays through your current audio, on every screen";
}

function toggleSession(): void {
  const store = replayStore();
  if (store.open.peek()) store.toggle();
  else studioRouter().open({ screen: "take" });
}

export function GameSessionSlot(props: { readonly readOnly?: boolean }) {
  const store = replayStore();
  const open = store.open.value;
  const playing = store.playing.value;
  return <GameSession live={playing} time={store.time.value} title={props.readOnly ? "The game session is the main button on this screen" : sessionTitle(!!open, playing)} linked={!!open} linkedTitle={LINKED_TITLE} readOnly={props.readOnly} onToggle={toggleSession} />;
}

/** The Mixer's transport: the big button is the game session, with its live label. */
function SessionButtons() {
  const store = replayStore();
  const open = store.open.value;
  const playing = store.playing.value;
  return <TransportButton primary icon={playing ? "stop" : "play"} label={playing ? "Stop the game session" : "Play the game session"} title={`${sessionTitle(!!open, playing)} (Space)`} onClick={toggleSession} />;
}

/** The Mixer's scrub row: the live label, the take's position and its clock. */
function SessionScrub() {
  const store = replayStore();
  const open = store.open.value;
  const t = store.time.value;
  const duration = open?.take.duration ?? 0;
  return (
    <>
      <LiveLabel live={store.playing.value} />
      <input type="range" aria-label="Game session position" aria-valuetext={formatClock(t)} min={0} max={Math.max(0.001, duration)} step={0.01} value={t} disabled={!open} onInput={(e) => store.seek(Number((e.currentTarget as HTMLInputElement).value))} />
      <span>{formatClock(t)}</span>
    </>
  );
}

/** The player bar slots of a screen whose transport is the game session (the Mixer). */
export function sessionSlots(art: string): PlayerBarSlots {
  const store = replayStore();
  const open = store.open.value;
  const playing = store.playing.value;
  return {
    nowPlaying: { art, title: open ? open.title : "Game session", subtitle: open ? "Take replay · plays through this mix" : "Open a take to hear the mix against it" },
    transport: <SessionButtons />,
    scrub: <SessionScrub />,
    status: !open ? "Open a take to hear changes in context" : playing ? "Changes play right away" : "Play the session to hear changes",
  };
}
