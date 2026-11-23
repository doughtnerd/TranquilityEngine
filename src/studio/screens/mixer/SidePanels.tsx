// The Mixer's smaller panels (ADR 0344 "Gain", ADR 0171 loudness; the prototype's Gain lanes, Game parameters and
// Loudness): where the selected bus's level comes from (authored values, with the runtime's lanes while it runs), the
// test values of the game parameters (a slider and field for a number, a checkbox for true / false, an in-app
// dropdown for a state or a text value; they drive snapshot conditions, automation display and the Studio's runtime),
// and Master's loudness against a platform target: the BS.1770 readouts with their units and verdicts, and the
// short-term loudness of the last 60 s against the target line ("—" until the Studio's audio plays).
import { useEffect, useRef, useState } from "preact/hooks";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { isLabelled, parameterKind } from "../../../engine/audio/parameters";
import { Checkbox } from "../../components/Checkbox";
import { formatDb } from "../../components/faderModel";
import { GainLanes } from "../../components/GainLanes";
import { Icon } from "../../components/Icon";
import { ParameterRow } from "../../components/ParameterRow";
import { parameterRows } from "../../components/parameterPanelModel";
import { gainInputs, loudnessRows, targetOptionText } from "./boardModel";
import { kindOf, masterOf } from "./busTree";
import { sessionParametersHost } from "./globalParametersHost";
import { pushReading, sparkline, SHORT_TERM_WINDOW_S, type LoudnessPoint } from "./loudnessHistory";
import type { MixerSession } from "./mixerScreen";
import { MixDropdown } from "./MixDropdown";
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
        <p class="mx-note">{name} is a VCA: it adds {formatDb(p.vcas.find((v) => v.name === name)!.volumeDb)} dB to its members. Select a bus to see its lanes.</p>
      </MixFrame>
    );
  }
  const inputs = gainInputs(p, session.editing.value, session.soloed.value, session.testValues.value, session.deps.readBus);
  return (
    <MixFrame session={session} label="Gain lanes">
      <GainLanes inputs={inputs} bus={name} />
      {!session.deps.live?.running() && (
        <p class="mx-note mx-inline-tip">
          Runtime, dip and duck: while audio plays <InfoTip text="The runtime, dip and duck lanes are read from the Studio's running audio: audition a playlist or replay a take to see them." label="About live lanes" />
        </p>
      )}
    </MixFrame>
  );
}

export function ParametersPanel(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const values = session.testValues.value;
  const [adding, setAdding] = useState(false);
  const rows = parameterRows(p.parameters, values);
  return (
    <MixFrame session={session} label="Game parameters">
      {rows.length === 0 ? (
        <p class="mx-note">No game parameters yet.</p>
      ) : (
        <div class="studio-params mx-params" role="group" aria-label="Game parameters (test values)" title="Test values for the game parameters that drive automation and snapshot triggers">
          {rows.map((row) => {
            const def = p.parameters.find((q) => q.name === row.name)!;
            const reset = (
              <button type="button" class="studio-icon-button" aria-label={`Reset ${row.name}`} title={`Reset ${row.name} to its default`} disabled={row.isDefault} onClick={() => session.setTestValue(row.name, null)}>
                <Icon name="undo" size={14} />
              </button>
            );
            if (row.kind === "number") {
              return (
                <div key={row.name} class="studio-params-row">
                  <ParameterRow spec={row.spec} value={row.value} onValue={(v) => session.setTestValue(row.name, v)} />
                  {reset}
                </div>
              );
            }
            const kind = parameterKind(def);
            return (
              <div key={row.name} class="studio-params-row">
                <div class="studio-param">
                  <span>{row.name}</span>
                  <span class="mx-param-control">
                    {kind === "bool" ? (
                      <Checkbox checked={row.value === 1} ariaLabel={row.name} title={`${row.name}: true or false`} onChange={(on) => session.setTestValue(row.name, on ? 1 : 0)} />
                    ) : (
                      <MixDropdown
                        label={row.name}
                        value={String(row.value)}
                        title={kind === "text" ? `${row.name}: a text value (the values the game sends)` : undefined}
                        options={(isLabelled(def) ? def.labels : []).map((l, i) => ({ value: String(i), label: l === "" ? "(empty)" : l }))}
                        onChange={(v) => session.setTestValue(row.name, Number(v))}
                      />
                    )}
                  </span>
                </div>
                {reset}
              </div>
            );
          })}
        </div>
      )}
      {!session.readOnly && (
        <button type="button" class="studio-params-new" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> New parameter…
        </button>
      )}
      {adding && <NewGlobalParameterDialog host={sessionParametersHost(session)} onCancel={() => setAdding(false)} onCreated={() => setAdding(false)} />}
    </MixFrame>
  );
}

