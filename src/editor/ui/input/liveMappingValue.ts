// Live values in the Input dialog (ADR 0417): while the game plays, what a mapping's controls read now, combined and
// before its modifiers, sampled every frame from the World the Input Debugger follows (or the first that takes input).
// The modifier stack runs it through `traceInputModifiers`, so each row shows its live output.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { MappingSpec } from "../../../engine";
import { inputMappingValue, inputState } from "../../../engine/editor";
import { followedInputWorld } from "../../inputDebugFeed";
import { pickWorld } from "../../inputDebuggerLogic";
import { editor } from "../../sdk";

const same = (a: readonly number[] | null, b: readonly number[] | null) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-4));

/** The mapping's live value while playing (player 0), else null. Re-renders only when the value changes. */
export function useLiveMappingValue(mapping: MappingSpec): number[] | null {
  const worlds = editor.scene.playWorlds;
  const playing = editor.scene.playState === "playing" && worlds.length > 0;
  const choices = useMemo(() => (playing ? worlds.map((w) => ({ name: w.name, takesInput: inputState(w).takesInput })) : []), [playing, worlds]);
  const name = playing ? pickWorld(choices, followedInputWorld.value) : null;
  const world = name ? (worlds.find((w) => w.name === name) ?? null) : null;
  const key = JSON.stringify(mapping);
  const [value, setValue] = useState<number[] | null>(null);
  useEffect(() => {
    if (!world) {
      setValue(null);
      return;
    }
    let last: number[] | null = null;
    let frame = 0;
    const tick = () => {
      const next = inputMappingValue(world, mapping);
      if (!same(next, last)) setValue((last = next));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [world, key]);
  return value;
}
