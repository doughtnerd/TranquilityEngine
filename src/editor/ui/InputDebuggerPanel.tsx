// The Input debugger panel (ADR 0336, 0337; Unreal's `showdebug enhancedinput`): while playing, for one play World,
// its connected devices (kind, family, slot, paired player), its players, each player's active contexts in priority
// order with the controls they consumed, each action's value, phase flags and elapsed time with the mapping that gave
// the value, a rebind in progress, and a short log of action, device, join and rebind events. Read-only: it samples
// the World through the editor SDK (`inputState`, ten times a second) and records its events every frame
// (`watchInput`) while it shows, one sampling shared with the game-view overlay (`inputDebugFeed.ts`).
//
// Its bar also has Overlay, which shows a compact per-player summary over the game view during play
// (`InputOverlay.tsx`), and Record, which records controllers' raw input at the adapters (the editor SDK's
// `recordInput`) until Stop saves it as a `myco-input-recording` fixture file in the project's `recordings/` folder
// (downloaded where the project can't be written).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { World } from "../../engine/core/World";
import { inputState, type InputActionRow, type InputLogEntry, type InputPlayerRow, type InputRecording, type InputWorldState } from "../../engine/editor";
import { clearInputLog, followedInputWorld, inputOverlayShown, inputRecording, startHardwareRecording, useInputSample } from "../inputDebugFeed";
import { actionLabel, formatValue, logText, pickWorld, recordingFileName, recordingSummary, seconds, sourceLabel, splitPhases, valueMagnitude } from "../inputDebuggerLogic";
import { editor, Panel, usePanelState } from "../sdk";
import "./inputDebugger.css";
import { EmptyState } from "./EmptyState";

/** Log lines shown, newest first. */
const LOG_LINES = 60;

export function InputDebuggerPanel() {
  const worlds = editor.scene.playWorlds;
  const playing = editor.scene.playState === "playing" && worlds.length > 0;
  return (
    <Panel>
      <div class="input-debugger">
        {playing ? (
          <Live worlds={worlds} />
        ) : (
          <>
            <Bar />
            <EmptyState
              compact
              title="Play to see a World's input here."
              body="It shows its devices and players, each player's active contexts by priority, every action's value, phase and hold time with the mapping that produced it, the controls higher contexts consumed, rebinds in progress and recent events; Record works now too, recording your controllers' raw input for a test fixture."
            />
          </>
        )}
      </div>
    </Panel>
  );
}

/** The panel's bar: the World picker while playing (`children`), Overlay and Record. */
function Bar(props: { children?: ComponentChildren }) {
  const overlay = inputOverlayShown.value;
  return (
    <div class="input-debugger-bar">
      {props.children}
      <span class="input-debugger-bar-tools">
        <button class="input-debugger-toggle" aria-pressed={overlay} title="Show each player's contexts, actions and recent presses over the game view while playing" onClick={() => (inputOverlayShown.value = !overlay)}>
          Overlay
        </button>
        <RecordControl />
      </span>
    </div>
  );
}

/** Save `recording` in the project's `recordings/` folder, or download it where the project can't be written. Its path or file name, or null. */
async function saveRecording(recording: InputRecording): Promise<{ where: string; downloaded: boolean } | null> {
  const name = recordingFileName(new Date(recording.recorded));
  const text = `${JSON.stringify(recording, null, 1)}\n`;
  const project = editor.project.peek();
  if (project?.canSave) {
    const path = await editor.project.createFile({ folder: "recordings", name, what: "input recordings", write: (p, at) => p.writeText(at, text), created: (at) => `Saved the input recording as ${at}.` });
    return path ? { where: path, downloaded: false } : null;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { where: name, downloaded: true };
}

/** Record / Stop: a hardware recording of the controllers' raw input, saved on Stop. */
function RecordControl() {
  const recorder = inputRecording.value;
  const [, setTicks] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!recorder) return;
    const t = setInterval(() => setTicks((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [recorder]);
  const stop = async () => {
    if (!recorder) return;
    const recording = recorder.stop();
    inputRecording.value = null;
    try {
      const result = await saveRecording(recording);
      setSaved(result ? `${result.downloaded ? "Downloaded" : "Saved"} ${result.where}: ${recordingSummary(recording)}.` : null);
    } catch (err) {
      editor.messages.failed("Couldn't save the input recording", err);
    }
  };
  return (
    <>
      {recorder ? (
        <button class="input-debugger-record recording" aria-pressed={true} title="Stop recording and save the fixture file" onClick={() => void stop()}>
          Stop
          <span class="input-debugger-facts">
            {(recorder.elapsed / 1000).toFixed(1)} s · {recorder.events} events
          </span>
        </button>
      ) : (
        <button
          class="input-debugger-record"
          aria-pressed={false}
          title="Record controllers' raw input as it arrives (WebHID reports, SDL batches, Gamepad API readings) and save it as a fixture file for tests"
          onClick={() => {
            setSaved(null);
            startHardwareRecording();
          }}
        >
          Record
        </button>
      )}
      {saved && !recorder && (
        <span class="input-debugger-saved" role="status">
          {saved}
        </span>
      )}
    </>
  );
}

function Live(props: { worlds: readonly World[] }) {
  const picked = usePanelState<string | null>("world", null);
  const choices = props.worlds.map((w) => ({ name: w.name, takesInput: inputState(w).takesInput }));
  const name = pickWorld(choices, picked.value);
  const world = props.worlds.find((w) => w.name === name) ?? null;
  useEffect(() => {
    followedInputWorld.value = name; // the overlay follows the same World
  }, [name]);
  return (
    <>
      <Bar>
        <label>
          World
          <select aria-label="World" value={name ?? ""} onChange={(e) => (picked.value = e.currentTarget.value)}>
            {choices.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
                {w.takesInput ? "" : " (no local input)"}
              </option>
            ))}
          </select>
        </label>
      </Bar>
      {world && <WorldView key={world.name} world={world} />}
    </>
  );
}

