// The clip import settings, a card of a model's Import Settings (ADR 0373 "Clip import settings"; T54):
// - a take strip: the file's takes, each cut into clips by `from`/`to` seconds (add, split at the playhead, rename, remove);
// - per clip: loop with a pose-match indicator (the pose at its start against its end), root motion (bone, axes, bake into
//   pose), additive reference, mirror, compression bounds with the compile report's resulting size and maximum error, and
//   the markers, events and curves of the clip;
// - a preview on the model, or on any other character with the same profile.
// Every change edits the Import Settings draft through `clipImportLogic.ts` (which may refuse it); the shell's Apply writes
// the sidecar's `animation.clips` and Revert drops the draft. The compile report is of the clips as saved: Apply, then
// Compile.
//
// The preview poses the model at the playhead (T18b): it plays the selected clip as the draft cuts it (`importPreviewLogic.ts`:
// its range, loop and root motion as set, before Apply) through the runtime on the preview World's Animator. It binds the
// clip by bone name, so another character shows it only when its bones are named alike.
import { useEffect, useMemo, useState } from "preact/hooks";
import { Chip, LargePreview, editor, type ImportSettingsViewProps } from "../../../../editor/sdk";
import { ROOT_MOTION_AXES, type AnimSource } from "../../../../engine/animation/animSource";
import type { ModelAnimation } from "../../../../engine/scene/models";
import { loadModel } from "../../../../engine/scene/models";
import { clipCompileService } from "../compile/register";
import { PosedClipPreview, previewClipOfSource } from "../scene/posedPreview";
import { usePlayheadClock } from "../scene/usePlayheadClock";
import { usePosedScene } from "../scene/usePosedScene";
import { ClipPlayhead } from "../scene/clipPreviewLogic";
import { animationOf, applyAnimation } from "../skeleton/animationDraft";
import { readProfile, otherModels, useModelAnimation } from "../skeleton/modelAnimation";
import { profileCompatible } from "../skeleton/retargetLogic";
import { CurveRows, EventRows, MarkerRows } from "./ClipRows";
import { TakeStrip } from "./TakeStrip";
import { draftClipSource } from "./importPreviewLogic";
import {
  addClip, clipLength, clipReportOf, clipsOfTake, describeReport, allClipNames, poseMatch, removeClip, renameClip, rootMotionWithAxis, setAdditive, setClipRange, setCompression, setCurves, setEvents, setLoop,
  setMarkers, setMirror, setRootMotion, splitClip, type ReportState,
} from "./clipImportLogic";
import "./clipImport.css";
import "../skeleton/skeleton.css";
import { uniqueName } from "../../../../engine/core/uniqueName";

const ROLE = "Preview";
const seconds = (t: number) => `${t.toFixed(2)} s`;
const input = (e: Event) => e.currentTarget as HTMLInputElement;
const select = (e: Event) => e.currentTarget as HTMLSelectElement;

/** The clip import card (see the file comment). */
export function ClipImportSettings(props: ImportSettingsViewProps) {
  const model = useModelAnimation(props.path);
  if (model.state === "loading") return <p class="skeleton-note">Loading the model…</p>;
  if (model.state === "failed") return <p class="skeleton-note">Couldn't load the model: {model.error}</p>;
  if (model.state === "none" || model.animation.takes.length === 0) return <p class="skeleton-note">This model has no animation takes to cut clips from.</p>;
  return <ClipImportCard {...props} animation={model.animation} />;
}

