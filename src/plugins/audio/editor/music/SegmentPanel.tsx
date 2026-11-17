// Ed4 (api-and-models §7, contract H6): the segment panel beside the segment view: tempo from length and bars, tap tempo,
// the stem list (solo, mute, gain, alternatives), cue and region forms, and the import drop (Ed9's `importDropped`).
//
// Every edit is a pure function of the segment in `segmentEdits.ts` (`Edit`: the next segment or a one-line reason it was
// refused). The component applies the result through the event's asset document (one undo step per edit), exactly as the
// view does.
//
// Interpretations: solo and mute are audition-only editor state (`stemAudition.ts`), never written to the asset. Tap tempo is the median interval of the current run (`tempoTools.ts`).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { editor, openAssetDocument, registerAssetDropTarget, useDraftText, Panel } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import {
  BEAT_UNITS, MAX_BPM, MIN_BPM, MUSIC_LIMITS, TRACK_PICKS, type MusicRegion, type SegmentNode, type TrackPick,
} from "../../../../engine/audio/musicFormat";
import { validateSegment, type MusicClipFacts, type MusicLintIssue } from "../../../../engine/audio/musicValidate";
import { importDropped } from "./import";
import { openSegment } from "./index";
import { peaksFor } from "./peaksHost";
import type { PeaksService } from "./peaks";
import { findSegment, replaceSegment } from "./segmentViewModel";
import { barCountCandidates, tapTempo, tempoFromLength } from "./tempoTools";
import { type Edit, setTempo, setGridOffset, renameTrack, setTrackVolume, setTrackPick, removeTrack, moveTrack, removeAlternative, promoteAlternative, addCue, renameCue, setCueAt, removeCue, setEntry, setExit, addRegion, type RegionPatch, updateRegion, removeRegion, type ConditionForm, readCondition } from "./segmentEdits";
import { type StemAudition, auditionKey, auditionOf, toggleStem, audibleStems } from "./stemAudition";
import "./segmentPanel.css";

const ok = (segment: SegmentNode): Edit => ({ segment });
const fail = (error: string): Edit => ({ error });
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// --- the component ------------------------------------------------------------------------------------------------------

const AUDIO_EXT = /\.(wav|ogg|oga|opus|mp3|flac|m4a|aac)$/i;

export function SegmentPanel() {
  const open = openSegment.value;
  const project = editor.project.current;
  editor.project.version;
  if (!project || !open) return <Panel><p class="empty">Segment: open a segment from the Event editor to edit its tempo, stems, cues and regions here.</p></Panel>;
  if (!project.files.includes(open.event)) return <Panel><p class="empty">{open.event} isn't in the project any more.</p></Panel>;
  return (
    <Panel>
      <OpenPanel key={auditionKey(open.event, open.segmentId)} path={open.event} segmentId={open.segmentId} />
    </Panel>
  );
}

