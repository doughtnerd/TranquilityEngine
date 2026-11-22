// The input overlay (ADR 0336, 0337; Unreal's `showdebug enhancedinput`): while playing, with Overlay on in the Input
// debugger, a compact block per player over the game view: the player and the device family it last used, its active
// contexts by priority, each action's value bar and phase badges, and its last few presses. It follows the World the
// Input debugger follows (else the first that takes local input), and shares the debugger's sampling
// (`inputDebugFeed.ts`). Read-only, and it takes no clicks: it sits in the game view's overlay layer, beside Stats.
import type { World } from "../../engine/core/World";
import { inputState, type InputActionRow, type InputPlayerRow, type InputWorldState } from "../../engine/editor";
import { followedInputWorld, inputOverlayShown, useInputSample } from "../inputDebugFeed";
import { actionLabel, formatValue, pickWorld, recentPresses, splitPhases, valueMagnitude } from "../inputDebuggerLogic";
import { editor } from "../sdk";
import "./inputOverlay.css";

/** Presses listed per player. */
const PRESSES = 5;

/** The overlay, when it's on and a World plays. */
export function InputOverlay() {
  if (!inputOverlayShown.value) return null;
  const worlds = editor.scene.playWorlds;
  if (editor.scene.playState !== "playing" || worlds.length === 0) return null;
  const choices = worlds.map((w) => ({ name: w.name, takesInput: inputState(w).takesInput }));
  const name = pickWorld(choices, followedInputWorld.value);
  const world = worlds.find((w) => w.name === name) ?? null;
  return world ? <WorldOverlay key={world.name} world={world} /> : null;
}

function WorldOverlay(props: { world: World }) {
  const { state, log } = useInputSample(props.world);
  if (!state) return null;
  return (
    <div class="input-overlay" role="region" aria-label="Input overlay">
      <button class="input-overlay-close" aria-label="Close input overlay" title="Hide the input overlay" onClick={() => (inputOverlayShown.value = false)}>
        ×
      </button>
      <div class="input-overlay-world">Input · {state.world}</div>
      {!state.takesInput ? (
        <div class="input-overlay-note">No local input</div>
      ) : state.players.length === 0 ? (
        <div class="input-overlay-note">No players</div>
      ) : (
        state.players.map((p) => <PlayerBlock key={p.index} player={p} state={state} presses={recentPresses(log, state.devices, p.index, PRESSES)} />)
      )}
    </div>
  );
}

function PlayerBlock(props: { player: InputPlayerRow; state: InputWorldState; presses: readonly string[] }) {
  const p = props.player;
  const sets = new Set(p.actions.map((a) => a.set)).size;
  return (
    <section class="input-overlay-player" aria-label={`Overlay player ${p.index}`} data-player={p.index}>
      <div class="input-overlay-head">
        <span class="input-overlay-name">P{p.index}</span>
        <span class="input-overlay-family">{p.lastFamily}</span>
        {p.rebind && <span class="input-overlay-rebind">rebinding {p.rebind.action}</span>}
      </div>
      <div class="input-overlay-contexts" aria-label="Contexts">
        {p.contexts.map((c) => (
          <span key={c.name} class="input-overlay-context" title={`Priority ${c.priority}`}>
            <span class="input-overlay-priority">{c.priority}</span>
            {c.name}
          </span>
        ))}
      </div>
      <table class="input-overlay-actions">
        <tbody>
          {p.actions.map((a) => (
            <ActionLine key={`${a.set}:${a.action}`} row={a} sets={sets} />
          ))}
        </tbody>
      </table>
      <div class="input-overlay-presses" aria-label="Recent presses">
        {props.presses.length ? props.presses.join(" · ") : "—"}
      </div>
    </section>
  );
}

function ActionLine(props: { row: InputActionRow; sets: number }) {
  const a = props.row;
  const { levels, edges } = splitPhases(a.phases);
  return (
    <tr class={a.phases.length ? "active" : ""} data-action={a.action}>
      <th>{actionLabel(a, props.sets)}</th>
      <td>
        <span class="input-overlay-track" aria-hidden="true">
          <span class="input-overlay-fill" style={{ width: `${valueMagnitude(a.value) * 100}%` }} />
        </span>
      </td>
      <td class="input-overlay-value">{formatValue(a.value)}</td>
      <td class="input-overlay-phases">
        {levels.map((f) => (
          <span key={f} class="input-overlay-badge level">
            {f}
          </span>
        ))}
        {edges.map((f) => (
          <span key={f} class="input-overlay-badge edge">
            {f}
          </span>
        ))}
      </td>
    </tr>
  );
}
