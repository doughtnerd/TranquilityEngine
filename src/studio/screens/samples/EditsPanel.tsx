// The Edits panel, "Sample effects" (spec §4.1.7, ADR 0342, 0345 level "sample"; the prototype's chain): a header with
// the caption and its tooltip, Add effect (a searchable menu by category, previewing the hovered effect on the
// waveform), Freeze, Flatten and the render chip (Source only / Rebuilding… / Cached / Frozen, its tooltip naming the
// cache key and size). Then the chain in processing order: the locked Source root, the locked Trim and Closed gaps
// rows, the effect cards (caret, name, a summary, Automate, bypass, a state chip, ↑ ↓ ×; collapsed by default, expanding
// to a slider with a typed field per parameter), and Normalize last. Rows take ↑ ↓ Home End, Alt+↑↓ to reorder, Enter
// to open, Delete to remove. Every change is one step (a slider on release).
//
// Flatten renders the chain and the normalize gain into `<name>.flat<n>.wav` beside the source and points the sample at
// it (`sample.source`, one undoable step); the Source version menu lists it as F1 and goes back to the source. Freeze
// keeps the current render as fixed audio: the chain locks until it's unfrozen. Automate opens the shared curve editor
// on an effect's parameters over sample time (`sampleAutomation.ts`, D23).
import { useRef, useState } from "preact/hooks";
import { allowedAt, effectParamValue, effectSpec, effectTypesAt } from "../../../engine/audio/effects/catalogue";
import type { Effect, EffectType } from "../../../engine/audio/effects/types";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { hasRenderableEdits } from "../../../engine/audio/sample/sampleRender";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { Panel } from "../../../editor/ui/panel/Panel";
import { usePopover } from "../../../editor/ui/popover";
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import { Icon } from "../../components/Icon";
import { SliderField } from "../../components/SliderField";
import { formatTime } from "../../components/timeRulerModel";
import { toasts } from "../../shell/studioServices";
import { effectCategories, effectEdits, effectSummary, freezeEdit, searchEffects } from "./sampleEffects";
import { flattenSample, renderPathOf } from "./sampleFlatten";
import { SampleIcon } from "./sampleIcons";
import { nameOf, shortLength } from "./sampleLibrary";
import { previewOf } from "./samplePreview";
import { bytesOf, lengthOf, pcmOf, peaksOf, type SampleSession } from "./sampleSession";
import { levelLanes, waveformFromPeaks } from "../../../editor/ui/curves/waveBackdrop";
import { applyAutomationResult, automatedCount, automationDialog } from "./sampleAutomation";
import { normalizeGainText, normalizeTargetText, type SampleEdit } from "./sampleEditing";
import { abSource, fxFocus, fxPreview, openSession, select, timeFormat } from "./samplesState";
import { removedSeconds, trimOf } from "./sampleTime";

/** Open the curve editor on effect `f`'s parameters over the sample (one step on Apply). */
function automate(session: SampleSession, f: Effect, commit: (r: SampleEdit) => void): void {
  const e = session.edits.peek();
  const spec = automationDialog(e, f.id, lengthOf(session.project, session.source.peek()) ?? 1);
  if (!spec) return;
  // The sample's waveform behind the curves; the brighter shape follows the effect's level lanes (UI pass CU3).
  const peaks = peaksOf(session.project, session.source.peek());
  openCurveEditorDialog(document, {
    ...spec,
    waveform: peaks ? waveformFromPeaks(peaks, { levelLanes: levelLanes(spec.lanes) }) : undefined,
    title: "Time curves",
    target: effectSpec(f.type).label,
    context: `${nameOf(session.path)} · ${effectSpec(f.type).label} · automation over the sample's time (rendered into the audio)`,
    onCancel: () => {},
    onApply(result) {
      const r = applyAutomationResult(session.edits.peek(), f.id, result);
      if (r) commit(r);
    },
  });
}