/** The last 60 s of short-term readings, sampled while the panel shows (kept across re-renders, not saved). */
function useShortTermHistory(reading: number | null, tick: number): readonly LoudnessPoint[] {
  const history = useRef<LoudnessPoint[]>([]);
  useEffect(() => {
    history.current = pushReading(history.current, performance.now() / 1000, reading);
  }, [tick, reading]);
  return history.current;
}

export function LoudnessPanel(props: { session: MixerSession }) {
  const { session } = props;
  const tick = session.tick.value;
  const p = session.project.value;
  const master = masterOf(p);
  const targets = p.loudness.targets;
  const [target, setTarget] = useState<string>(targets[0]?.name ?? "");
  const chosen = targets.find((t) => t.name === target) ?? null;
  const reading = session.deps.readLoudness?.(master) ?? null;
  const rows = loudnessRows(reading, chosen);
  const history = useShortTermHistory(reading && Number.isFinite(reading.shortTerm) ? reading.shortTerm : null, tick);
  const line = sparkline(history, performance.now() / 1000, chosen?.integrated ?? null);
  return (
    <MixFrame session={session} class="mx-loudness" label={`Loudness of ${master}`}>
      <div class="mx-loud-tools">
        <span class="mx-cap">BS.1770 / EBU R 128</span>
        {reading?.tainted && <span class="mx-beds warn" title="A solo or Compare changed what the meters heard since the last reset">Monitor changed the reading</span>}
        <span class="mx-spacer" />
        <span class="mx-trlabel">Platform target</span>
        <MixDropdown label="Platform target" value={target} options={targets.map((t) => ({ value: t.name, label: targetOptionText(t) }))} onChange={(v) => { setTarget(v); session.deps.setLoudnessTarget?.(v); }} />
      </div>
      <dl class="mx-loud" aria-label="Readings">
        {rows.map((r) => (
          <div key={r.key} class={`mx-loud-cell${r.verdict === "warn" ? " warn" : r.verdict === "ok" ? " ok" : ""}`} title={r.warn ?? undefined}>
            <dt>{r.label}</dt>
            <dd class="mx-loud-value">{r.value}</dd>
            <dd class={`mx-loud-unit${r.verdict ? ` ${r.verdict}` : ""}`}>{r.note}</dd>
          </div>
        ))}
      </dl>
      <div class="mx-loud-graph">
        <span class="mx-cap">Short-term · last {SHORT_TERM_WINDOW_S} s</span>
        <svg class="mx-spark" viewBox="0 0 600 50" preserveAspectRatio="none" role="img" aria-label={line.points.length > 1 ? `Short-term loudness over the last ${SHORT_TERM_WINDOW_S} seconds` : "No readings yet"}>
          {line.target !== null && <line class="mx-spark-target" x1="0" x2="600" y1={line.target} y2={line.target} />}
          {line.points.length > 1 && <polyline class="mx-spark-line" points={line.points.map(([x, y]) => `${x},${y}`).join(" ")} />}
        </svg>
      </div>
      {!reading && <p class="mx-note">Readings show while the Studio's audio plays: audition a playlist or replay a take.</p>}
    </MixFrame>
  );
}
