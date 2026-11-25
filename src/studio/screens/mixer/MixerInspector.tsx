// The Mixer's Inspector (ADR 0344; the prototype's Inspector): its kind badge and name; for the selected bus its name,
// parent, level (with the automated value it reaches now and Automate), voice limit, bed, colour and VCAs, then its
// effects (the catalogue's bus level; a sidechain's key), its sends to returns, its ducking rules, and the playlists
// that play through it (Used by, linking to Playlists); for a return its output, level and effects; for a VCA its level
// and members. While a snapshot is edited, the level and effect parameters write that snapshot (its overrides are
// listed with Clear). Explanations live in ⓘ tips (spec §1.3). Every change is one undo step of `audio.json`,
// labelled "<what> · <bus>".
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ContextMenu, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { Checkbox } from "../../components/Checkbox";
import { ColourPicker } from "../../components/ColourPicker";
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import { isLabelled } from "../../../engine/audio/parameters";
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
import { automatedParams, automatedSend, levelAutomationDb } from "./boardModel";
import { BRANCH_COLOURS, busColour, defaultBusColour, kindBadge, playlistName, setBusColour, usedBy } from "./busRows";
import { busOf, busPath, kindOf, masterOf, returnOf, setReturnOutput, setVcaMembers } from "./busTree";
import { addDucking, addSend, clearOffset, clearOverride, doubleDucks, editDucking, editEffects, editedSnapshot, editSend, labelOn, levelGhosts, levelLabel, overridesOn, removeDucking, removeSend, setLevel, setMute, shownEffects, shownLevel } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";
import { MixDropdown } from "./MixDropdown";
import { testValueOf } from "./snapshotBlend";
import { automate, DbField, MixFrame } from "./mixerViewParts";
import { allocateBeds, bedModeOf, bedText, seedVoiceLimit, setBed, setVoiceLimit, voiceLimitOf, voiceLimitRange, type BedMode } from "./voicesAndBeds";

const Diamond = (props: { set: boolean; label: string; title?: string; onClick(): void; disabled?: boolean }) => (
  <button class={`studio-icon-button mx-auto${props.set ? " set" : ""}`} aria-label={props.label} title={props.title ?? props.label} disabled={props.disabled} onClick={props.onClick}>
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
  const lanes = p.automation.filter((a) => a.on === name && a.target === "volume");
  const live = lanes.filter((a) => !a.bypass);
  const values = session.testValues.value;
  const auto = levelAutomationDb(p, name, values);
  const drivers = [...new Set(live.map((a) => a.parameter))];
  const driverText = drivers.map((d) => {
    const def = p.parameters.find((q) => q.name === d);
    if (!def) return `${d} (missing)`;
    const now = testValueOf(def, values);
    return `${d} (now ${isLabelled(def) ? (def.labels[Math.round(now)] ?? now) : Math.round(now * 100) / 100})`;
  }).join(", ");
  const commit = (db: number, drag?: boolean) => session.commit(setLevel(session.project.peek(), name, db, session.editing.peek()), levelLabel(session.project.peek(), name, session.editing.peek()), drag);
  return (
    <div class="mx-ilevel">
      <Fader value={value} label="Level" ghosts={levelGhosts(p, name, editing)} disabled={session.readOnly} selected onValue={(db, drag) => commit(db, drag || undefined)} />
      <DbField value={value} label="Level in dB" disabled={session.readOnly} title="Type a level in dB (−60 to +6)" onCommit={(db) => commit(db)} />
      <span class="mx-unit">dB</span>
      {live.length > 0 && <span class="mx-avalue" title={`Driven by ${driverText}`}>→ {formatDb(Math.max(-60, Math.min(6, value + auto)))} dB</span>}
      {kindOf(p, name) !== "vca" && <Diamond set={lanes.length > 0} label={`Automate ${name}'s level`} title={live.length > 0 ? `Driven by ${driverText} · click to edit the curves` : "Curves for the level (driven by a game parameter)"} disabled={session.readOnly} onClick={() => automate(session, name, "volume")} />}
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
        options={[{ value: "inherit", label: master ? "None" : "Inherit", title: master ? `No bus voice cap: only the project's ${p.settings.voices.mixed} mixed voices limit how many play at once` : "Use the limit of the nearest bus above" }, { value: "limit", label: "Limit", title: "Cap this bus and everything under it" }]}
        onChange={(m) => session.commit(setVoiceLimit(session.project.peek(), name, m === "inherit" ? null : seedVoiceLimit(session.project.peek(), name)), label)}
      />
      {bus.voiceLimit !== null ? (
        <span class="mx-inline" title={`Caps this bus and the buses under it`}>
          <input type="number" class="mx-nf" min={lo} max={hi} step={1} value={bus.voiceLimit} aria-label="Voices" disabled={session.readOnly} onChange={(e) => session.commit(setVoiceLimit(session.project.peek(), name, Number((e.target as HTMLInputElement).value)), label)} />
          <span class="mx-unit">voices</span>
        </span>
      ) : v.from ? (
        <span class="mx-ichip" title={`Uses the limit of the nearest bus above: ${v.from}`}>{`${v.limit} · ${v.from}`}</span>
      ) : null}
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
          options={[{ value: "share", label: "Share", title: "Mix distant sounds into the nearest bed above this bus" }, { value: "own", label: "Own", title: "Ask for a bed of its own (wins by priority)" }, { value: "off", label: "Off", title: "Its sounds never go to a bed" }]}
          onChange={(m) => session.commit(setBed(session.project.peek(), name, m), label)}
        />
      )}
      {mode === "own" && (
        <label class="mx-inline" title="When more buses ask for a bed than Max beds allows, the highest priorities win">
          Priority
          <input type="number" class="mx-nf" aria-label="Bed priority" min={BED_PRIORITY_LIMITS[0]} max={BED_PRIORITY_LIMITS[1]} value={bus.bed!.priority} disabled={session.readOnly} onChange={(e) => session.commit(setBed(session.project.peek(), name, "own", Number((e.target as HTMLInputElement).value)), label)} />
        </label>
      )}
      <span class={`mx-ichip${state?.kind === "lost" ? " warn" : ""}`}>{bedText(state, bus.parent === null)}</span>
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
          Parameters save in <strong>{snap.name}</strong>
          <InfoTip text={`Editing ${snap.name}: parameter changes are saved in the snapshot. Adding, removing, reordering or switching effects changes the base mix.`} label="About editing a snapshot's effects" />
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
        note="Runs on everything routed here, all the time: one instance, always running. Use it for mix categories and shared treatment (reverb, ducking, limiting); for one sound or one group, put the effect on its clip or playlist. Inserts run top to bottom, before the fader."
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