/** Move focus between the chain's rows (↑ ↓ Home End). */
function focusRow(from: HTMLElement, to: "up" | "down" | "first" | "last"): void {
  const rows = [...(from.closest(".smp-chain")?.querySelectorAll<HTMLElement>(".smp-fxr-head") ?? [])];
  const i = rows.indexOf(from);
  const j = to === "first" ? 0 : to === "last" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (to === "down" ? 1 : -1)));
  rows[j]?.focus();
}

function EffectRow(props: { f: Effect; e: SampleEdits; first: boolean; last: boolean; ro: boolean; open: boolean; session: SampleSession; onOpen(open: boolean): void; commit(r: SampleEdit, coalesce?: boolean): void }) {
  const { f, e, commit } = props;
  const spec = effectSpec(f.type);
  const frozen = e.frozen;
  const ro = props.ro || frozen;
  const misplaced = !allowedAt(f.type, "sample");
  const lanes = automatedCount(e, f.id);
  const focused = fxFocus.value === f.id;
  const state = frozen ? "Frozen" : f.on ? "Rendered" : "Bypassed";
  return (
    <li class={`smp-fxr${f.on ? "" : " off"}${props.open || focused ? " sel" : ""}`} onPointerEnter={() => (fxFocus.value = f.id)} onPointerLeave={() => fxFocus.value === f.id && (fxFocus.value = null)}>
      <div
        class="smp-fxr-head"
        tabIndex={0}
        role="button"
        aria-expanded={props.open}
        aria-label={`${spec.label}${f.on ? "" : " (bypassed)"}`}
        title={`${spec.label} ${spec.version} · ${effectSummary(f)} · baked into the cached render: no CPU at runtime · click for settings`}
        onClick={(ev) => !(ev.target as HTMLElement).closest("button, input") && props.onOpen(!props.open)}
        onKeyDown={(ev) => {
          const el = ev.currentTarget as HTMLElement;
          if (ev.target !== el) return;
          if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            if (ev.altKey && !ro) {
              commit(effectEdits.move(e, f.id, ev.key === "ArrowUp" ? -1 : 1));
              queueMicrotask(() => el.focus());
            } else focusRow(el, ev.key === "ArrowDown" ? "down" : "up");
          } else if (ev.key === "Home" || ev.key === "End") {
            ev.preventDefault();
            focusRow(el, ev.key === "Home" ? "first" : "last");
          } else if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            props.onOpen(!props.open);
          } else if ((ev.key === "Delete" || ev.key === "Backspace") && !ro) {
            ev.preventDefault();
            commit(effectEdits.remove(e, f.id));
            toasts.show({ text: `Removed ${spec.label} · Ctrl+Z brings it back`, undo: () => props.session.undo() });
          }
        }}
      >
        <span class="smp-car" aria-hidden="true">{props.open ? "▾" : "▸"}</span>
        <input type="checkbox" checked={f.on} disabled={ro} aria-label={`${spec.label} on`} title={f.on ? "Bypass it" : "Turn it on"} onChange={() => commit(effectEdits.bypass(e, f.id))} />
        <b class="smp-fx-name">{spec.label}</b>
        <span class="smp-muted smp-ellipsis smp-fx-sum">{effectSummary(f)}{lanes > 0 ? " · automated" : ""}</span>
        {misplaced && <Chip tone="warning" title="This effect can't run baked into a sample; move it to a clip, playlist or bus">Not at sample level</Chip>}
        <Chip tone={frozen ? "neutral" : f.on ? "success" : "neutral"} title={frozen ? "The render is kept as fixed audio" : f.on ? "In the render" : "Left out of the render"}>{state}</Chip>
        <span class="smp-fx-tools">
          <button type="button" class={`smp-ibtn smp-plain${lanes > 0 ? " on" : ""}`} aria-label={`Automate ${spec.label}`} title={`Automate ${spec.label} over the sample's time: on/off and its parameters · baked into the render, so game parameters can't drive it`} disabled={ro} onClick={() => automate(props.session, f, commit)}>
            <Icon name="automate" size={14} />
          </button>
          <button type="button" class="smp-ibtn smp-plain" aria-label={`Move ${spec.label} up`} title="Move up (Alt+↑)" disabled={ro || props.first} onClick={() => commit(effectEdits.move(e, f.id, -1))}><Icon name="chevronUp" size={14} /></button>
          <button type="button" class="smp-ibtn smp-plain" aria-label={`Move ${spec.label} down`} title="Move down (Alt+↓)" disabled={ro || props.last} onClick={() => commit(effectEdits.move(e, f.id, 1))}><Icon name="chevronDown" size={14} /></button>
          <button type="button" class="smp-ibtn smp-plain" aria-label={`Remove ${spec.label}`} title="Remove (Del) · Undo brings it back" disabled={ro} onClick={() => commit(effectEdits.remove(e, f.id))}><Icon name="close" size={14} /></button>
        </span>
      </div>
      {props.open && spec.params.length > 0 && (
        <div class="smp-tv">
          {spec.params.map((p) => (
            <SliderField key={p.name} label={p.label} value={effectParamValue(f, p.name) ?? p.default} min={p.min} max={p.max} step={p.step} unit={p.unit} scale={p.scale} default={p.default} disabled={ro}
              title={frozen ? "Unfreeze to change it" : undefined}
              onValue={(v, live) => commit(effectEdits.param(session().edits.peek(), f.id, p.name, v), live)} />
          ))}
        </div>
      )}
    </li>
  );
}

