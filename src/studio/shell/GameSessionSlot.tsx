// The player bar's session controls (ADR 0408): "Record session" records a take on the connected game build (the build
// session, `runtime/buildSession.ts`, ADR 0417), and the next press stops it and saves it where the Studio keeps
// recordings. With no build connected it is inactive. Beside it the game link badge: "Linked to game" while linked, a grey "Disconnected"
// once the link has ended. The Mixer has no transport of its own, so its big button plays the open take's replay
// (`SessionTransport`), as in the prototype.
import { useEffect, useState } from "preact/hooks";
import { LiveLabel, RecordSession, TransportButton, type PlayerBarSlots } from "../components/PlayerBar";
import { formatClock } from "../components/replayControlsModel";
import { buildSession } from "../runtime/buildSession";
import { replayStore } from "./replay";
import { studioRouter } from "./studioServices";

/** Record session's press: start a recording on the build, or stop the running one and save it. */
export async function toggleRecordSession(): Promise<void> {
  const session = buildSession.peek();
  if (!session?.open) return;
  const rec = session.recorder;
  if (rec.state.peek().kind === "recording") {
    await session.stop();
    await rec.save();
  } else if (!rec.busy) await session.start();
}

/** Re-renders twice a second while `on`, so a clock moves. */
function useTick(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => set((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [on]);
}

export function GameSessionSlot(_props: { readonly readOnly?: boolean }) {
  const session = buildSession.value;
  const recordingState = session?.recording.value ?? null;
  const build = recordingState && recordingState.kind !== "ended" ? session!.build : null;
  const state = build ? session!.recorder.state.value.kind : "idle";
  const recording = recordingState?.kind === "recording";
  const since = recordingState?.kind === "recording" ? recordingState.since : null;
  useTick(recording);
  const busy = state === "starting" || state === "stopping" || state === "uploading" || state === "saving";
  const title = !build
    ? "Record session: connect to a running debug build of your game first (the status bar's builds menu)"
    : recording
      ? `Stop recording on ${build.name} and save the take`
      : `Record a take on ${build.name}: what the game asks of audio, with the engine's profile and pictures`;
  return (
    <RecordSession
      recording={recording}
      time={recording && since !== null ? (Date.now() - since) / 1000 : 0}
      connected={!!build}
      busy={busy}
      title={title}
      link={!recordingState ? "none" : recordingState.kind === "ended" ? "disconnected" : "linked"}
      build={build?.name ?? null}
      onToggle={() => void toggleRecordSession()}
    />
  );
}

/** What the Mixer's big button does now, for its tooltip. */
function replayTitle(open: boolean, playing: boolean): string {
  if (!open) return "Open a take to hear the mix against its replay";
  return playing ? "Pause the take's replay" : "Play the open take's replay through your current audio";
}

function toggleReplay(): void {
  const store = replayStore();
  if (store.open.peek()) store.toggle();
  else studioRouter().open({ screen: "take" });
}

/** The Mixer's transport: the big button plays the open take's replay, with its live label. */
function SessionButtons() {
  const store = replayStore();
  const open = store.open.value;
  const playing = store.playing.value;
  return <TransportButton primary icon={playing ? "stop" : "play"} label={playing ? "Stop the replay" : "Play the replay"} title={`${replayTitle(!!open, playing)} (Space)`} onClick={toggleReplay} />;
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
      <input type="range" aria-label="Replay position" aria-valuetext={formatClock(t)} min={0} max={Math.max(0.001, duration)} step={0.01} value={t} disabled={!open} onInput={(e) => store.seek(Number((e.currentTarget as HTMLInputElement).value))} />
      <span>{formatClock(t)}</span>
    </>
  );
}

/** The player bar slots of a screen whose transport is the take's replay (the Mixer). */
export function sessionSlots(art: string): PlayerBarSlots {
  const store = replayStore();
  const open = store.open.value;
  const playing = store.playing.value;
  return {
    nowPlaying: { art, title: open ? open.title : "No take open", subtitle: open ? "Take replay · plays through this mix" : "Open a take to hear the mix against it" },
    transport: <SessionButtons />,
    scrub: <SessionScrub />,
    status: !open ? "Open a take to hear changes in context" : playing ? "Changes play right away" : "Play the replay to hear changes",
  };
}
