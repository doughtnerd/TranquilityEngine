// Bus meters (ADR 0157 §7): one level bar per bus in Project settings > Audio while the game plays, read from
// `Bus.peak` (the newest peak, linear, already decayed for display) about 20 times a second. The bars are
// updated straight on their elements, so a tick allocates nothing and renders nothing.
import { useEffect, useRef } from "preact/hooks";
import { editor } from "../../../editor/sdk";
import { Audio } from "../runtime";

/** The quietest level a bar shows, in dB; anything under it is empty. */
export const METER_FLOOR_DB = -60;
const POLL_MS = 50;

/** A linear peak as a 0..1 bar length on a dB scale from `METER_FLOOR_DB` to 0 (clipping over 0 dB fills the bar). */
export function meterFill(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return db <= METER_FLOOR_DB ? 0 : db >= 0 ? 1 : (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

/** The meter strip for `names` (the project's buses, tree order). Renders nothing outside Play. */
export function BusMeters(props: { names: readonly string[] }) {
  const playing = editor.scene.playState === "playing";
  if (!playing) return null;
  return <MeterStrip names={props.names} />;
}

function MeterStrip(props: { names: readonly string[] }) {
  const { names } = props;
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const shown = useRef<number[]>([]);
  useEffect(() => {
    shown.current = names.map(() => -1);
    const buses = names.map((n) => Audio.bus(n));
    const tick = () => {
      for (let i = 0; i < buses.length; i++) {
        const bar = bars.current[i];
        if (!bar) continue;
        const fill = Math.round(meterFill(buses[i].peak) * 200) / 200;
        if (fill === shown.current[i]) continue;
        shown.current[i] = fill;
        bar.style.transform = `scaleX(${fill})`;
        bar.classList.toggle("hot", fill >= 1);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [names.join("\n")]);
  return (
    <div class="audio-meters" role="group" aria-label="Bus meters">
      {names.map((name, i) => (
        <div key={name} class="audio-meter" data-bus={name}>
          <span class="audio-meter-name">{name}</span>
          <div class="audio-meter-track" role="meter" aria-label={`${name} level`} aria-valuemin={METER_FLOOR_DB} aria-valuemax={0}>
            <div class="audio-meter-fill" ref={(el) => { bars.current[i] = el; }} />
          </div>
        </div>
      ))}
    </div>
  );
}
