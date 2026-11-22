// The Input debugger panel (ADR 0336, 0337; Unreal's `showdebug enhancedinput`): while playing, for one play World,
// its connected devices (kind, family, slot, paired player), its players, each player's active contexts in priority
// order with the controls they consumed, each action's value, phase flags and elapsed time with the mapping that gave
// the value, a rebind in progress, and a short log of action, device, join and rebind events. Read-only: it samples
// the World through the editor SDK (`inputState`, ten times a second) and records its events every frame
// (`watchInput`) while it shows.
import { useEffect, useState } from "preact/hooks";
import type { World } from "../../engine/core/World";
import { inputState, watchInput, type InputActionRow, type InputLogEntry, type InputPlayerRow, type InputWorldState } from "../../engine/editor";
import { actionLabel, formatValue, logText, pickWorld, seconds, sourceLabel, splitPhases, valueMagnitude } from "../inputDebuggerLogic";
import { editor, Panel, usePanelState } from "../sdk";
import "./inputDebugger.css";

/** The panel samples this often (the log records every frame regardless). */
const REFRESH_MS = 100;
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
          <p class="input-debugger-empty">
            Play to see a World's input here: its devices and players, each player's active contexts by priority, every action's value, phase and hold time with the mapping that produced it, the
            controls higher contexts consumed, rebinds in progress and recent events.
          </p>
        )}
      </div>
    </Panel>
  );
}

function Live(props: { worlds: readonly World[] }) {
  const picked = usePanelState<string | null>("world", null);
  const choices = props.worlds.map((w) => ({ name: w.name, takesInput: inputState(w).takesInput }));
  const name = pickWorld(choices, picked.value);
  const world = props.worlds.find((w) => w.name === name) ?? null;
  return (
    <>
      <div class="input-debugger-bar">
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
      </div>
      {world && <WorldView key={world.name} world={world} />}
    </>
  );
}

function WorldView(props: { world: World }) {
  const { world } = props;
  const [state, setState] = useState<InputWorldState | null>(null);
  const [log, setLog] = useState<readonly InputLogEntry[]>([]);
  const [recorder, setRecorder] = useState<ReturnType<typeof watchInput> | null>(null);
  useEffect(() => {
    const rec = watchInput(world);
    setRecorder(rec);
    let seen = -1;
    const refresh = () => {
      try {
        setState(inputState(world));
        if (rec.version !== seen) {
          seen = rec.version;
          setLog([...rec.entries()]);
        }
      } catch (err) {
        console.error("[myco] The Input debugger couldn't read the World:", err);
      }
    };
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(t);
      rec.stop();
    };
  }, [world]);
  if (!state) return null;
  if (!state.takesInput) return <p class="input-debugger-empty">{state.world} doesn't take local input (a server, a World with input off, or a tile without focus), so it has no devices or actions.</p>;
  return (
    <>
      <Devices state={state} />
      {state.players.length === 0 ? (
        <p class="input-debugger-empty">No players: the game defines no action sets (defineActions), so there's nothing to evaluate.</p>
      ) : (
        state.players.map((p) => <Player key={p.index} player={p} sets={new Set(p.actions.map((a) => a.set)).size} />)
      )}
      <Log entries={log} onClear={() => recorder?.clear()} />
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
