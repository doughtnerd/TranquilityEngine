// The Edits panel, "Sample effects" (ADR 0328, 0331 level "sample"): the chain as it renders: Source (read only), the
// locked Trim and Closed gaps rows, the baked effects (add from the catalogue's sample-level types, remove, reorder,
// bypass, parameters), then the locked Normalize row. A simple local list until the kit's EffectChain lands.
//
// Flatten (ADR 0328) renders the chain and the normalize gain into `<name>.flat<n>.wav` beside the source and points
// the sample at it (`sample.source`, one undoable step); Unflatten points it back. The render keeps the source's
// timeline, so trim and closed gaps stay live edits. Freeze, A/B and effect automation editing are later tasks.
import { allowedAt, effectParamValue, effectSpec, effectTypesAt } from "../../../engine/audio/effects/catalogue";
import type { Effect, EffectType } from "../../../engine/audio/effects/types";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { useState } from "preact/hooks";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { effectEdits } from "./sampleEffects";
import { flattenSample, hasRenderableEdits, renderPathOf, unflattenSample } from "./sampleFlatten";
import { nameOf } from "./sampleLibrary";
import { pcmOf, type SampleSession } from "./sampleSession";
import { toasts } from "../../shell/studioServices";
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

/** Flatten / Re-flatten / Unflatten, with what the sample plays now. */
function FlattenBar(props: { session: SampleSession; e: SampleEdits; ro: boolean }) {
  const { session, e, ro } = props;
  const [busy, setBusy] = useState(false);
  const render = renderPathOf(session.project.files, session.source.value, e);
  const flatten = async () => {
    setBusy(true);
    try {
      const r = await flattenSample(session, await pcmOf(session.project, session.source.peek()));
      if ("refused" in r) toasts.show({ text: `Can't flatten: ${r.refused}.` });
      else toasts.show({ text: [`Flattened to ${nameOf(r.path)}`, ...r.render.warnings].join(" · "), undo: () => session.undo() });
    } catch (err) {
      toasts.show({ text: `Can't flatten: ${err instanceof Error ? err.message : String(err)}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="smp-flatten">
      {render ? <Chip tone="neutral" title={`Plays ${render}: the effects and normalize are baked into it`}>Flattened · {nameOf(render)}</Chip> : <span class="smp-muted">Plays the source; Flatten bakes the effects and normalize into a file beside it</span>}
      <span class="smp-flatten-tools">
        <button type="button" class="primary" disabled={ro || busy || !hasRenderableEdits(e)} title={hasRenderableEdits(e) ? "Render the effects and normalize into a new file beside the source" : "Nothing to bake: add an effect or normalize"} onClick={() => void flatten()}>
          {busy ? "Rendering…" : render ? "Re-flatten" : "Flatten"}
        </button>
        {render && <button type="button" disabled={ro || busy} title="Play the source again (the render file stays)" onClick={() => unflattenSample(session)}>Unflatten</button>}
      </span>
    </div>
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
    <Panel class="smp-edits" toolbar={<span class="smp-edits-bar"><span class="smp-muted">Baked into the sample · no runtime cost · game parameters can't drive them</span><Chip tone={e.source !== undefined ? "neutral" : hasRenderableEdits(e) ? "warning" : "neutral"}>{e.source !== undefined ? "Flattened" : hasRenderableEdits(e) ? "Not flattened" : "Source only"}</Chip></span>}>
      <ol class="smp-chain">
        <li class="smp-fx locked"><b>Source</b> <span class="smp-muted">{session.source.value}</span></li>
        {e.trim && <li class="smp-fx locked"><b>Trim</b> <span class="smp-muted">locked · edit it on the timeline</span></li>}
        {e.closedGaps.length > 0 && <li class="smp-fx locked"><b>Closed gaps</b> <span class="smp-muted">{e.closedGaps.length} · {removedSeconds(e.closedGaps).toFixed(2)} s removed</span></li>}
        {e.effects.map((f, i) => <EffectRow key={f.id} f={f} e={e} first={i === 0} last={i === e.effects.length - 1} ro={ro} commit={commit} />)}
        {n.mode !== "off" && <li class="smp-fx locked"><b>Normalize</b> <span class="smp-muted">{n.gainDb > 0 ? "+" : ""}{n.gainDb.toFixed(1)} dB · applied last, after the effects</span></li>}
      </ol>
      <FlattenBar session={session} e={e} ro={ro} />
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
