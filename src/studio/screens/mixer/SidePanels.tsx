// The Mixer's smaller panels (ADR 0344 "Gain", ADR 0171 loudness; the prototype's Gain lanes, Game parameters and
// Loudness): where the selected bus's level comes from (authored values, with the runtime's lanes while it runs), the
// test values of the game parameters (they drive snapshot conditions, automation display and the Studio's runtime),
// and Master's loudness against a platform target ("—" until the Studio's audio plays).
import { useState } from "preact/hooks";
import { formatDb } from "../../components/faderModel";
import { GainLanes } from "../../components/GainLanes";
import { ParameterPanel } from "../../components/ParameterPanel";
import { gainInputs, loudnessRows, targetOptionText } from "./boardModel";
import { kindOf, masterOf } from "./busTree";
import { sessionParametersHost } from "./globalParametersHost";
import type { MixerSession } from "./mixerScreen";
import { NewGlobalParameterDialog } from "./newGlobalParameter";
import { MixFrame } from "./mixerViewParts";

export function GainLanesPanel(props: { session: MixerSession }) {
  const { session } = props;
  void session.tick.value;
  const p = session.project.value;
  const name = session.selected.value;
  if (kindOf(p, name) === "vca") {
    return (
      <MixFrame session={session} label="Gain lanes">
        <p class="mx-note">{name} is a VCA: it adds {formatDb(p.vcas.find((v) => v.name === name)!.volumeDb)} dB to the VCA lane of each member and everything under it. Select a bus to see its lanes.</p>
      </MixFrame>
    );
  }
  const inputs = gainInputs(p, session.editing.value, session.soloed.value, session.testValues.value, session.deps.readBus);
  return (
    <MixFrame session={session} label="Gain lanes">
      <GainLanes inputs={inputs} bus={name} />
      {!session.deps.live?.running() && <p class="mx-note">Runtime, dip and duck lanes show while the Studio's audio plays.</p>}
    </MixFrame>
  );
}

export function ParametersPanel(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const [adding, setAdding] = useState(false);
  return (
    <MixFrame session={session} label="Game parameters">
      <ParameterPanel
        parameters={p.parameters}
        values={session.testValues.value}
        empty="No game parameters yet."
        onValue={(name, value) => session.setTestValue(name, value)}
        onNewParameter={session.readOnly ? undefined : () => setAdding(true)}
      />
      {adding && <NewGlobalParameterDialog host={sessionParametersHost(session)} onCancel={() => setAdding(false)} onCreated={() => setAdding(false)} />}
    </MixFrame>
  );
}

export function LoudnessPanel(props: { session: MixerSession }) {
  const { session } = props;
  void session.tick.value;
  const p = session.project.value;
  const master = masterOf(p);
  const targets = p.loudness.targets;
  const [target, setTarget] = useState<string>(targets[0]?.name ?? "");
  const chosen = targets.find((t) => t.name === target) ?? null;
  const reading = session.deps.readLoudness?.(master) ?? null;
  const rows = loudnessRows(reading, chosen);
  return (
    <MixFrame session={session} class="mx-loudness" label={`Loudness of ${master}`}>
      <div class="mx-loud-tools">
        <label class="mx-inline">
          Platform target
          <select value={target} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setTarget(v); session.deps.setLoudnessTarget?.(v); }} aria-label="Platform target">
            {targets.map((t) => <option key={t.name} value={t.name}>{targetOptionText(t)}</option>)}
          </select>
        </label>
        {reading?.tainted && <span class="mx-chip warn" title="A solo or Compare changed what the meters heard since the last reset">Monitor changed the reading</span>}
      </div>
      <dl class="mx-loud" aria-label="Readings">
        {rows.map((r) => (
          <div key={r.key} class={`mx-loud-cell${r.warn ? " warn" : ""}`} title={r.warn ?? undefined}>
            <dt>{r.label}</dt>
            <dd>{r.text}</dd>
            {r.warn && <dd class="mx-loud-warn">{r.warn}</dd>}
          </div>
        ))}
      </dl>
      {!reading && <p class="mx-note">Readings show while the Studio's audio plays: audition a playlist or replay a take.</p>}
    </MixFrame>
  );
}
