// The Edits panel, "Sample effects" (ADR 0328, 0331 level "sample"): the chain as it renders: Source (read only), the
// locked Trim and Closed gaps rows, the baked effects (add from the catalogue's sample-level types, remove, reorder,
// bypass, parameters), then the locked Normalize row. A simple local list until the kit's EffectChain lands.
//
// TODO(ADR 0328): the offline render (trim, closed gaps, effects, normalize) is a later task; until it exists the
// chain shows "Render pending" and auditions play the source unprocessed. Freeze, Flatten, A/B and effect automation
// wait for the render too.
import { allowedAt, effectParamValue, effectSpec, effectTypesAt } from "../../../engine/audio/effects/catalogue";
import type { Effect, EffectType } from "../../../engine/audio/effects/types";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { effectEdits } from "./sampleEffects";
import { openSession } from "./samplesState";
import { removedSeconds } from "./sampleTime";

function EffectRow(props: { f: Effect; e: SampleEdits; first: boolean; last: boolean; ro: boolean; commit(r: { next: SampleEdits; label: string } | { refused: string }): void }) {
  const { f, e, ro, commit } = props;
  const spec = effectSpec(f.type);
  const misplaced = !allowedAt(f.type, "sample");
  return (
    <li class={`smp-fx${f.on ? "" : " off"}`}>
      <div class="smp-fx-head">
        <label class="smp-check" title={f.on ? "Bypass" : "Turn on"}>
          <input type="checkbox" checked={f.on} disabled={ro} aria-label={`${spec.label} on`} onChange={() => commit(effectEdits.bypass(e, f.id))} />
          <b>{spec.label}</b>
        </label>
        <span class="smp-muted">v{spec.version}</span>
        {misplaced && <Chip tone="warning" title="This effect can't run baked into a sample; move it to a clip, playlist or bus">Not at sample level</Chip>}
        <span class="smp-fx-tools">
          <button aria-label={`Move ${spec.label} up`} disabled={ro || props.first} onClick={() => commit(effectEdits.move(e, f.id, -1))}>↑</button>
          <button aria-label={`Move ${spec.label} down`} disabled={ro || props.last} onClick={() => commit(effectEdits.move(e, f.id, 1))}>↓</button>
          <button aria-label={`Remove ${spec.label}`} disabled={ro} onClick={() => commit(effectEdits.remove(e, f.id))}>×</button>
        </span>
      </div>
      {spec.params.map((p) => (
        <label key={p.name} class="smp-fx-param">
          <span>{p.label}</span>
          <input type="range" min={p.min} max={p.max} step={p.step} value={effectParamValue(f, p.name)} disabled={ro} aria-label={`${spec.label} ${p.label}`}
            onChange={(ev) => commit(effectEdits.param(e, f.id, p.name, Number((ev.currentTarget as HTMLInputElement).value)))} />
          <span class="smp-muted">{effectParamValue(f, p.name)} {p.unit}</span>
        </label>
      ))}
    </li>
  );
}

export function EditsPanel() {
  const session = openSession.value;
  if (!session) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="Sample effects" body="Effects baked into the sample: no runtime cost. Put effects that must change at runtime on a clip, playlist or bus." />
      </Panel>
    );
  }
  const e = session.edits.value;
  const ro = session.readOnly;
  const commit = (r: { next: SampleEdits; label: string } | { refused: string }) => session.commit(r);
  const n = e.normalize;
  return (
    <Panel class="smp-edits" toolbar={<span class="smp-edits-bar"><span class="smp-muted">Baked into the sample · no runtime cost · game parameters can't drive them</span><Chip tone={e.effects.length || e.trim || e.closedGaps.length || n.mode !== "off" ? "warning" : "neutral"}>{e.effects.length || e.trim || e.closedGaps.length || n.mode !== "off" ? "Render pending" : "Source only"}</Chip></span>}>
      <ol class="smp-chain">
        <li class="smp-fx locked"><b>Source</b> <span class="smp-muted">{session.source.value}</span></li>
        {e.trim && <li class="smp-fx locked"><b>Trim</b> <span class="smp-muted">locked · edit it on the timeline</span></li>}
        {e.closedGaps.length > 0 && <li class="smp-fx locked"><b>Closed gaps</b> <span class="smp-muted">{e.closedGaps.length} · {removedSeconds(e.closedGaps).toFixed(2)} s removed</span></li>}
        {e.effects.map((f, i) => <EffectRow key={f.id} f={f} e={e} first={i === 0} last={i === e.effects.length - 1} ro={ro} commit={commit} />)}
        {n.mode !== "off" && <li class="smp-fx locked"><b>Normalize</b> <span class="smp-muted">{n.gainDb > 0 ? "+" : ""}{n.gainDb.toFixed(1)} dB · applied last, after the effects</span></li>}
      </ol>
      <label class="smp-add-fx">
        <span>Add effect</span>
        <select aria-label="Add effect" disabled={ro} value="" onChange={(ev) => {
          const t = (ev.currentTarget as HTMLSelectElement).value as EffectType;
          if (t) commit(effectEdits.add(e, t));
        }}>
          <option value="">Choose…</option>
          {effectTypesAt("sample").map((t) => <option key={t} value={t}>{effectSpec(t).label}</option>)}
        </select>
      </label>
    </Panel>
  );
}
