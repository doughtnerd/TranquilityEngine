// The Events tab's test bench (ADR 0341 §7, 0343 §6): a value picker per argument (a parameter argument can read its
// global), the seed, the decision's summary and the picked line's subtitle in the preview language, Say (auditions the
// picked line and remembers it, as the runtime's memory would), Roll ×50 (the pick distribution, a bar per line) and
// Reset memory. The path table highlights the picked path and the fallbacks. A view over props.
import { SelectBox } from "../../../../editor/ui/PanelFields";
import { argumentName, type DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { labelsOf, type EventContext } from "./eventsModel";
import { FROM_GLOBAL, type BenchView, type RollBar } from "./testBench";

export interface TestBenchViewProps {
  readonly event: DialogueEvent;
  readonly ctx: EventContext;
  readonly values: Readonly<Record<string, string>>;
  readonly seed: number;
  readonly view: BenchView;
  /** The picked line's subtitle in the preview language, or null. */
  readonly subtitle: string | null;
  readonly preview: string;
  readonly bars: readonly RollBar[] | null;
  /** Lines said this session (the bench's memory), newest last. */
  readonly memory: readonly string[];
  onValue(name: string, value: string): void;
  onSeed(seed: number): void;
  onSay(): void;
  onRoll(): void;
  onResetMemory(): void;
}

const NONE: Record<string, string> = { silence: "silence", noMatch: "no match", unavailable: "no line available" };

export function TestBenchView(props: TestBenchViewProps) {
  const e = props.event;
  return (
    <section class="dl-section" aria-label="Test bench">
      <h3>Test bench</h3>
      <div class="dl-row">
        {e.arguments.map((a) => {
          const name = argumentName(a);
          const labels = labelsOf(a, props.ctx);
          const options = [...(a.kind === "parameter" ? [{ value: FROM_GLOBAL, label: "from global" }] : []), ...labels.map((l) => ({ value: l, label: l }))];
          const value = props.values[name] ?? (a.kind === "parameter" ? FROM_GLOBAL : a.default);
          return (
            <label key={name} class="dl-row">{name}
              <SelectBox label={`Bench ${name}`} value={value} options={options} onValue={(v) => props.onValue(name, v)} />
            </label>
          );
        })}
        <label class="dl-row">Seed
          <input type="number" aria-label="Seed" value={props.seed} style={{ width: "72px" }} onChange={(ev) => props.onSeed(Math.trunc(Number((ev.currentTarget as HTMLInputElement).value)) || 1)} />
        </label>
      </div>
      <p aria-label="Decision" class={"key" in props.view.result ? undefined : "dl-warn"}>{props.view.summary}</p>
      {props.subtitle !== null && <p class="dl-note" aria-label="Subtitle">“{props.subtitle}” <span class="dl-from">{props.preview}</span></p>}
      <div class="dl-row">
        <button class="primary" onClick={props.onSay} title="Decide with the bench's memory, say the line and remember it">Say</button>
        <button onClick={props.onRoll} title="Decide 50 times from the seed and show how often each line comes up">Roll ×50</button>
        <button onClick={props.onResetMemory} disabled={props.memory.length === 0} title="Forget the lines said (avoid-repeat, cooldowns, once)">Reset memory</button>
        {props.memory.length > 0 && <span class="dl-muted">Said: {props.memory.slice(-4).join(", ")}</span>}
      </div>
      {props.bars && (
        <div class="dl-bars" aria-label="Pick distribution">
          {props.bars.map((b) => (
            <div key={b.outcome} class={`dl-bar${b.said ? "" : " none"}`} aria-label={`${b.said ? b.outcome : NONE[b.outcome] ?? b.outcome}: ${b.count} of 50`}>
              <span class="dl-key">{b.said ? b.outcome : NONE[b.outcome] ?? b.outcome}</span>
              <span class="dl-bar-track"><span class="dl-bar-fill" style={{ width: `${b.share * 100}%` }} /></span>
              <span class="dl-muted">{b.count}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
