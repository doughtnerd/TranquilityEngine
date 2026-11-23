// The Parameters panel while a sequence is open (proto A10, spec §4.2.9): only the game parameters this sequence uses,
// each with its test value (slider and typed box, or a label select) and a use chip ("1 use", its tooltip naming
// where), and a Held row when anything waits for release (Held / Released: the sequence's key; While-held loops stay
// active until it is released, as Space does while playing). Empty: "No parameters used by this sequence".
import type { ParameterDef } from "../../../../engine/audio/parameters";
import type { SequenceSettings } from "../../../../engine/audio/playlist/types";
import { EmptyState } from "../../../../editor/ui/EmptyState";
import { ParameterPanel } from "../../../components/ParameterPanel";
import { parameterUses, useChip } from "./sequenceParameters";
import type { SourceOf } from "./sequenceModel";
import { sequenceHeldNow, toggleHeld } from "./sequenceState";
import { hasHeldLoop } from "./transportModel";
import "./sequence.css";

export interface SequenceParametersProps {
  readonly seq: SequenceSettings;
  readonly sourceOf: SourceOf;
  readonly parameters: readonly ParameterDef[];
  readonly values: Readonly<Record<string, number>>;
  onValue(name: string, value: number | null): void;
  onNewParameter?(): void;
}

export function SequenceParameters(props: SequenceParametersProps) {
  const uses = parameterUses(props.seq, props.sourceOf);
  const used = props.parameters.filter((p) => uses.has(p.name));
  // A parameter the sequence names but the project doesn't define still shows, as unused-in-project.
  const missing = [...uses.keys()].filter((n) => !props.parameters.some((p) => p.name === n));
  const held = hasHeldLoop(props.seq, props.sourceOf);
  const isHeld = sequenceHeldNow();
  if (!used.length && !missing.length && !held) {
    return (
      <div class="sq-params">
        <EmptyState compact title="No parameters used by this sequence" />
        {props.onNewParameter && (
          <button type="button" class="studio-params-new" onClick={props.onNewParameter}>New parameter…</button>
        )}
      </div>
    );
  }
  return (
    <div class="sq-params">
      {held && (
        <div class="sq-params-row">
          <span class="sq-param-name">held</span>
          <button type="button" class={`sq-sbtn${isHeld ? " on" : ""}`} aria-pressed={isHeld}
            title="The sequence's key is held: While held loops stay active until it is released (Space releases while playing)" onClick={toggleHeld}>
            {isHeld ? "Held" : "Released"}
          </button>
          <span class="sq-use-chip used" title="While held loops wait for it">{plural(heldCount(props.seq, props.sourceOf))}</span>
        </div>
      )}
      {used.map((p) => {
        const chip = useChip(uses.get(p.name));
        return (
          <div key={p.name} class="sq-params-row param">
            <div class="sq-params-control">
              <ParameterPanel parameters={[p]} values={props.values} onValue={(name, v) => props.onValue(name, v)} />
            </div>
            <span class={`sq-use-chip${chip.used ? " used" : ""}`} title={chip.title}>{chip.text}</span>
          </div>
        );
      })}
      {missing.map((n) => {
        const chip = useChip(uses.get(n));
        return (
          <div key={n} class="sq-params-row">
            <span class="sq-param-name">{n}</span>
            <span class="sq-faint" title="The sequence names this parameter, but the project doesn't define it: add it with New parameter…">not in the project</span>
            <span class="sq-use-chip used warn" title={chip.title}>{chip.text}</span>
          </div>
        );
      })}
    </div>
  );
}

const plural = (n: number) => (n === 1 ? "1 use" : `${n} uses`);

/** How many loops wait for release: the sequence's own and the enabled clips' driving ones. */
function heldCount(s: SequenceSettings, sourceOf: SourceOf): number {
  let n = s.loops.filter((l) => l.active === "held").length;
  for (const t of s.tracks) for (const c of t.clips) if (t.enabled && c.enabled && sourceOf(c)?.loops.some((l) => (c.loops[l.id]?.active ?? l.active) === "held")) n++;
  return Math.max(1, n);
}