function OpenPanel({ path, segmentId }: { path: string; segmentId: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, path, "audioEvent");
  const event = doc.value.value;
  const segment = useMemo(() => findSegment(event.musicRoot, segmentId), [event.musicRoot, segmentId]);
  const peaks = peaksFor(project);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const key = auditionKey(path, segmentId);
  const audition = auditionOf(key);

  // Probe every clip once so lengths and the lint have facts.
  const clips = useMemo(() => (segment ? segment.tracks.flatMap((t) => [t.clip, ...t.alternatives]) : []), [segment]);
  useEffect(() => {
    let live = true;
    for (const c of clips) if (c && !peaks.peek(c)) peaks.get(c).then(() => live && setVersion((v) => v + 1), () => {});
    return () => void (live = false);
  }, [clips.join("\n")]);

  if (!segment) return <p class="empty">{path} has no segment “{segmentId}”.</p>;

  const apply = (e: Edit, label: string): boolean => {
    if ("error" in e) { setError(e.error); return false; }
    setError("");
    if (e.segment !== segment && event.musicRoot) doc.edit({ ...event, musicRoot: replaceSegment(event.musicRoot, segmentId, e.segment) }, { label });
    return true;
  };

  const facts = (p: string): MusicClipFacts | undefined => {
    const m = peaks.peek(p);
    return m ? { frames: m.frames, rate: m.rate, channels: Math.min(2, Math.max(1, m.channels)), gapless: true } : undefined;
  };
  void version;
  const lint = validateSegment(segment, facts).issues;
  const readOnly = doc.readOnly;

  const doImport = async (paths: readonly string[], alternativeOf?: string) => {
    if (readOnly) return editor.messages.info("This project is read-only.");
    await Promise.all(paths.map((p) => peaks.get(p).catch(() => undefined)));
    const read = async (p: string) => {
      const url = project.assets.get(p);
      return typeof url === "string" ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : undefined;
    };
    const r = await importDropped(segment, paths, read, facts, alternativeOf ? { mode: { alternativeOf } } : undefined);
    const a = r.applied;
    if (r.segment !== segment) apply(ok(r.segment), alternativeOf ? "Add alternatives" : "Import stems");
    const parts = [
      a.tracks.length ? `${a.tracks.length} stem${a.tracks.length === 1 ? "" : "s"}` : "",
      a.alternatives.length ? `${a.alternatives.length} alternative${a.alternatives.length === 1 ? "" : "s"}` : "",
      a.tempo ? `tempo ${a.tempo.bpm} bpm` : "",
      a.cues.length ? `${a.cues.length} cue${a.cues.length === 1 ? "" : "s"}` : "",
      a.region ? `region ${a.region}` : "",
    ].filter(Boolean);
    const skipped = a.skipped.map((s) => `${s.path}: ${s.reason}`);
    editor.messages.info(parts.length ? `Imported ${parts.join(", ")}.` : "Nothing imported.", skipped.length ? skipped.join("\n") : undefined);
  };

  return (
    <div class="segment-panel" data-asset-document={doc.path}>
      <TempoSection segment={segment} peaks={peaks} version={version} readOnly={readOnly} apply={apply} />
      <StemsSection segment={segment} audition={audition} auditionKey={key} readOnly={readOnly} apply={apply} onDrop={doImport} />
      <CuesSection segment={segment} readOnly={readOnly} apply={apply} />
      <RegionsSection segment={segment} readOnly={readOnly} apply={apply} />
      {error && <p class="segment-panel-error" role="alert">{error}</p>}
      <Lint issues={lint} />
    </div>
  );
}

type Apply = (e: Edit, label: string) => boolean;

/** A number that commits on Enter or blur, reverts on Escape; a refused edit puts the old value back. */
function Num(props: { label: string; value: number; onCommit: (n: number) => void; suffix?: string; narrow?: boolean; disabled?: boolean }) {
  const shown = String(props.value);
  const { setDraft, input } = useDraftText(shown, (draft) => {
    const n = Number(draft);
    if (draft.trim() === shown) return;
    if (draft.trim() !== "" && Number.isFinite(n)) props.onCommit(n);
    setDraft(shown);
  });
  return (
    <span class="sp-num">
      <input type="text" inputMode="decimal" aria-label={props.label} class={props.narrow ? "narrow" : ""} disabled={props.disabled} {...input} />
      {props.suffix && <span class="sp-suffix">{props.suffix}</span>}
    </span>
  );
}

/** Text that commits on Enter or blur and reverts on Escape. */
function Txt(props: { label: string; value: string; onCommit: (s: string) => void; disabled?: boolean; narrow?: boolean; placeholder?: string }) {
  const { setDraft, input } = useDraftText(props.value, (draft) => {
    if (draft !== props.value) props.onCommit(draft);
    setDraft(props.value);
  });
  return <input type="text" aria-label={props.label} class={props.narrow ? "narrow" : ""} disabled={props.disabled} placeholder={props.placeholder} {...input} />;
}