/** An add button with a "+▾" look that opens a menu under it (the prototype's `.sbtn` + `.pop`). */
function AddMenu(props: { label: string; title: string; disabled?: boolean; entries: () => MenuEntry[]; menuLabel: string; chevron?: boolean; onDirect?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} class="mx-sbtn" aria-label={props.label} title={props.title} disabled={props.disabled} aria-haspopup={props.onDirect ? undefined : "menu"} aria-expanded={props.onDirect ? undefined : open} onClick={() => (props.onDirect ? props.onDirect() : setOpen(!open))}>
        <Icon name="plus" size={13} />
        {props.chevron !== false && !props.onDirect && <Icon name="chevronDown" size={11} />}
      </button>
      {open && ref.current && <ContextMenu entries={props.entries()} at={ref.current} label={props.menuLabel} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A section's header: its caps caption with an ⓘ tip, and its add button at the right. */
function SectionHead(props: { title: string; tip: string; children?: preact.ComponentChildren }) {
  return (
    <div class="mx-lph">
      <h3 class="mx-cap">{props.title}</h3>
      <InfoTip text={props.tip} label={`About ${props.title.toLowerCase()}`} />
      <span class="mx-spacer" />
      {props.children}
    </div>
  );
}

function Sends(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const bus = busOf(p, name)!;
  const [open, setOpen] = useState<string | null>(null);
  const master = name === masterOf(p);
  const targets = sendTargets(p.returns.map((r) => r.name), name, bus.sends, masterOf(p));
  const free = targets.filter((t) => !t.disabled);
  const label = labelOn("Edit send", name);
  const add = (to: string) => { if (session.commit(addSend(session.project.peek(), name, to), label)) setOpen(to); };
  const addTitle = master ? "Master can't send" : targets.length === 0 ? "No returns yet: add one under Returns in the Buses panel" : free.length === 0 ? (targets.length === 1 ? `Already sends to ${targets[0]!.name} (the only return)` : "Already sends to every return") : free.length === 1 ? `Add a send to ${free[0]!.name}` : "Add a send to a return";
  return (
    <section class="mx-isection" aria-label="Sends">
      <SectionHead title="Sends" tip="Copies of this bus's signal sent to a return (like Reverb), after the fader. The return mixes them and outputs to its bus.">
        <AddMenu
          label="Add send"
          title={addTitle}
          disabled={session.readOnly || master || free.length === 0}
          menuLabel="Send to"
          onDirect={free.length === 1 ? () => add(free[0]!.name) : undefined}
          entries={() => [{ kind: "group", label: "Send to" }, ...targets.map((t) => ({ id: t.name, label: `→ ${t.name}`, disabled: !!t.disabled, note: t.disabled ?? undefined, run: () => add(t.name) }))]}
        />
      </SectionHead>
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
      {bus.sends.length === 0 && <p class="mx-note">{master ? "Master can't send." : "No sends. Add one with +."}</p>}
    </section>
  );
}

function Ducking(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const [open, setOpen] = useState<number | null>(null);
  const rules = p.ducking.map((r, i) => ({ r, i })).filter(({ r }) => r.target === name);
  const names = [...p.buses.map((b) => b.name), ...p.returns.map((r) => r.name)];
  const parentOf = (n: string) => busOf(p, n)?.parent ?? null;
  const options = duckTriggerOptions(names, name, p.ducking, parentOf, undefined, masterOf(p));
  const lint = doubleDucks(p).filter((d) => d.target === name);
  const label = labelOn("Edit ducking", name);
  if (name === masterOf(p)) return null;
  return (
    <section class="mx-isection" aria-label="Ducking">
      <SectionHead title="Ducking" tip={`Turn ${name} down while another bus plays`}>
        <AddMenu
          label="Add ducking"
          title="Duck when another bus plays"
          disabled={session.readOnly}
          menuLabel="Duck when this plays"
          entries={() => [{ kind: "group", label: "Duck when this plays" }, ...options.map((o) => ({ id: o.name, label: o.name, disabled: !!o.disabled, note: o.disabled ?? undefined, run: () => { if (session.commit(addDucking(session.project.peek(), name, o.name), label)) setOpen(session.project.peek().ducking.length - 1); } }))]}
        />
      </SectionHead>
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
      {rules.length === 0 && <p class="mx-note">No ducking. Add a bus with +.</p>}
    </section>
  );
}

/** The playlists that play through `name` (spec §4.3.4 "Used by"): up to 4 links to Playlists, then how many more. */
function UsedBySection(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const usersOf = session.deps.usersOf;
  if (!usersOf) return null;
  const u = usedBy(p, name, usersOf, isPlaylistPath);
  const shown = u.direct.slice(0, 4);
  const more = u.direct.length - shown.length;
  return (
    <section class="mx-isection" aria-label="Used by">
      <SectionHead title="Used by" tip="Playlists and sequences routed here. Open one in Playlists to change where it routes." />
      {shown.length === 0 && u.inside === 0 && <p class="mx-note">No playlists route here directly.</p>}
      {shown.length > 0 && (
        <ul class="mx-usedby">
          {shown.map((f) => (
            <li key={f}>
              <button class="mx-link" title={`Open ${f} in Playlists`} disabled={!session.deps.openFile} onClick={() => session.deps.openFile?.(f)}>{playlistName(f)}</button>
            </li>
          ))}
        </ul>
      )}
      {(more > 0 || u.inside > 0) && (
        <p class="mx-note">{[more > 0 ? `+${more} more` : "", u.inside > 0 ? `${u.inside} more via buses inside` : ""].filter(Boolean).join(" · ")}</p>
      )}
    </section>
  );
}

/** The bus's colour (spec §2.9): the branch colours as swatches; Reset goes back to its branch's. */
function ColourField(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const bus = busOf(p, name)!;
  const label = labelOn("Bus colour", name);
  return (
    <div class="mx-icolour">
      <ColourPicker
        value={busColour(p, name)}
        label={`${name} colour`}
        presets={BRANCH_COLOURS.map((c, i) => ({ name: ["Cyan", "Green", "Amber", "Badge", "Link", "Red"][i] ?? c, color: c }))}
        disabled={session.readOnly}
        onChange={(c) => session.commit(setBusColour(session.project.peek(), name, c === defaultBusColour(session.project.peek(), name) ? null : c), label)}
      />
      {bus.colour !== undefined && <button class="mx-link" disabled={session.readOnly} title="Back to its branch's colour" onClick={() => session.commit(setBusColour(session.project.peek(), name, null), label)}>Reset</button>}
    </div>
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
      <Field label="Parent">{bus.parent === null ? <span class="mx-faint">— (the output)</span> : <span title="Drag the bus in Routing to change its parent">{busPath(p, bus.parent)}</span>}</Field>
      <LevelRows session={session} name={name} />
      <Field label="Mute">
        <button class={`mx-toggle mute${bus.mute ? " on" : ""}`} aria-pressed={bus.mute} aria-label="Mute" title={bus.mute ? "Muted (saved): click to unmute" : "Mute (saved in the mix)"} disabled={session.readOnly} onClick={() => session.commit(setMute(session.project.peek(), name, !bus.mute), labelOn(bus.mute ? "Unmute" : "Mute", name))}>M</button>
      </Field>
      <Field label="Voice limit"><VoiceField session={session} name={name} /></Field>
      <Field label="Bed"><BedField session={session} name={name} /></Field>
      <Field label="Colour"><ColourField session={session} name={name} /></Field>
      <Field label="VCAs">{vcas.length > 0 ? vcas.join(", ") : <span class="mx-faint">None</span>}</Field>
      <Effects session={session} name={name} />
      <Sends session={session} name={name} />
      <Ducking session={session} name={name} />
      <UsedBySection session={session} name={name} />
    </>
  );
}

function ReturnInspector(props: { session: MixerSession; name: string }) {
  const { session, name } = props;
  const p = session.project.value;
  const ret = returnOf(p, name)!;
  const feeders = p.buses.filter((b) => b.sends.some((x) => x.to === name));
  return (
    <>
      <Field label="Name"><NameField session={session} name={name} locked={false} /></Field>
      <Field label="Fed by">{feeders.length > 0 ? feeders.map((b) => `${b.name} (${formatDb(b.sends.find((x) => x.to === name)!.levelDb)} dB)`).join(", ") : <span class="mx-faint">No sends yet</span>}</Field>
      <Field label="Output">
        <MixDropdown label="Output" value={ret.output} disabled={session.readOnly} options={p.buses.map((b) => ({ value: b.name, label: busPath(p, b.name) }))} onChange={(v) => session.commit(setReturnOutput(session.project.peek(), name, v), labelOn("Return output", name))} />
      </Field>
      <LevelRows session={session} name={name} />
      <Field label="Mute">
        <button class={`mx-toggle mute${ret.mute ? " on" : ""}`} aria-pressed={ret.mute} aria-label="Mute" title={ret.mute ? "Muted (saved): click to unmute" : "Mute (saved in the mix)"} disabled={session.readOnly} onClick={() => session.commit(setMute(session.project.peek(), name, !ret.mute), labelOn(ret.mute ? "Unmute" : "Mute", name))}>M</button>
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
      <Field label="Name"><NameField session={session} name={name} locked={false} /></Field>
      <LevelRows session={session} name={name} />
      <section class="mx-isection" aria-label="Members">
        <SectionHead title="Members" tip="Adds its level to these buses and every bus inside them. Their faders stay where you set them; a violet tick on each shows where the VCA lands it, and meters follow. No audio passes through, so routing is unchanged." />
        <div class="mx-members-list" role="group" aria-label="Members">
          {p.buses.filter((b) => b.parent !== null).map((b) => (
            <Checkbox key={b.name} checked={vca.members.includes(b.name)} disabled={session.readOnly} label={busPath(p, b.name)} onChange={(on) => toggle(b.name, on)} />
          ))}
        </div>
      </section>
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
        <span class={`mx-kind${kind === "vca" ? " vca" : ""}`}>{kindBadge(p, name)}</span>
        <span class="mx-ititle-name">{name}</span>
        {kind === "return" && <InfoTip text="A return is fed by sends from buses and outputs to its bus. It isn't a child of the buses that feed it: they keep their own routing." label="About returns" />}
        {kind === "vca" && <InfoTip text="A VCA offsets its member buses and everything under them. No audio passes through it; the members' faders stay where they are." label="About VCAs" />}
      </h2>
      {kind === "bus" && <BusInspector session={session} name={name} />}
      {kind === "return" && <ReturnInspector session={session} name={name} />}
      {kind === "vca" && <VcaInspector session={session} name={name} />}
      {name !== masterOf(p) && (
        <div class="mx-delete">
          <button class="mx-danger-quiet" disabled={session.readOnly} title={kind === "bus" ? "Its children move up to its parent" : undefined} onClick={() => void session.remove(name)}><Icon name="trash" /> Delete {kind === "vca" ? "VCA" : kind}…</button>
        </div>
      )}
    </MixFrame>
  );
}
