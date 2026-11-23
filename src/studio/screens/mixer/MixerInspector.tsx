// The Mixer's Inspector (ADR 0344; the prototype's Inspector): for the selected bus its name, parent, level (with
// Automate ◆), voice limit, bed and VCAs, then its effects (the catalogue's bus level; a sidechain's key), its sends to
// returns and its ducking rules; for a return its output, level and effects; for a VCA its level and members. While a
// snapshot is edited, the level and effect parameters write that snapshot (its overrides are listed with Clear).
// Every change is one undo step of `audio.json`, labelled "<what> · <bus>".
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import { MIX_LIMITS } from "../../../engine/audio/project/format";
import { BED_PRIORITY_LIMITS } from "../../../engine/audio/settings";
import { DuckRow } from "../../components/DuckRow";
import { EffectChain } from "../../components/EffectChain";
import { Fader } from "../../components/Fader";
import { formatDb } from "../../components/faderModel";
import { Icon } from "../../components/Icon";
import { SendRow } from "../../components/SendRow";
import { keyBusOptions } from "../../components/effectChainModel";
import { duckTriggerOptions, sendTargets } from "../../components/mixRowsModel";
import { automatedParams, automatedSend } from "./boardModel";
import { busOf, busPath, kindOf, masterOf, returnOf, setReturnOutput, setVcaMembers } from "./busTree";
import { addDucking, addSend, clearOffset, clearOverride, doubleDucks, editDucking, editEffects, editedSnapshot, editSend, labelOn, levelGhosts, levelLabel, overridesOn, removeDucking, removeSend, setLevel, setMute, shownEffects, shownLevel } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { automate, DbField, MixFrame } from "./mixerViewParts";
import { allocateBeds, bedModeOf, bedText, seedVoiceLimit, setBed, setVoiceLimit, voiceLimitOf, voiceLimitRange, type BedMode } from "./voicesAndBeds";

const Diamond = (props: { set: boolean; label: string; onClick(): void; disabled?: boolean }) => (
  <button class={`studio-icon-button mx-auto${props.set ? " set" : ""}`} aria-label={props.label} title={props.label} disabled={props.disabled} onClick={props.onClick}>
    <Icon name="automate" size={14} />
  </button>
);

function Field(props: { label: string; children: JSX.Element | JSX.Element[] | string | null; id?: string }) {
  return (
    <div class="mx-ifield">
      <span class="mx-ilabel" id={props.id}>{props.label}</span>
      <div class="mx-ivalue">{props.children}</div>
    </div>
  );
}

function NameField(props: { session: MixerSession; name: string; locked: boolean }) {
  const [text, setText] = useState(props.name);
  useEffect(() => setText(props.name), [props.name]);
  const done = () => {
    if (text === props.name) return;
    void props.session.rename(props.name, text).then((ok) => { if (!ok) setText(props.name); });
  };
  return (
    <input
      class="mx-iname"
      value={text}
      aria-label="Name"
      disabled={props.locked || props.session.readOnly}
      title={props.locked ? "Master keeps its name" : "Names are unique across buses, returns and VCAs; renaming updates what routes here"}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onBlur={done}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") setText(props.name); }}
    />
  );
}

function LevelField(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const value = shownLevel(p, name, editing);
  const hasAuto = p.automation.some((a) => a.on === name && a.target === "volume");
  const commit = (db: number, drag?: boolean) => session.commit(setLevel(session.project.peek(), name, db, session.editing.peek()), levelLabel(session.project.peek(), name, session.editing.peek()), drag);
  return (
    <div class="mx-ilevel">
      <Fader value={value} label={`${name} level`} ghosts={levelGhosts(p, name, editing)} disabled={session.readOnly} onValue={(db, drag) => commit(db, drag || undefined)} />
      <DbField value={value} label={`${name} level in dB`} disabled={session.readOnly} onCommit={(db) => commit(db)} />
      {kindOf(p, name) !== "vca" && <Diamond set={hasAuto} label={`Automate ${name}'s level`} disabled={session.readOnly} onClick={() => automate(session, name, "volume")} />}
    </div>
  );
}

/** The Level row: the level, then (while a snapshot is edited and offsets `name`) the offset on a row of its own, to 0.1 dB. */
function LevelRows(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const snap = editedSnapshot(session.project.value, session.editing.value);
  const offset = snap?.buses[name];
  return (
    <>
      <Field label="Level"><LevelField session={session} name={name} /></Field>
      {snap && offset !== undefined && (
        <p class="mx-inote">
          {snap.name}: {formatDb(offset)} dB on the base level.{" "}
          <button class="mx-link" disabled={session.readOnly} onClick={() => session.commit(clearOffset(session.project.peek(), snap.name, name), labelOn("Clear offset", name))}>Clear offset</button>
        </p>
      )}
    </>
  );
}