function ClipImportCard(props: ImportSettingsViewProps & { animation: ModelAnimation }) {
  const { path, draft, readOnly, animation } = props;
  const disabled = !!readOnly;
  const takes = useMemo(() => animation.takes.map((t) => ({ name: t.name, duration: t.duration })), [animation]);
  const bones = animation.skeleton?.bones.map((b) => b.name) ?? [];
  const anim = animationOf(draft);
  const [takeName, setTakeName] = useState(takes[0].name);
  const [clipName, setClipName] = useState<string | null>(null);
  const take = takes.find((t) => t.name === takeName) ?? takes[0];
  const clips = clipsOfTake(anim, take.name);
  const clip = clips.find((c) => c.name === clipName) ?? clips[0] ?? null;
  const run = (result: Parameters<typeof applyAnimation>[1], label: string) => applyAnimation(props, result, label);

  // The playhead runs over the selected clip.
  const playhead = useMemo(() => new ClipPlayhead(), [path]);
  const length = clip ? clipLength(clip, take) : take.duration;
  const loop = clip?.loop ?? false;
  useEffect(() => playhead.setTiming({ duration: length, looping: loop, known: true }), [playhead, length, loop, clip?.name]);
  usePlayheadClock(playhead);
  // The clip as the draft cuts it, played by the preview. Keyed by what the cut reads, not by identity: the settings are rebuilt each render.
  const cutKey = JSON.stringify([take.name, clips, clip?.name]);
  const source = useMemo(() => (clip ? draftClipSource(animation.takes, anim, take.name, clip.name) : null), [animation, take.name, cutKey]);
  const inClip = playhead.time.value;
  const atTake = (clip?.from ?? 0) + inClip;

  // The compile report of the clip as saved.
  const [report, setReport] = useState<ReportState>({ state: "none" });
  const [compiling, setCompiling] = useState(false);
  const saved = !!clip && animation.clips.some((c) => c.name === clip.name && c.take === take.name);
  useEffect(() => {
    let live = true;
    setReport({ state: "none" });
    if (clip && saved) void clipReportOf(clipCompileService(), path, clip.name).then((r) => live && setReport(r));
    return () => void (live = false);
  }, [path, clip?.name, saved, editor.project.version]);
  const compile = async () => {
    if (!clip) return;
    setCompiling(true);
    try {
      setReport(await clipReportOf(clipCompileService(), path, clip.name, true));
    } finally {
      setCompiling(false);
    }
  };

  const match = useMemo(() => {
    const t = animation.takes.find((x) => x.name === take.name);
    return clip && t ? poseMatch(t, clip.from, clip.to, clip.rootMotion) : null;
  }, [animation, take.name, clip]);

  return (
    <>
      <PreviewRow path={path} animation={animation} anim={anim} playhead={playhead} length={length} source={source} />
      {takes.length > 1 && (
        <label class="import-row">
          <span>Take</span>
          <select aria-label="Take" value={take.name} onChange={(e) => (setTakeName(select(e).value), setClipName(null), playhead.seek(0))}>
            {takes.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({seconds(t.duration)})
              </option>
            ))}
          </select>
        </label>
      )}
      <TakeStrip duration={take.duration} clips={clips} selected={clip?.name ?? null} playhead={atTake} onSelect={(n) => (setClipName(n), playhead.seek(0))} onSeek={(t) => {
        const hit = clips.find((c) => t >= c.from && t < (c.to ?? take.duration));
        if (hit && hit.name !== clip?.name) setClipName(hit.name);
        playhead.seek(Math.max(0, t - (hit?.from ?? clip?.from ?? 0)));
      }} />
      <div class="skeleton-actions clip-actions">
        <button
          disabled={disabled}
          title={disabled ? (readOnly ?? "") : "Add a clip from the playhead to the end of the take"}
          onClick={() => {
            const name = uniqueName(`${take.name} clip`, allClipNames(anim, takes));
            const from = Math.min(atTake, take.duration - 0.01);
            if (run(addClip(anim, takes, take.name, name, Math.max(0, from), null), "Add a clip")) setClipName(name);
          }}
        >
          Add Clip
        </button>
        <button disabled={disabled || !clip} title={disabled ? (readOnly ?? "") : "Cut the selected clip in two at the playhead"} onClick={() => clip && run(splitClip(anim, takes, take.name, clip.name, atTake), "Split the clip at the playhead")}>
          Split at Playhead
        </button>
        <button disabled={disabled || !clip} onClick={() => clip && run(removeClip(anim, takes, take.name, clip.name), `Remove ${clip.name}`)}>
          Remove Clip
        </button>
      </div>
      {!clip ? (
        <p class="skeleton-note">This take makes no clips. Add one to cut it.</p>
      ) : (
        <>
          <label class="import-row">
            <span>Name</span>
            <input type="text" aria-label="Clip name" disabled={disabled} value={clip.name} onChange={(e) => {
              const to = input(e).value;
              if (run(renameClip(anim, takes, take.name, clip.name, to), `Rename ${clip.name}`)) setClipName(to.trim());
            }} />
          </label>
          <label class="import-row" title="Seconds into the take where the clip starts">
            <span>From</span>
            <input type="number" min={0} step={0.01} aria-label="From" disabled={disabled} value={clip.from} onChange={(e) => run(setClipRange(anim, takes, take.name, clip.name, Number(input(e).value), clip.to), `Retime ${clip.name}`)} />
          </label>
          <label class="import-row" title="Seconds into the take where the clip ends; empty: the end of the take">
            <span>To</span>
            <input type="number" min={0} step={0.01} aria-label="To" placeholder="end" disabled={disabled} value={clip.to ?? ""} onChange={(e) => run(setClipRange(anim, takes, take.name, clip.name, clip.from, input(e).value === "" ? null : Number(input(e).value)), `Retime ${clip.name}`)} />
          </label>
          <div class="import-row">
            <span>Loop</span>
            <span class="skeleton-actions">
              <input type="checkbox" aria-label="Loop" disabled={disabled} checked={clip.loop} onChange={(e) => run(setLoop(anim, takes, take.name, clip.name, input(e).checked), `Set ${clip.name} ${input(e).checked ? "looping" : "not looping"}`)} />
              <LoopIndicator match={match} loop={clip.loop} />
            </span>
          </div>
          <RootMotionRows clip={clip} bones={bones} boneMap={anim.boneMap} disabled={disabled} onChange={(rm, label) => run(setRootMotion(anim, takes, take.name, clip.name, rm, bones), label)} />
          <AdditiveRows clip={clip} others={allClipNames(anim, takes).filter((n) => n !== clip.name)} disabled={disabled} onChange={(reference) => run(setAdditive(anim, takes, take.name, clip.name, reference), `Set the additive reference of ${clip.name}`)} />
          <label class="import-row" title="Mirror the clip left to right when it is compiled (the profile's mirror pairs)">
            <span>Mirror</span>
            <input type="checkbox" aria-label="Mirror" disabled={disabled} checked={clip.mirror} onChange={(e) => run(setMirror(anim, takes, take.name, clip.name, input(e).checked), `Set ${clip.name} mirrored`)} />
          </label>
          <h4 class="clip-heading">Compression</h4>
          <label class="import-row" title="Largest allowed object-space bone error, millimetres; empty: the project's setting">
            <span>Error (mm)</span>
            <input type="number" min={0} step={0.01} aria-label="Compression error" placeholder="project" disabled={disabled} value={clip.compression.error ?? ""} onChange={(e) => run(setCompression(anim, takes, take.name, clip.name, { error: input(e).value === "" ? null : Number(input(e).value) }), `Set the compression error of ${clip.name}`)} />
          </label>
          <label class="import-row" title="Clips sampled faster than this are resampled, Hz; empty: the project's setting">
            <span>Max rate (Hz)</span>
            <input type="number" min={1} step={1} aria-label="Compression max rate" placeholder="project" disabled={disabled} value={clip.compression.maxRate ?? ""} onChange={(e) => run(setCompression(anim, takes, take.name, clip.name, { maxRate: input(e).value === "" ? null : Number(input(e).value) }), `Set the compression rate of ${clip.name}`)} />
          </label>
          <ReportRows report={report} saved={saved} compiling={compiling} dirty={props.dirty} onCompile={() => void compile()} />
          <h4 class="clip-heading">Markers</h4>
          <MarkerRows rows={clip.markers} at={inClip} disabled={disabled} onChange={(rows) => run(setMarkers(anim, takes, take.name, clip.name, rows), `Edit the markers of ${clip.name}`)} />
          <h4 class="clip-heading">Events</h4>
          <EventRows rows={clip.events} at={inClip} disabled={disabled} onChange={(rows) => run(setEvents(anim, takes, take.name, clip.name, rows), `Edit the events of ${clip.name}`)} />
          <h4 class="clip-heading">Curves</h4>
          <CurveRows rows={clip.curves} at={inClip} disabled={disabled} onChange={(rows) => run(setCurves(anim, takes, take.name, clip.name, rows), `Edit the curves of ${clip.name}`)} />
        </>
      )}
    </>
  );
}