function WorldView(props: { world: World }) {
  const { world } = props;
  const { state, log } = useInputSample(world);
  if (!state) return null;
  if (!state.takesInput) return <EmptyState compact title={`${state.world} doesn't take local input, so it has no devices or actions.`} body="It's a server, a World with input off, or a tile without focus." />;
  return (
    <>
      <Devices state={state} />
      {state.players.length === 0 ? (
        <EmptyState compact title="No players: the game defines no action sets (defineActions), so there's nothing to evaluate." />
      ) : (
        state.players.map((p) => <Player key={p.index} player={p} sets={new Set(p.actions.map((a) => a.set)).size} />)
      )}
      <Log entries={log} onClear={() => clearInputLog(world)} />
    </>
  );
}

function Devices(props: { state: InputWorldState }) {
  const { devices } = props.state;
  return (
    <section class="input-debugger-section" aria-label="Devices">
      <h4>Devices</h4>
      {devices.length === 0 ? (
        <p class="input-debugger-none">None yet: the keyboard and pointer appear with the first key or click, gamepads when connected.</p>
      ) : (
        <table class="input-debugger-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Kind</th>
              <th>Family</th>
              <th>Slot</th>
              <th>Player</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} class={d.connected ? "" : "disconnected"} data-device={d.name}>
                <td>{d.name}</td>
                <td>{d.kind}</td>
                <td>{d.family}</td>
                <td>{d.slot}</td>
                <td>{d.player < 0 ? "—" : d.player}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Player(props: { player: InputPlayerRow; sets: number }) {
  const p = props.player;
  return (
    <section class="input-debugger-section" aria-label={`Player ${p.index}`}>
      <h4>
        {p.name}
        <span class="input-debugger-facts">
          last used {p.lastFamily}
          {p.pawns.length > 0 && ` · controls ${p.pawns.join(", ")}`}
        </span>
      </h4>
      {p.rebind && (
        <p class="input-debugger-rebind" role="status">
          {p.rebind.add ? "Adding a binding for" : "Rebinding"} {p.rebind.action} ({p.rebind.context} #{p.rebind.mapping + 1}{p.rebind.add ? "" : `, ${p.rebind.part}`}): waiting for a {p.rebind.device} press · {p.rebind.cancel} cancels · {seconds(p.rebind.remaining)} left
        </p>
      )}
      <div class="input-debugger-contexts" role="list" aria-label="Active contexts">
        {p.contexts.map((c) => (
          <div key={c.name} role="listitem" class="input-debugger-context">
            <span class="input-debugger-priority" title="Priority: higher runs first">{c.priority}</span>
            <span class="input-debugger-context-name">{c.name}</span>
            <span class="input-debugger-facts">{c.mappings} mappings</span>
            {c.consumed.length > 0 && <span class="input-debugger-consumed" title="Controls this context consumed: lower contexts didn't see them">consumed {c.consumed.join(", ")}</span>}
          </div>
        ))}
      </div>
      {p.problems.length > 0 && (
        <ul class="input-debugger-problems">
          {p.problems.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <table class="input-debugger-table input-debugger-actions">
        <thead>
          <tr>
            <th>Action</th>
            <th>Value</th>
            <th>Phase</th>
            <th>Time</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {p.actions.map((a) => (
            <ActionRow key={`${a.set}:${a.action}`} row={a} sets={props.sets} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ActionRow(props: { row: InputActionRow; sets: number }) {
  const a = props.row;
  const { levels, edges } = splitPhases(a.phases);
  const active = a.phases.length > 0;
  return (
    <tr class={active ? "active" : ""} data-action={a.action}>
      <td title={`${a.set}:${a.action} (${a.kind})`}>{actionLabel(a, props.sets)}</td>
      <td class="input-debugger-value">
        <span class="input-debugger-bar-track" aria-hidden="true">
          <span class="input-debugger-bar-fill" style={{ width: `${valueMagnitude(a.value) * 100}%` }} />
        </span>
        {formatValue(a.value)}
      </td>
      <td class="input-debugger-phases">
        {levels.map((f) => (
          <span key={f} class={`input-flag level ${f}`}>{f}</span>
        ))}
        {edges.map((f) => (
          <span key={f} class={`input-flag edge ${f}`}>{f}</span>
        ))}
      </td>
      <td class="input-debugger-num">{a.elapsed > 0 ? a.elapsed.toFixed(2) : ""}</td>
      <td class="input-debugger-source">{sourceLabel(a.source)}</td>
    </tr>
  );
}

function Log(props: { entries: readonly InputLogEntry[]; onClear: () => void }) {
  const shown = props.entries.slice(-LOG_LINES).reverse();
  return (
    <section class="input-debugger-section" aria-label="Events">
      <h4>
        Events
        <button class="input-debugger-clear" onClick={props.onClear} disabled={props.entries.length === 0}>
          Clear
        </button>
      </h4>
      {shown.length === 0 ? (
        <p class="input-debugger-none">No events yet: press something.</p>
      ) : (
        <ol class="input-debugger-log" aria-label="Recent events">
          {shown.map((e, i) => (
            <li key={`${e.frame}-${i}`} class={`log-${e.kind}`}>
              <span class="input-debugger-frame">{e.frame}</span>
              {logText(e)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