function TempoSection(props: { segment: SegmentNode; peaks: PeaksService; version: number; readOnly: boolean; apply: Apply }) {
  const { segment, readOnly, apply } = props;
  const t = segment.tempo[0]!;
  const [bars, setBars] = useState("");
  const taps = useRef<number[]>([]);
  const [tap, setTap] = useState<ReturnType<typeof tapTempo>>(null);
  const [tapCount, setTapCount] = useState(0);

  void props.version;
  // The longest stem decides the length, as the grid's "end" does.
  let seconds = 0;
  for (const tr of segment.tracks) {
    const m = props.peaks.peek(tr.clip);
    if (m && m.rate > 0) seconds = Math.max(seconds, m.frames / m.rate);
  }
  const barsN = Number(bars);
  const fromLength = bars.trim() !== "" && seconds > 0 ? tempoFromLength(seconds, barsN, t.beatsPerBar, segment.gridOffset) : null;
  const candidates = seconds > 0 ? barCountCandidates(seconds, t.beatsPerBar, { gridOffset: segment.gridOffset }) : [];

  const onTap = () => {
    const now = performance.now() / 1000;
    const last = taps.current[taps.current.length - 1];
    taps.current = last !== undefined && now - last > 2 ? [now] : [...taps.current, now].slice(-32);
    setTapCount(taps.current.length);
    setTap(tapTempo(taps.current));
  };

  return (
    <section class="sp-section" aria-label="Tempo">
      <h3>Tempo</h3>
      <div class="sp-row">
        <label>Tempo <Num label="Tempo" value={t.bpm} suffix="bpm" disabled={readOnly} onCommit={(n) => apply(setTempo(segment, { bpm: n }), "Set tempo")} /></label>
        <label>Metre <Num label="Beats per bar" value={t.beatsPerBar} narrow disabled={readOnly} onCommit={(n) => apply(setTempo(segment, { beatsPerBar: n }), "Set metre")} />
          <span class="sp-suffix">/</span>
          <select aria-label="Beat unit" value={t.beatUnit} disabled={readOnly} onChange={(e) => apply(setTempo(segment, { beatUnit: Number((e.currentTarget as HTMLSelectElement).value) }), "Set metre")}>
            {BEAT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label>Grid offset <Num label="Grid offset" value={segment.gridOffset} suffix="s" disabled={readOnly} onCommit={(n) => apply(setGridOffset(segment, n), "Set grid offset")} /></label>
      </div>
      <div class="sp-row" aria-label="Tempo from length">
        <span class="sp-muted">{seconds > 0 ? `Length ${seconds.toFixed(3)} s` : "Length unknown (stems not decoded yet)"}</span>
        <label>Bars
          <input type="text" inputMode="numeric" aria-label="Bars in the clip" class="narrow" value={bars} disabled={readOnly || seconds <= 0} onInput={(e) => setBars((e.currentTarget as HTMLInputElement).value)} />
        </label>
        {candidates.length > 0 && (
          <select aria-label="Likely bar counts" value="" disabled={readOnly} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) setBars(v); }}>
            <option value="">likely…</option>
            {candidates.map((c) => <option key={c.bars} value={c.bars}>{c.bars} bars ({Math.round(c.bpm * 10) / 10} bpm)</option>)}
          </select>
        )}
        <button disabled={readOnly || !fromLength} title={fromLength && !fromLength.valid ? `outside ${MIN_BPM}..${MAX_BPM} bpm` : undefined}
          onClick={() => fromLength && apply(setTempo(segment, { bpm: fromLength.bpm }), "Tempo from length")}>
          {fromLength ? `Use ${round3(fromLength.bpm)} bpm` : "Use"}
        </button>
      </div>
      <div class="sp-row" aria-label="Tap tempo">
        <button onClick={onTap} disabled={readOnly}>Tap</button>
        <span class="sp-muted" aria-live="polite">{tap ? `${Math.round(tap.bpm * 10) / 10} bpm (${tapCount} taps)` : tapCount > 0 ? "keep tapping" : "tap on the beat"}</span>
        <button disabled={readOnly || !tap} onClick={() => tap && apply(setTempo(segment, { bpm: tap.bpm }), "Tap tempo")}>Use</button>
        <button disabled={tapCount === 0} onClick={() => { taps.current = []; setTapCount(0); setTap(null); }}>Reset</button>
      </div>
    </section>
  );
}