function VoiceField(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const bus = busOf(p, name)!;
  const v = voiceLimitOf(p, name);
  const master = bus.parent === null;
  const [lo, hi] = voiceLimitRange(p);
  const label = labelOn("Voice limit", name);
  return (
    <div class="mx-ivoices">
      <SegmentedControl
        label="Voice limit"
        size="small"
        value={bus.voiceLimit === null ? "inherit" : "limit"}
        options={[{ value: "inherit", label: master ? "None" : "Inherit" }, { value: "limit", label: "Limit" }]}
        onChange={(m) => session.commit(setVoiceLimit(session.project.peek(), name, m === "inherit" ? null : seedVoiceLimit(session.project.peek(), name)), label)}
      />
      {bus.voiceLimit !== null ? (
        <input type="number" min={lo} max={hi} step={1} value={bus.voiceLimit} aria-label="Voices" disabled={session.readOnly} onChange={(e) => session.commit(setVoiceLimit(session.project.peek(), name, Number((e.target as HTMLInputElement).value)), label)} />
      ) : (
        <span class="kit-chip" title={v.from ? `Shares ${v.from}'s limit` : "No limit above it"}>{v.from ? `↑ ${v.limit} from ${v.from}` : "∞ no limit"}</span>
      )}
    </div>
  );
}

function BedField(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const bus = busOf(p, name)!;
  const state = allocateBeds(p).state.get(name);
  const mode = bedModeOf(bus);
  const label = labelOn("Ambisonic bed", name);
  return (
    <div class="mx-ibed">
      {bus.parent !== null && (
        <SegmentedControl<BedMode>
          label="Bed"
          size="small"
          value={mode}
          options={[{ value: "share", label: "Share", title: "Distant sounds mix into the nearest bed above" }, { value: "own", label: "Own", title: "Ask for a bed of its own (by priority)" }, { value: "off", label: "Off", title: "Its sounds never go to a bed" }]}
          onChange={(m) => session.commit(setBed(session.project.peek(), name, m), label)}
        />
      )}
      {mode === "own" && (
        <label class="mx-inline">
          Priority
          <input type="number" min={BED_PRIORITY_LIMITS[0]} max={BED_PRIORITY_LIMITS[1]} value={bus.bed!.priority} disabled={session.readOnly} onChange={(e) => session.commit(setBed(session.project.peek(), name, "own", Number((e.target as HTMLInputElement).value)), label)} />
        </label>
      )}
      <span class={`kit-chip${state?.kind === "lost" ? " warn" : ""}`}>{bedText(state)}</span>
    </div>
  );
}

