// The Heatmap toggle (experimental) in the Take and Profiler toolbars: on, their timelines recolour each instance or voice
// by how often its sound played in the recording (`heatmapModel.ts`). One setting for both screens, kept per viewer.
import { signal } from "@preact/signals";
import { Icon } from "./Icon";

const KEY = "myco.studio.heatmap";

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether the timelines draw play-count heat. */
export const heatmapOn = signal(stored());

export function setHeatmap(on: boolean): void {
  heatmapOn.value = on;
  try {
    globalThis.localStorage?.setItem(KEY, on ? "1" : "0");
  } catch {
    // private window or blocked storage: it holds for this session
  }
}

/** The toolbar button; `class` is the screen's own icon-button class. */
export function HeatmapToggle(props: { readonly class: string }) {
  const on = heatmapOn.value;
  return (
    <button
      type="button"
      class={`${props.class} studio-heatmap-toggle${on ? " on" : ""}`}
      aria-pressed={on}
      aria-label="Heatmap"
      title={on ? "Heatmap (experimental): on. Bars are coloured by how often their sound played, from fewest (cold) to most (hot)" : "Heatmap (experimental): colour bars by how often their sound played in this recording"}
      onClick={() => setHeatmap(!on)}
    >
      <Icon name="heatmap" size={14} />
    </button>
  );
}