/** The loop pose-match indicator beside the Loop box. */
function LoopIndicator(props: { match: ReturnType<typeof poseMatch> | null; loop: boolean }) {
  const m = props.match;
  if (!m) return null;
  if (m.bones === 0) return <Chip tone="neutral" title="The take has no bone tracks to compare">No bones to compare</Chip>;
  const detail = `first and last pose differ by ${(m.translation * 1000).toFixed(1)} mm, ${m.rotationDeg.toFixed(1)}°${m.scale > 1e-4 ? `, scale ${m.scale.toFixed(3)}` : ""}`;
  if (m.matches) return <Chip tone="success" title={`Loops cleanly: ${detail}`}>Pose matches</Chip>;
  return (
    <Chip tone={props.loop ? "warning" : "neutral"} title={`${detail}; ${m.worstBone} differs most. Move From or To until the poses meet.`}>
      {props.loop ? "Pose pops" : "Pose differs"}: {m.worstBone}
    </Chip>
  );
}

function RootMotionRows(props: { clip: ReturnType<typeof clipsOfTake>[number]; bones: readonly string[]; boneMap: Readonly<Record<string, string>>; disabled: boolean; onChange(rm: import("../../../../engine/animation/animSource").RootMotion | null, label: string): void }) {
  const { clip, bones, disabled } = props;
  const rm = clip.rootMotion;
  return (
    <>
      <label class="import-row" title="Extract a root curve from a bone's motion (the character moves, the pose stays in place)">
        <span>Root motion</span>
        <input
          type="checkbox"
          aria-label="Root motion"
          disabled={disabled}
          checked={rm !== null}
          onChange={(e) => props.onChange(input(e).checked ? { bone: props.boneMap.Root ?? props.boneMap.Hips ?? bones[0] ?? "", axes: ["x", "z", "yaw"], bakeIntoPose: false } : null, `Set root motion of ${clip.name}`)}
        />
      </label>
      {rm && (
        <>
          <label class="import-row">
            <span>Bone</span>
            <select aria-label="Root motion bone" disabled={disabled} value={rm.bone} onChange={(e) => props.onChange({ ...rm, bone: select(e).value }, `Set the root motion bone of ${clip.name}`)}>
              {!bones.includes(rm.bone) && <option value={rm.bone}>{rm.bone || "(none)"}</option>}
              {bones.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <div class="import-row" role="group" aria-label="Root motion axes">
            <span>Axes</span>
            <span class="skeleton-actions">
              {ROOT_MOTION_AXES.map((axis) => (
                <label key={axis} class="clip-axis">
                  <input type="checkbox" aria-label={`Axis ${axis}`} disabled={disabled} checked={rm.axes.includes(axis)} onChange={(e) => props.onChange(rootMotionWithAxis(rm, axis, input(e).checked), `Set the root motion axes of ${clip.name}`)} /> {axis}
                </label>
              ))}
            </span>
          </div>
          <label class="import-row" title="Take the extracted motion out of the pose: the bone stays in place and the root carries the movement">
            <span>Bake into pose</span>
            <input type="checkbox" aria-label="Bake into pose" disabled={disabled} checked={rm.bakeIntoPose} onChange={(e) => props.onChange({ ...rm, bakeIntoPose: input(e).checked }, `Set root motion baking of ${clip.name}`)} />
          </label>
        </>
      )}
    </>
  );
}

function AdditiveRows(props: { clip: ReturnType<typeof clipsOfTake>[number]; others: readonly string[]; disabled: boolean; onChange(reference: string | null): void }) {
  const { clip, others, disabled } = props;
  const ref = clip.additive?.reference ?? null;
  const mode = ref === null ? "none" : ref === "first" ? "first" : "other";
  const [other, frame] = ref !== null && ref !== "first" ? [ref.slice(0, ref.lastIndexOf("#")), ref.slice(ref.lastIndexOf("#") + 1)] : ["", "0"];
  return (
    <>
      <label class="import-row" title="An additive clip is the difference from a reference pose, layered on another clip">
        <span>Additive</span>
        <select
          aria-label="Additive reference"
          disabled={disabled}
          value={mode}
          onChange={(e) => {
            const v = select(e).value;
            props.onChange(v === "none" ? null : v === "first" ? "first" : others[0] ? `${others[0]}#0` : "first");
          }}
        >
          <option value="none">Not additive</option>
          <option value="first">Against its first frame</option>
          <option value="other" disabled={others.length === 0}>
            Against a frame of another clip
          </option>
        </select>
      </label>
      {mode === "other" && (
        <div class="import-row">
          <span>Reference</span>
          <span class="skeleton-actions">
            <select aria-label="Additive reference clip" disabled={disabled} value={other} onChange={(e) => props.onChange(`${select(e).value}#${frame}`)}>
              {!others.includes(other) && <option value={other}>{other}</option>}
              {others.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input type="number" min={0} step={1} aria-label="Additive reference frame" title="Frame number" disabled={disabled} value={frame} onChange={(e) => props.onChange(`${other}#${Math.max(0, Math.round(Number(input(e).value)) || 0)}`)} />
          </span>
        </div>
      )}
    </>
  );
}

function ReportRows(props: { report: ReportState; saved: boolean; compiling: boolean; dirty: boolean; onCompile(): void }) {
  const { report } = props;
  const s = report.state === "ready" ? describeReport(report.report) : null;
  return (
    <div class="import-row" aria-label="Compile report">
      <span title="What the compressor made of the clip as saved">Compiled</span>
      <span class="clip-report">
        {s ? (
          <>
            <span>{s.size}</span>
            <span class="clip-report-dim">({s.raw}, {s.ratio})</span>
            <Chip tone={s.withinBounds ? "success" : "danger"} title={s.withinBounds ? "Every error met its bound" : "Some error is above its bound"}>
              max error {s.maxError}
            </Chip>
          </>
        ) : report.state === "failed" ? (
          <span class="clip-report-problem" role="alert">{report.error}</span>
        ) : (
          <span class="clip-report-dim">{props.saved ? "Not compiled yet" : "Apply to compile"}</span>
        )}
        <button disabled={!props.saved || props.dirty || props.compiling || !clipCompileService()} title={!props.saved ? "Apply the settings first: the compile reads the saved sidecar" : props.dirty ? "Apply or revert the settings first" : "Compile the clip now and read its report"} onClick={props.onCompile}>
          {props.compiling ? "Compiling…" : "Compile"}
        </button>
      </span>
      {report.state === "ready" && report.problems.length > 0 && <span class="clip-report-dim">{report.problems.join("; ")}</span>}
    </div>
  );
}

/** The preview: the model (or a profile-compatible character) and the playhead's controls. */
function PreviewRow(props: { path: string; animation: ModelAnimation; anim: ReturnType<typeof animationOf>; playhead: ClipPlayhead; length: number; source: AnimSource | null }) {
  const { path, playhead, source } = props;
  const [shown, setShown] = useState(path);
  const [note, setNote] = useState<string | null>(null);
  const files = editor.project.current?.files ?? [];
  const choices = otherModels(files, path);
  const pick = async (other: string) => {
    setNote(null);
    if (other === path) return setShown(path);
    const loaded = (await loadModel(`asset:${other}`).catch(() => null))?.animation;
    const profile = readProfile(props.anim.profile);
    const mine = props.animation.skeleton;
    if (!loaded?.skeleton || !mine || !profile) return setNote(`${editor.assets.fileName(other)} has no skeleton.`);
    const side = (a: ModelAnimation, p: string | null) => ({ profile: p, boneMap: a.boneMap, bones: a.skeleton!.bones.map((b) => b.name) });
    if (!profileCompatible(profile, side({ ...props.animation, boneMap: Object.keys(props.anim.boneMap).length ? props.anim.boneMap : props.animation.boneMap }, props.anim.profile), side(loaded, loaded.skeleton.profile))) {
      return setNote(`${editor.assets.fileName(other)} isn't compatible: it needs the same profile and a bone for each required role.`);
    }
    setShown(other);
  };
  const time = playhead.time.value;
  const playing = playhead.playing.value;
  // The posed preview: the draft's clip served from memory, played on the shown model's Animator at the playhead.
  const driver = useMemo(() => new PosedClipPreview(), []);
  useEffect(() => () => driver.dispose(), [driver]);
  useEffect(() => driver.setClip(ROLE, source ? previewClipOfSource(driver.files, source) : null), [driver, source]);
  driver.setTime(time);
  const posed = usePosedScene([{ role: ROLE, path: shown }]);
  return (
    <div class="clip-import-preview">
      {choices.length > 0 && (
        <label class="import-row" title="Preview the clip on this model, or on another character with the same skeleton profile">
          <span>Preview on</span>
          <select aria-label="Preview on" value={shown} onChange={(e) => void pick(select(e).value)}>
            <option value={path}>{editor.assets.fileName(path)} (this model)</option>
            {choices.map((f) => (
              <option key={f} value={f}>
                {editor.assets.fileName(f)}
              </option>
            ))}
          </select>
        </label>
      )}
      {note && <p class="skeleton-note" role="status">{note}</p>}
      <LargePreview path={shown} posed={posed.scene ? driver.content(posed.key, posed.scene) : undefined} />
      <div class="clip-preview-controls">
        <button type="button" aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={() => playhead.toggle()}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input type="range" aria-label="Clip time" min={0} max={props.length} step={Math.max(props.length / 1000, 0.001)} value={time} onInput={(e) => playhead.seek(Number(input(e).value))} />
        <span class="clip-preview-time">
          {seconds(time)} / {seconds(props.length)}
        </span>
      </div>
      {posed.state === "none" && <p class="skeleton-note">The model has no skeleton, so it shows at rest.</p>}
    </div>
  );
}