function Effects(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const editing = session.editing.value;
  const snap = editedSnapshot(p, editing);
  const effects = shownEffects(p, name, editing);
  const overrides = snap ? overridesOn(p, snap.name, name) : [];
  const owner = busOf(p, name) ?? returnOf(p, name);
  const label = labelOn("Edit effects", name);
  return (
    <section class="mx-isection" aria-label="Bus effects">
      {snap && (
        <p class="mx-snapnote" role="note">
          Editing <strong>{snap.name}</strong>: parameter changes are saved in the snapshot. Adding, removing, reordering or switching effects changes the base mix.
        </p>
      )}
      <EffectChain
        effects={effects}
        level="bus"
        limit={MIX_LIMITS.effectsPerOwner}
        ownBus={name}
        keyBuses={keyBusOptions(p.buses.map((b) => b.name), name, masterOf(p))}
        automated={automatedParams(p, name, session.testValues.value)}
        readOnly={session.readOnly}
        title={kindOf(p, name) === "return" ? "Return effects" : "Bus effects"}
        note="Inserts run top to bottom, before the fader."
        onEdit={(result, _what, drag) => session.commit(editEffects(session.project.peek(), name, result, session.editing.peek()), label, drag)}
        onAutomate={(id) => automate(session, name, `fx:${id}`)}
      />
      {overrides.length > 0 && snap && (
        <div class="mx-overrides" role="group" aria-label={`Overrides in ${snap.name}`}>
          <span class="mx-ilabel">Overridden in {snap.name}</span>
          {overrides.map((o) => {
            const e = owner?.effects.find((x) => x.id === o.id);
            const spec = e ? effectSpec(e.type).params.find((q) => q.name === o.param) : undefined;
            return (
              <div key={`${o.id}.${o.param}`} class="mx-override">
                <span class="mx-override-mark" aria-hidden="true">●</span>
                <span>{e ? effectSpec(e.type).label : o.id} · {spec?.label ?? o.param}: {Math.round(o.value * 100) / 100}{spec?.unit ? ` ${spec.unit}` : ""}</span>
                <span class="mx-faint">base {e?.params[o.param] ?? spec?.default ?? "—"}</span>
                <button class="mx-link" disabled={session.readOnly} onClick={() => session.commit(clearOverride(session.project.peek(), snap.name, name, o.id, o.param), labelOn("Clear override", name))}>Clear override</button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Sends(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const bus = busOf(p, name)!;
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const targets = sendTargets(p.returns.map((r) => r.name), name, bus.sends, masterOf(p));
  const label = labelOn("Edit send", name);
  return (
    <section class="mx-isection" aria-label="Sends">
      <h3 class="mx-ihead">
        Sends <span class="mx-faint">post-fader, to returns</span>
        <button class="mx-tool" disabled={session.readOnly || name === masterOf(p) || targets.every((t) => t.disabled)} onClick={() => setAdding(!adding)} aria-expanded={adding}><Icon name="plus" /> Send</button>
      </h3>
      {adding && (
        <div class="mx-pick" role="group" aria-label="Send to">
          {targets.length === 0 && <span class="mx-note">No returns yet: add one under VCAs in the Buses panel.</span>}
          {targets.map((t) => (
            <button key={t.name} disabled={!!t.disabled} title={t.disabled ?? undefined} onClick={() => { setAdding(false); if (session.commit(addSend(session.project.peek(), name, t.name), label)) setOpen(t.name); }}>
              → {t.name}{t.disabled ? ` (${t.disabled})` : ""}
            </button>
          ))}
        </div>
      )}
      {bus.sends.map((s) => (
        <SendRow
          key={s.to}
          send={s}
          open={open === s.to}
          automated={automatedSend(p, name, s.to, session.testValues.value)}
          readOnly={session.readOnly}
          onOpen={(o) => setOpen(o ? s.to : null)}
          onEdit={(result, _what, drag) => session.commit(editSend(session.project.peek(), name, result), label, drag)}
          onRemove={() => session.commit(removeSend(session.project.peek(), name, s.to), label)}
          onAutomate={() => automate(session, name, `send:${s.to}`)}
        />
      ))}
      {bus.sends.length === 0 && name !== masterOf(p) && <p class="mx-note">No sends.</p>}
    </section>
  );
}

function Ducking(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const rules = p.ducking.map((r, i) => ({ r, i })).filter(({ r }) => r.target === name);
  const names = [...p.buses.map((b) => b.name), ...p.returns.map((r) => r.name)];
  const parentOf = (n: string) => busOf(p, n)?.parent ?? null;
  const options = duckTriggerOptions(names, name, p.ducking, parentOf, undefined, masterOf(p));
  const lint = doubleDucks(p).filter((d) => d.target === name);
  const label = labelOn("Edit ducking", name);
  if (name === masterOf(p)) return null;
  return (
    <section class="mx-isection" aria-label="Ducking">
      <h3 class="mx-ihead">
        Ducking <span class="mx-faint">lowers {name} while another bus plays</span>
        <button class="mx-tool" disabled={session.readOnly} onClick={() => setAdding(!adding)} aria-expanded={adding}><Icon name="plus" /> Duck</button>
      </h3>
      {adding && (
        <div class="mx-pick" role="group" aria-label="Duck when this plays">
          <span class="mx-ilabel">Duck when this plays</span>
          {options.map((o) => (
            <button key={o.name} disabled={!!o.disabled} title={o.disabled ?? undefined} onClick={() => { setAdding(false); if (session.commit(addDucking(session.project.peek(), name, o.name), label)) setOpen(session.project.peek().ducking.length - 1); }}>
              {o.name}{o.disabled ? ` (${o.disabled})` : ""}
            </button>
          ))}
        </div>
      )}
      {lint.map((d) => (
        <p key={d.trigger} class="mx-warn" role="note">{d.trigger} ducks {name} twice: by a rule here and by a sidechain compressor keyed on it. Keep one.</p>
      ))}
      {rules.map(({ r, i }) => (
        <DuckRow
          key={`${r.trigger}-${i}`}
          rule={r}
          open={open === i}
          triggers={duckTriggerOptions(names, name, p.ducking, parentOf, r.trigger, masterOf(p))}
          readOnly={session.readOnly}
          onOpen={(o) => setOpen(o ? i : null)}
          onEdit={(result, _what, drag) => session.commit(editDucking(session.project.peek(), i, result), label, drag)}
          onRemove={() => session.commit(removeDucking(session.project.peek(), i), label)}
        />
      ))}
      {rules.length === 0 && <p class="mx-note">Nothing ducks it.</p>}
    </section>
  );
}

function BusInspector(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const bus = busOf(p, name)!;
  const vcas = p.vcas.filter((v) => v.members.includes(name)).map((v) => v.name);
  return (
    <>
      <Field label="Name"><NameField session={session} name={name} locked={bus.parent === null} /></Field>
      <Field label="Parent">{bus.parent === null ? "— (the master bus)" : <span title="Drag the bus in the Buses panel to re-route it">{busPath(p, bus.parent)}</span>}</Field>
      <LevelRows session={session} name={name} />
      <Field label="Mute">
        <button class={`mx-toggle mute${bus.mute ? " on" : ""}`} aria-pressed={bus.mute} disabled={session.readOnly} onClick={() => session.commit(setMute(session.project.peek(), name, !bus.mute), labelOn(bus.mute ? "Unmute" : "Mute", name))}>M</button>
      </Field>
      <Field label="Voice limit"><VoiceField session={session} name={name} /></Field>
      <Field label="Bed"><BedField session={session} name={name} /></Field>
      <Field label="VCAs">{vcas.length > 0 ? vcas.join(", ") : <span class="mx-faint">none</span>}</Field>
      <Effects session={session} name={name} />
      {bus.parent !== null && <Sends session={session} name={name} />}
      <Ducking session={session} name={name} />
    </>
  );
}

function ReturnInspector(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const ret = returnOf(p, name)!;
  return (
    <>
      <p class="mx-note">A return is fed only by buses' post-fader sends and isn't a child of the buses that feed it.</p>
      <Field label="Name"><NameField session={session} name={name} locked={false} /></Field>
      <Field label="Output">
        <select aria-label="Output" value={ret.output} disabled={session.readOnly} onChange={(e) => session.commit(setReturnOutput(session.project.peek(), name, (e.target as HTMLSelectElement).value), labelOn("Return output", name))}>
          {p.buses.map((b) => <option key={b.name} value={b.name}>{busPath(p, b.name)}</option>)}
        </select>
      </Field>
      <LevelRows session={session} name={name} />
      <Field label="Mute">
        <button class={`mx-toggle mute${ret.mute ? " on" : ""}`} aria-pressed={ret.mute} disabled={session.readOnly} onClick={() => session.commit(setMute(session.project.peek(), name, !ret.mute), labelOn(ret.mute ? "Unmute" : "Mute", name))}>M</button>
      </Field>
      <Effects session={session} name={name} />
      <Ducking session={session} name={name} />
    </>
  );
}

function VcaInspector(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const vca = p.vcas.find((v) => v.name === name)!;
  const toggle = (bus: string, on: boolean) => session.commit(setVcaMembers(session.project.peek(), name, on ? [...vca.members, bus] : vca.members.filter((m) => m !== bus)), labelOn("VCA members", name));
  return (
    <>
      <p class="mx-note">A VCA offsets its member buses and everything under them. No audio passes through it; the members' faders stay where they are.</p>
      <Field label="Name"><NameField session={session} name={name} locked={false} /></Field>
      <LevelRows session={session} name={name} />
      <fieldset class="mx-members-list">
        <legend>Members</legend>
        {p.buses.filter((b) => b.parent !== null).map((b) => (
          <label key={b.name}>
            <input type="checkbox" checked={vca.members.includes(b.name)} disabled={session.readOnly} onChange={(e) => toggle(b.name, (e.target as HTMLInputElement).checked)} /> {busPath(p, b.name)}
          </label>
        ))}
      </fieldset>
    </>
  );
}

export function MixerInspector(props: { session: MixerSession }) {
  const { session } = props;
  const p = session.project.value;
  const name = session.selected.value;
  const kind = kindOf(p, name);
  return (
    <MixFrame session={session} class="mx-inspector" label={`Inspector: ${name}`}>
      <h2 class="mx-ititle">
        {name} <span class="mx-faint">{kind === "bus" ? (name === masterOf(p) ? "master bus" : "bus") : kind}</span>
      </h2>
      {kind === "bus" && <BusInspector session={session} name={name} />}
      {kind === "return" && <ReturnInspector session={session} name={name} />}
      {kind === "vca" && <VcaInspector session={session} name={name} />}
      {name !== masterOf(p) && (
        <div class="mx-delete">
          <button class="danger" disabled={session.readOnly} onClick={() => void session.remove(name)}><Icon name="trash" /> Delete {kind}…</button>
        </div>
      )}
    </MixFrame>
  );
}