function StemsSection(props: {
  segment: SegmentNode; audition: StemAudition; auditionKey: string; readOnly: boolean; apply: Apply;
  onDrop: (paths: readonly string[], alternativeOf?: string) => Promise<void>;
}) {
  const { segment, audition, readOnly, apply } = props;
  const list = useRef<HTMLUListElement>(null);
  const latest = useRef(props);
  latest.current = props;

  // A drop on a stem row adds alternatives to it; elsewhere in the list each file is a new stem.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const target = (point: { x: number; y: number }) => document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-stem]")?.dataset.stem;
    return registerAssetDropTarget(el, {
      accepts: (assets) => assets.length > 0 && assets.every((a) => AUDIO_EXT.test(a)),
      label: (assets, point) => {
        const s = target(point);
        return s ? `Add ${assets.length} alternative${assets.length === 1 ? "" : "s"} to ${s}` : `Add ${assets.length} stem${assets.length === 1 ? "" : "s"}`;
      },
      drop: (assets, point) => void latest.current.onDrop(assets, target(point)),
    });
  }, []);

  const audible = new Set(audibleStems(segment.tracks, audition));
  return (
    <section class="sp-section" aria-label="Stems">
      <h3>Stems <span class="sp-muted">{segment.tracks.length}/{MUSIC_LIMITS.tracks}</span></h3>
      <ul class="sp-list" ref={list}>
        {segment.tracks.length === 0 && <li class="sp-muted">Drop audio files from the Assets panel to add stems.</li>}
        {segment.tracks.map((t, i) => (
          <li key={t.name} class={`sp-stem${audible.has(t.name) ? "" : " silent"}`} data-stem={t.name}>
            <div class="sp-row">
              <button class={`sp-toggle${audition.solo.includes(t.name) ? " on" : ""}`} aria-pressed={audition.solo.includes(t.name)} title="Solo (audition only)" onClick={() => toggleStem(props.auditionKey, "solo", t.name)}>S</button>
              <button class={`sp-toggle${audition.mute.includes(t.name) ? " on" : ""}`} aria-pressed={audition.mute.includes(t.name)} title="Mute (audition only)" onClick={() => toggleStem(props.auditionKey, "mute", t.name)}>M</button>
              <Txt label={`Name of ${t.name}`} value={t.name} disabled={readOnly} onCommit={(s) => apply(renameTrack(segment, t.name, s), "Rename stem")} />
              <Num label={`Gain of ${t.name}`} value={t.volume} narrow disabled={readOnly} onCommit={(n) => apply(setTrackVolume(segment, t.name, n), "Set stem gain")} />
              <button disabled={readOnly || i === 0} title="Move up" onClick={() => apply(moveTrack(segment, t.name, -1), "Move stem")}>↑</button>
              <button disabled={readOnly || i === segment.tracks.length - 1} title="Move down" onClick={() => apply(moveTrack(segment, t.name, 1), "Move stem")}>↓</button>
              <button disabled={readOnly} title="Remove stem" onClick={() => apply(removeTrack(segment, t.name), "Remove stem")}>✕</button>
            </div>
            <div class="sp-clip sp-muted" title={t.clip}>{t.clip || "(no clip)"}</div>
            {t.alternatives.length > 0 && (
              <div class="sp-alts">
                <label>Pick
                  <select aria-label={`Pick of ${t.name}`} value={t.pick} disabled={readOnly} onChange={(e) => apply(setTrackPick(segment, t.name, (e.currentTarget as HTMLSelectElement).value as TrackPick), "Set stem pick")}>
                    {TRACK_PICKS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <ul>
                  {t.alternatives.map((a) => (
                    <li key={a}>
                      <span class="sp-clip" title={a}>{a}</span>
                      <button disabled={readOnly} title="Make this the main clip" onClick={() => apply(promoteAlternative(segment, t.name, a), "Promote alternative")}>Use</button>
                      <button disabled={readOnly} title="Remove alternative" onClick={() => apply(removeAlternative(segment, t.name, a), "Remove alternative")}>✕</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p class="sp-muted sp-hint">Solo and mute only affect the audition. Drop a file on a stem to add it as an alternative.</p>
    </section>
  );
}

function CuesSection(props: { segment: SegmentNode; readOnly: boolean; apply: Apply }) {
  const { segment, readOnly, apply } = props;
  const names = segment.cues.map((c) => c.name);
  return (
    <section class="sp-section" aria-label="Cues">
      <h3>Cues <span class="sp-muted">{segment.cues.length}/{MUSIC_LIMITS.cues}</span></h3>
      <div class="sp-row">
        <label>Entry
          <select aria-label="Entry cue" value={segment.entry ?? ""} disabled={readOnly} onChange={(e) => apply(setEntry(segment, (e.currentTarget as HTMLSelectElement).value || undefined), "Set entry")}>
            <option value="">default</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>Exit
          <select aria-label="Exit cue" value={segment.exit ?? ""} disabled={readOnly} onChange={(e) => apply(setExit(segment, (e.currentTarget as HTMLSelectElement).value || undefined), "Set exit")}>
            <option value="">default</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <ul class="sp-list">
        {segment.cues.map((c) => (
          <li key={c.name} class="sp-row">
            <Txt label={`Name of cue ${c.name}`} value={c.name} disabled={readOnly} onCommit={(s) => apply(renameCue(segment, c.name, s), "Rename cue")} />
            <Txt label={`Position of cue ${c.name}`} value={c.at} narrow disabled={readOnly} onCommit={(s) => apply(setCueAt(segment, c.name, s), "Move cue")} />
            <button disabled={readOnly} title="Remove cue" onClick={() => apply(removeCue(segment, c.name), "Remove cue")}>✕</button>
          </li>
        ))}
      </ul>
      <button disabled={readOnly || segment.cues.length >= MUSIC_LIMITS.cues} onClick={() => apply(addCue(segment), "Add cue")}>+ Cue</button>
    </section>
  );
}

function RegionsSection(props: { segment: SegmentNode; readOnly: boolean; apply: Apply }) {
  const { segment, readOnly, apply } = props;
  return (
    <section class="sp-section" aria-label="Regions">
      <h3>Regions <span class="sp-muted">{segment.regions.length}/{MUSIC_LIMITS.regions}</span></h3>
      <ul class="sp-list">
        {segment.regions.map((r) => <RegionForm key={r.id} segment={segment} region={r} readOnly={readOnly} apply={apply} />)}
      </ul>
      <button disabled={readOnly || segment.regions.length >= MUSIC_LIMITS.regions} onClick={() => apply(addRegion(segment), "Add region")}>+ Region</button>
    </section>
  );
}

function RegionForm(props: { segment: SegmentNode; region: MusicRegion; readOnly: boolean; apply: Apply }) {
  const { segment, region: r, readOnly, apply } = props;
  const patch = (p: RegionPatch, label: string) => apply(updateRegion(segment, r.id, p), label);
  const w = r.while;
  const form: ConditionForm = !w ? "is" : "is" in w ? "is" : "atLeast" in w ? "atLeast" : "below";
  const valueOf = !w ? "" : "is" in w ? w.is : String("atLeast" in w ? w.atLeast : w.below);
  const [cond, setCond] = useState({ parameter: w?.parameter ?? "", form, value: valueOf });
  useEffect(() => setCond({ parameter: w?.parameter ?? "", form, value: valueOf }), [w?.parameter, form, valueOf]);
  const commitCond = (next: typeof cond) => {
    setCond(next);
    if (next.parameter.trim() === "" && next.value.trim() === "") return void patch({ while: null }, "Clear region condition");
    const c = readCondition(next.parameter, next.form, next.value);
    if ("error" in c) return void apply(fail(`while: ${c.error}`), "");
    patch({ while: c.condition }, "Set region condition");
  };
  return (
    <li class="sp-region">
      <div class="sp-row">
        <Txt label={`Name of region ${r.id}`} value={r.id} disabled={readOnly} onCommit={(s) => patch({ id: s }, "Rename region")} />
        <Txt label={`From of region ${r.id}`} value={r.from} narrow disabled={readOnly} onCommit={(s) => patch({ from: s }, "Set region start")} />
        <span class="sp-suffix">to</span>
        <Txt label={`To of region ${r.id}`} value={r.to} narrow disabled={readOnly} onCommit={(s) => patch({ to: s }, "Set region end")} />
        <button disabled={readOnly} title="Remove region" onClick={() => apply(removeRegion(segment, r.id), "Remove region")}>✕</button>
      </div>
      <div class="sp-row">
        <label>Passes <Num label={`Passes of region ${r.id}`} value={r.count} narrow disabled={readOnly} onCommit={(n) => patch({ count: n }, "Set region passes")} /><span class="sp-suffix">0 = forever</span></label>
        <label>Tail <Num label={`Tail of region ${r.id}`} value={r.tailBeats ?? 0} narrow suffix="beats" disabled={readOnly} onCommit={(n) => patch({ tailBeats: n === 0 ? null : n }, "Set region tail")} /></label>
      </div>
      <div class="sp-row">
        <span class="sp-muted">While</span>
        <input type="text" aria-label={`While parameter of region ${r.id}`} placeholder="parameter" value={cond.parameter} disabled={readOnly}
          onInput={(e) => setCond({ ...cond, parameter: (e.currentTarget as HTMLInputElement).value })} onBlur={() => commitCond(cond)} />
        <select aria-label={`While comparison of region ${r.id}`} value={cond.form} disabled={readOnly} onChange={(e) => commitCond({ ...cond, form: (e.currentTarget as HTMLSelectElement).value as ConditionForm })}>
          <option value="is">is</option><option value="atLeast">at least</option><option value="below">below</option>
        </select>
        <input type="text" aria-label={`While value of region ${r.id}`} class="narrow" placeholder="value" value={cond.value} disabled={readOnly}
          onInput={(e) => setCond({ ...cond, value: (e.currentTarget as HTMLInputElement).value })} onBlur={() => commitCond(cond)} />
      </div>
    </li>
  );
}

function Lint({ issues }: { issues: readonly MusicLintIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <section class="sp-section" aria-label="Lint">
      <h3>Lint <span class="sp-muted">{issues.length}</span></h3>
      <ul class="sp-lint">
        {issues.map((i, n) => <li key={n} class={i.severity}>{i.message}</li>)}
      </ul>
    </section>
  );
}