const session = () => openSession.peek()!;

/** Add effect ▾: search, categories with counts and side menus, flat results when typing; hovering previews it. */
function AddEffect(props: { disabled: boolean; why?: string; onAdd(type: EffectType): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setQuery("");
    setCat(null);
    fxPreview.value = null;
  };
  usePopover(pop, open, { anchor: button.current, inside: [button], onDismiss: close });
  const available = effectTypesAt("sample");
  const cats = effectCategories(available);
  const found = query.trim() ? searchEffects(available, query) : null;
  const add = (t: EffectType) => {
    close();
    props.onAdd(t);
  };
  const item = (t: EffectType, note: string | null, i: number) => (
    <button key={t} type="button" role="menuitem" class={`smp-tci${i === hi ? " hi" : ""}`} onPointerEnter={() => ((fxPreview.value = t), setHi(i))} onPointerLeave={() => (fxPreview.value = null)} onFocus={() => (fxPreview.value = t)} onClick={() => add(t)}
      title={`${effectSpec(t).label} ${effectSpec(t).version} · hover to preview it on the waveform`}>
      <span class="smp-tci-label">{effectSpec(t).label}</span>
      {note && <span class="smp-tci-note">{note}</span>}
    </button>
  );
  const sub = cat ? cats.find((c) => c.name === cat) : null;
  return (
    <>
      <button ref={button} type="button" class="smp-sbtn smp-strong" aria-haspopup="menu" aria-expanded={open} aria-label="Add effect" title={props.why ?? "Add an effect: baked into the sample (no runtime cost)"} disabled={props.disabled} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="plus" size={13} />
        <SampleIcon name="caret" size={9} />
      </button>
      {open && (
        <FloatingPortal>
          <div ref={pop} class="smp-popover smp-snm smp-fxm" role="menu" aria-label="Add effect" data-keeps-history-focus=""
            onKeyDown={(ev) => {
              const list = found ? found.map((x) => x.type) : sub ? sub.types : [];
              if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                ev.preventDefault();
                const n = found ? list.length : sub ? list.length : cats.length;
                setHi((h) => (n ? (h + (ev.key === "ArrowDown" ? 1 : -1) + n) % n : 0));
                if (list.length) fxPreview.value = list[(hi + (ev.key === "ArrowDown" ? 1 : -1) + list.length) % list.length] ?? null;
              } else if (ev.key === "ArrowRight" && !found && !sub) {
                ev.preventDefault();
                setCat(cats[hi]?.name ?? null);
                setHi(0);
              } else if (ev.key === "ArrowLeft" && sub) {
                ev.preventDefault();
                setHi(cats.findIndex((c) => c.name === sub.name));
                setCat(null);
              } else if (ev.key === "Enter") {
                ev.preventDefault();
                if (list[hi]) add(list[hi]);
                else if (!found && !sub && cats[hi]) (setCat(cats[hi].name), setHi(0));
              }
            }}>
            <input class="smp-fxq" type="search" placeholder="Search effects" aria-label="Search effects" autoFocus value={query} onInput={(ev) => (setQuery((ev.currentTarget as HTMLInputElement).value), setHi(0), setCat(null))} />
            {found ? (
              found.length ? found.map((x, i) => item(x.type, x.category, i)) : <p class="smp-tci-line smp-muted">No matching effects</p>
            ) : sub ? (
              <>
                <button type="button" class="smp-tci smp-fx-back" onClick={() => (setCat(null), setHi(0))}>
                  <span aria-hidden="true">‹</span>
                  <span class="smp-tci-label smp-cap">{sub.name}</span>
                </button>
                {sub.types.map((t, i) => item(t, null, i))}
              </>
            ) : (
              cats.map((c, i) => (
                <button key={c.name} type="button" role="menuitem" aria-haspopup="menu" class={`smp-tci${i === hi ? " hi" : ""}`} onPointerEnter={() => setHi(i)} onClick={() => (setCat(c.name), setHi(0))}>
                  <span class="smp-tci-label">{c.name}</span>
                  <span class="smp-tci-note">{c.types.length}</span>
                  <span aria-hidden="true">›</span>
                </button>
              ))
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

export function EditsPanel() {
  const s = openSession.value;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (!s) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="No sample open" icon={<Icon name="mixer" size={28} />} body="Its baked effects list here." />
      </Panel>
    );
  }
  const e = s.edits.value;
  const ro = s.readOnly;
  const commit = (r: SampleEdit, coalesce = false) => s.commit(r, { coalesce });
  const n = e.normalize;
  const length = lengthOf(s.project, s.source.value);
  const render = renderPathOf(s.project.files, s.source.value, e);
  const preview = previewOf(s, e, null, abSource.value);
  const ctx = { rate: 48000, bpm: e.tempo?.bpm, meter: e.tempo?.meter };
  const t = (v: number) => formatTime(v, timeFormat.value, ctx);
  const chip = { source: ["Source only", "neutral"], rebuilding: ["Rebuilding…", "warning"], cached: ["Cached", "success"], frozen: ["Frozen", "neutral"] }[preview.state] as [string, "neutral" | "warning" | "success"];
  const chipTip = preview.key
    ? `Render cached · ${(preview.bytes / 1048576).toFixed(1)} MB · key ${preview.key.slice(0, 6)} (source + every edit's settings + effect versions) · in .myco/cache/samples/`
    : preview.state === "source" ? "No effects to render: the sample plays its source" : preview.state === "frozen" ? "Frozen: the render is kept as fixed audio" : "Rendering the effects…";
  const flatten = async () => {
    setBusy(true);
    try {
      const project = s.project, src = s.source.peek();
      const r = await flattenSample(s, { bytes: await bytesOf(project, src), pcm: () => pcmOf(project, src) });
      if ("refused" in r) toasts.show({ text: `Can't flatten: ${r.refused}.` });
      else if (r.unchanged) toasts.show({ text: `${nameOf(r.path)} is up to date: the edits haven't changed since it was rendered` });
      else toasts.show({ text: [`Flattened into ${nameOf(r.path)}${r.hit ? " (from the render cache)" : ""} · Undo brings the effects back`, ...r.warnings].join(" · "), undo: () => s.undo() });
    } catch (err) {
      toasts.show({ text: `Can't flatten: ${err instanceof Error ? err.message : String(err)}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const [ta, tb] = length !== null ? trimOf(e, length) : [0, 0];
  const toolbar = (
    <div class="smp-edits-bar">
      <span class="smp-cap smp-edits-cap">Sample effects</span>
      <InfoTip text="Baked into the sample · no runtime cost. Rendered offline; the source is never changed and every clip that uses the sample gets them. Game parameters can't drive them: put effects that must change at runtime on a clip, playlist or bus." label="About sample effects" />
      <AddEffect disabled={ro || e.frozen} why={e.frozen ? "Unfreeze to add effects" : undefined} onAdd={(type) => {
        const r = effectEdits.add(e, type);
        if (commit(r)) setOpen(new Set([...open, r.next.effects[r.next.effects.length - 1].id]));
      }} />
      <button type="button" class={`smp-sbtn${e.frozen ? " on" : ""}`} aria-pressed={e.frozen} aria-label="Freeze render" disabled={ro}
        title={e.frozen ? "Frozen: the render is kept as fixed audio · click to unfreeze" : "Freeze: keep the current render as fixed audio, safe from effect updates"} onClick={() => commit(freezeEdit(e))}>
        <SampleIcon name="freeze" size={14} />
      </button>
      <button type="button" class="smp-sbtn" aria-label="Flatten effects into a new source version" disabled={ro || busy || !hasRenderableEdits(e)}
        title={hasRenderableEdits(e) ? `${render ? "Re-flatten" : "Flatten"}: render the ${e.effects.length} effect${e.effects.length === 1 ? "" : "s"} into a new source version and play it (the source stays in the version list; Undo brings the effects back)` : "Nothing to flatten: add an effect or normalize"}
        onClick={() => void flatten()}>
        <SampleIcon name="flatten" size={14} />
      </button>
      <span class="smp-flex" />
      <Chip tone={chip[1]} title={chipTip}>{busy ? "Rendering…" : chip[0]}</Chip>
    </div>
  );
  return (
    <Panel class="smp-edits" toolbar={toolbar}>
      <ol class="smp-chain">
        <li class="smp-fxr root" title="The imported audio is never changed; every edit below is stored as data">
          <SampleIcon name="lock" size={12} />
          <b>Source</b>
          <span class="smp-muted smp-ellipsis">{nameOf(s.source.value)}{length !== null ? ` · ${shortLength(length)}` : ""}{render ? ` · plays ${nameOf(render)}` : ""}</span>
          <span class="smp-flex" />
          <Chip title="The imported audio is never changed; every edit below is stored as data">Read-only</Chip>
        </li>
        {e.trim && (
          <li class="smp-fxr locked" title="Edited on the timeline · click selects the trim" onClick={() => select({ kind: "trim" })}>
            <b>Trim</b>
            <span class="smp-muted smp-tabular">{t(ta)} – {t(tb)}</span>
            <span class="smp-flex" />
            <Chip>Timeline</Chip>
          </li>
        )}
        {e.closedGaps.length > 0 && (
          <li class="smp-fxr locked" title="Edited on the timeline (razor snippets)">
            <b>Closed gaps</b>
            <span class="smp-muted">{e.closedGaps.length} · {Math.round(removedSeconds(e.closedGaps) * 1000)} ms removed</span>
            <span class="smp-flex" />
            <Chip>Timeline</Chip>
          </li>
        )}
        {e.effects.map((f, i) => (
          <EffectRow key={f.id} f={f} e={e} first={i === 0} last={i === e.effects.length - 1} ro={ro} session={s} open={open.has(f.id)} commit={commit}
            onOpen={(o) => setOpen(o ? new Set([...open, f.id]) : new Set([...open].filter((x) => x !== f.id)))} />
        ))}
        {n.mode !== "off" && (
          <li class="smp-fxr locked" title="Applied last, after the effects · set it with Normalize in the toolbar">
            <b>Normalize</b>
            <span class="smp-muted smp-tabular">{normalizeTargetText(n)} → {normalizeGainText(n.gainDb)}</span>
            <span class="smp-flex" />
            <Chip>Toolbar</Chip>
          </li>
        )}
        {e.effects.length === 0 && n.mode === "off" && <li role="presentation"><EmptyState compact title="No edits: plays the source as imported." /></li>}
      </ol>
    </Panel>
  );
}
