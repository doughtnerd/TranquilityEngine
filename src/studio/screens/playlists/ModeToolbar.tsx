// The Playlist panel's second toolbar row (the prototype's `.tb2.sub`): the six type icons (Clip, Queue, Switch, Blend,
// Layer, Sequence, `typeConversion.ts`), then the open type's own settings on the same row, sized to their content:
// a Queue's pick order, Avoid last and Continuous; a Switch's parameter and what happens when its label changes (When,
// How, length, and the fades in a popover off the row); a Blend's dimensions, its X (and Y) input, the voice-time
// length, fade, gain curve, While playing and Glide. A view over props: every change is a labelled body edit.
import type { ChangeHow, PlaylistBody, PlaylistType, BlendAxis } from "../../../engine/audio/playlist/types";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import { defaultEntryUse } from "../../../engine/audio/playlist/format";
import { NumberBox, SelectBox } from "../../../editor/ui/PanelFields";
import { Checkbox } from "../../components/Checkbox";
import { FadeShapeSelect } from "../../components/FadeShapeSelect";
import { Icon } from "../../components/Icon";
import { isNewParameter, NEW_PARAMETER, NEW_PARAMETER_LABEL, withNewParameter } from "../../components/newParameterModel";
import type { BodyEdit } from "./EntryList";
import { CURVE_GLYPHS, DIM_GLYPHS, FADE_GLYPHS, FOLLOW_GLYPHS, HOW_GLYPHS, IconSegments, MODE_GLYPHS, PICK_GLYPHS, WHEN_GLYPHS, type IconOption } from "./glyphs";
import { MiniPopover } from "./MiniPopover";
import { changeLength, setAxis, setBlend, setDimensions, setOnChange, setQueue, setSwitchParameter, voiceTimeAxis, withParameter, type EditContext } from "./playlistEdits";
import { playlistTitle, typeName } from "./playlistPaths";
import { convertType, typeOptions } from "./typeConversion";

type Edit = (label: string, edit: BodyEdit) => void;

export interface ModeToolbarProps {
  readonly body: PlaylistBody;
  readonly ctx: EditContext;
  readonly writable: boolean;
  /** Playlist files a Switch's transition can play. */
  readonly playlists: readonly string[];
  onEdit: Edit;
}

/** The prototype's mode tooltips ("<Mode>: what it does"); a refusal replaces Clip's. */
const MODE_TIPS: Record<PlaylistType, string> = {
  clip: "Clip: one use of a sample with its own trim, loop and voice settings; usable anywhere a playlist is",
  queue: "Queue: plays one entry per trigger, picked at random, shuffled or in order (round robin)",
  switch: "Switch: a labelled game parameter picks the entry",
  blend: "Blend: one or two game parameters, or voice time, crossfade the entries",
  layer: "Layer: plays every entry at once",
  sequence: "Sequence: tracks of clips on a timeline, with loops, markers and automation",
};

function modeOptions(b: PlaylistBody): IconOption<PlaylistType>[] {
  return typeOptions(b).map((o) => ({ value: o.value, label: o.label, glyph: MODE_GLYPHS[o.value], disabled: o.disabled, title: o.disabled ? `${o.label}: ${o.title}` : MODE_TIPS[o.value] }));
}

export function ModeToolbar(props: ModeToolbarProps) {
  const { body, writable, onEdit } = props;
  return (
    <div class="pl-tb sub" role="toolbar" aria-label="Playlist type and settings">
      <IconSegments<PlaylistType> label="Playlist type" value={body.type} options={modeOptions(body)} disabled={!writable}
        onChange={(t) => onEdit(`Mode: ${typeName(t)}`, (b) => convertType(b, t, props.ctx))} />
      {body.type === "queue" && <><span class="pl-vs" /><QueueSettings {...props} /></>}
      {body.type === "switch" && <><span class="pl-vs" /><SwitchSettings {...props} /></>}
      {body.type === "blend" && <><span class="pl-vs" /><BlendSettings {...props} /></>}
    </div>
  );
}

const PICKS: IconOption<"random" | "shuffle" | "roundRobin">[] = [
  { value: "random", label: "Random", title: "Random: an independent draw each time", glyph: PICK_GLYPHS.random },
  { value: "shuffle", label: "Shuffle", title: "Shuffle: every entry once, then reshuffle", glyph: PICK_GLYPHS.shuffle },
  { value: "roundRobin", label: "Round robin", title: "Round robin: in order, wrapping", glyph: PICK_GLYPHS.roundRobin },
];

function QueueSettings({ body, writable, onEdit }: ModeToolbarProps) {
  const q = body.queue!;
  return (
    <>
      <IconSegments label="Pick" value={q.pick} options={PICKS} disabled={!writable} onChange={(v) => onEdit("Play order", (b) => setQueue(b, { pick: v }))} />
      <label class="pl-tl" title="Never pick any of the last N picks again (Random)">
        Avoid last
        <NumberBox class="pl-n44" label="Avoid repeating the last N" value={q.avoidRepeat} min={0} max={5} step={1} digits={0} disabled={!writable || q.pick !== "random"} onValue={(v) => onEdit("Change setting", (b) => setQueue(b, { avoidRepeat: v }))} />
      </label>
      <span class="pl-vs" />
      <Checkbox label="Continuous" checked={!!q.continuous} disabled={!writable} title="Play entries back to back until stopped"
        onChange={(on) => onEdit("Change setting", (b) => setQueue(b, { continuous: on ? { gapMs: 0 } : null }))} />
      {q.continuous && (
        <label class="pl-tl" title="Gap between entries; a negative gap overlaps them with a crossfade of the shape beside it">
          gap
          <NumberBox class="pl-n56" label="Gap between entries" value={q.continuous.gapMs} min={-10000} max={60000} step={10} digits={0} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setQueue(b, { continuous: { ...b.queue!.continuous!, gapMs: v } }))} />
          ms
        </label>
      )}
      {q.continuous && q.continuous.gapMs < 0 && (
        <FadeShapeSelect label="Overlap crossfade shape" value={q.continuous.shape ?? "equalPower"} disabled={!writable}
          onValue={(v) => onEdit("Change setting", (b) => setQueue(b, { continuous: v === "equalPower" ? { gapMs: b.queue!.continuous!.gapMs } : { gapMs: b.queue!.continuous!.gapMs, shape: v } }))} />
      )}
    </>
  );
}

const WHENS: IconOption<ChangeHow["when"]>[] = [
  { value: "now", label: "Now", title: "Now: change immediately", glyph: WHEN_GLYPHS.now },
  { value: "beat", label: "Next beat", title: "Next beat: change on the next beat (music)", glyph: WHEN_GLYPHS.beat },
  { value: "bar", label: "Next bar", title: "Next bar: change on the next bar (music)", glyph: WHEN_GLYPHS.bar },
  { value: "exit", label: "Next Exit marker", title: "Next Exit marker: change at the playing entry's next Exit marker", glyph: WHEN_GLYPHS.exit },
  { value: "nextTrigger", label: "Next trigger", title: "Next trigger: the new label applies to the next voice", glyph: WHEN_GLYPHS.nextTrigger },
];
const HOWS: IconOption<ChangeHow["how"]>[] = [
  { value: "crossfade", label: "Crossfade", title: "Crossfade: fade from the old entry to the new one", glyph: HOW_GLYPHS.crossfade },
  { value: "cut", label: "Cut", title: "Cut: switch without a fade", glyph: HOW_GLYPHS.cut },
  { value: "transition", label: "Transition playlist", title: "Transition playlist: play a bridge between them", glyph: HOW_GLYPHS.transition },
];

const lengthOf = (c: ChangeHow) => ("ms" in c.length ? c.length.ms : c.length.beats);
export const unitOf = (c: ChangeHow) => ("ms" in c.length ? "ms" : "beats");

/** A change's When / How text ("on the next bar · crossfade 200 ms"), for the default rule row and the transition card. */
export function changeText(c: ChangeHow): string {
  const when = { now: "now", beat: "on the next beat", bar: "on the next bar", exit: "at the next Exit marker", nextTrigger: "on the next trigger" }[c.when];
  const how = c.how === "cut" ? "cut" : `${c.how === "transition" ? "transition" : "crossfade"} ${lengthOf(c)} ${unitOf(c)}`;
  return `${when} · ${how}`;
}

function SwitchSettings({ body, ctx, writable, onEdit, playlists }: ModeToolbarProps) {
  const s = body.switch!;
  const labelled = ctx.parameters.filter(isLabelled);
  const def = labelled.find((p) => p.name === s.parameter);
  const c = s.onChange;
  const set = (patch: Partial<ChangeHow>, label = "Change setting") => onEdit(label, (b) => setOnChange(b, patch));
  return (
    <>
      <label class="pl-tl">
        By
        <SelectBox
          label="Switch parameter"
          value={s.parameter}
          disabled={!writable || (labelled.length === 0 && !ctx.newParameter)}
          title={labelled.length === 0 ? "No labelled parameters yet: make one with + New parameter…, or a local one in the Inspector" : "The labelled game parameter that picks what plays"}
          options={[
            ...(s.parameter && !def ? [{ value: s.parameter, label: `${s.parameter} (missing)` }] : []),
            ...(s.parameter ? [] : [{ value: "", label: "Choose…" }]),
            ...labelled.map((p) => ({ value: p.name, label: p.name })),
            ...(ctx.newParameter ? [{ value: NEW_PARAMETER, label: NEW_PARAMETER_LABEL }] : []),
          ]}
          onValue={(v) => {
            if (!isNewParameter(v)) return onEdit("Change setting", (b) => setSwitchParameter(b, v, ctx));
            void ctx.newParameter?.("labelled").then((d) => d && onEdit("Change setting", (b) => setSwitchParameter(b, d.name, withParameter(ctx, d))));
          }}
        />
      </label>
      <span class="pl-vs" />
      <span class="pl-tl" title="What happens when the label changes while the Switch plays, unless a change rule below says otherwise">When it changes</span>
      <IconSegments label="When it changes: when" value={c.when} options={WHENS} disabled={!writable} onChange={(v) => set({ when: v })} />
      <IconSegments label="When it changes: how" value={c.how} options={HOWS} disabled={!writable} onChange={(v) => set({ how: v })} />
      {/* The length and the fades button wrap together: alone on a second row the ··· looked stray (V8). */}
      <span class="pl-tl">
        {c.how !== "cut" && (
          <>
            <NumberBox class="pl-n56" label="Change length" value={lengthOf(c)} min={0} max={9999} step={unitOf(c) === "ms" ? 10 : 0.25} digits={unitOf(c) === "ms" ? 0 : 2} disabled={!writable} onValue={(v) => set({ length: changeLength(c, v) })} />
            {unitOf(c)}
          </>
        )}
        <ChangeExtras change={c} writable={writable} playlists={playlists} name="Default change" set={set} />
      </span>
    </>
  );
}

/**
 * ADR 0350's finer change settings, in a popover off the row: the transition playlist (How = Transition), the fade-out
 * and fade-in shapes, letting the tail ring past an Exit marker, and the bridge's own fades.
 */
export function ChangeExtras(props: { readonly change: ChangeHow; readonly writable: boolean; readonly playlists: readonly string[]; readonly name: string; set(patch: Partial<ChangeHow>, label?: string): void }) {
  const { change: c, writable, set, name } = props;
  const transitionOf = c.transition?.kind === "linked" ? c.transition.playlist : "";
  return (
    <MiniPopover title={`${name}: fades`} buttonClass="pl-ib" buttonLabel={`${name}: fades and transition`} buttonTitle="Fade shapes, the tail and the transition playlist" button={<Icon name="more" size={13} />}>
      <div class="pl-pop-grid">
        {c.how === "transition" && (
          <>
            <span class="pl-faint">Transition</span>
            <SelectBox label={`${name}: transition playlist`} value={transitionOf} disabled={!writable}
              options={[{ value: "", label: "Choose…" }, ...props.playlists.map((p) => ({ value: p, label: playlistTitle(p) }))]}
              onValue={(v) => set({ transition: v ? { kind: "linked", playlist: v, ...defaultEntryUse() } : undefined })} />
          </>
        )}
        <span class="pl-faint">Fade out</span>
        <FadeShapeSelect label={`${name}: fade-out shape`} out value={c.shapeOut ?? "equalPower"} disabled={!writable || c.how === "cut"} onValue={(v) => set({ shapeOut: v === "equalPower" ? undefined : v })} />
        <span class="pl-faint">Fade in</span>
        <FadeShapeSelect label={`${name}: fade-in shape`} value={c.shapeIn ?? "equalPower"} disabled={!writable || c.how === "cut"} onValue={(v) => set({ shapeIn: v === "equalPower" ? undefined : v })} />
        <span />
        <Checkbox label="Let the tail ring" checked={c.tail !== false} disabled={!writable || c.when === "now" || c.when === "nextTrigger"}
          title="When the playing entry has an Exit marker and the change lands on it, the audio after the marker rings on under the next entry instead of being cut"
          onChange={(on) => set({ tail: on ? undefined : false })} />
        {c.how === "transition" && <BridgeFade change={c} which="transitionIn" writable={writable} set={set} name={name} />}
        {c.how === "transition" && <BridgeFade change={c} which="transitionOut" writable={writable} set={set} name={name} />}
      </div>
    </MiniPopover>
  );
}

function BridgeFade(props: { readonly change: ChangeHow; readonly which: "transitionIn" | "transitionOut"; readonly writable: boolean; readonly name: string; set(patch: Partial<ChangeHow>): void }) {
  const { change: c, which, writable, set, name } = props;
  const f = c[which];
  const what = which === "transitionIn" ? "fade in" : "fade out";
  return (
    <>
      <span class="pl-faint">Bridge {what}</span>
      <span class="pl-inline">
        <Checkbox label="Own" checked={!!f} disabled={!writable} title={`Off: the bridge uses the rule's length and ${what} shape`}
          onChange={(on) => set({ [which]: on ? { length: unitOf(c) === "ms" ? { ms: lengthOf(c) } : { beats: lengthOf(c) }, shape: (which === "transitionIn" ? c.shapeIn : c.shapeOut) ?? "equalPower" } : undefined })} />
        {f && (
          <>
            <NumberBox class="pl-n56" label={`${name}: bridge ${what} length`} value={"ms" in f.length ? f.length.ms : f.length.beats} min={0} max={9999} step={"ms" in f.length ? 10 : 0.25} digits={"ms" in f.length ? 0 : 2} disabled={!writable}
              onValue={(v) => set({ [which]: { ...f, length: "ms" in f.length ? { ms: Math.round(v) } : { beats: v } } })} />
            <span class="pl-unit">{"ms" in f.length ? "ms" : "beats"}</span>
            <FadeShapeSelect label={`${name}: bridge ${what} shape`} out={which === "transitionOut"} value={f.shape} disabled={!writable} onValue={(v) => set({ [which]: { ...f, shape: v } })} />
          </>
        )}
      </span>
    </>
  );
}

const VOICE_TIME = "__voiceTime";
const DIMS: IconOption<"1" | "2">[] = [
  { value: "1", label: "1D", title: "1D: one input sets the weights", glyph: DIM_GLYPHS["1"] },
  { value: "2", label: "2D", title: "2D: two inputs set the weights", glyph: DIM_GLYPHS["2"] },
];
const FADES: IconOption<"crossfade" | "layer">[] = [
  { value: "crossfade", label: "Crossfade", title: "Crossfade: neighbouring entries crossfade", glyph: FADE_GLYPHS.crossfade },
  { value: "layer", label: "Layer", title: "Layer: entries fade in and stay", glyph: FADE_GLYPHS.layer },
];
const CURVES: IconOption<"linear" | "equalPower">[] = [
  { value: "linear", label: "Linear", title: "Linear: gains follow the weights", glyph: CURVE_GLYPHS.linear },
  { value: "equalPower", label: "Equal power", title: "Equal power: gains are √weight, no dip mid-crossfade", glyph: CURVE_GLYPHS.equalPower },
];
const FOLLOWS: IconOption<"follow" | "hold">[] = [
  { value: "follow", label: "Follow", title: "Follow: the playing voice follows the value, smoothed by Glide", glyph: FOLLOW_GLYPHS.follow },
  { value: "hold", label: "Hold", title: "Hold: the voice keeps the value it started with", glyph: FOLLOW_GLYPHS.hold },
];

function BlendSettings({ body, ctx, writable, onEdit }: ModeToolbarProps) {
  const blend = body.blend!;
  const twoD = blend.axes.length === 2;
  const numeric = ctx.parameters.filter((p: ParameterDef) => !isLabelled(p));
  const base = [...numeric.map((p) => ({ value: p.name, label: p.name })), { value: VOICE_TIME, label: "Voice time" }];
  const options = ctx.newParameter && writable ? withNewParameter(base) : base;
  const axisValue = (a: BlendAxis) => ("voiceTime" in a ? VOICE_TIME : a.parameter);
  const pick = (k: 0 | 1, v: string) => {
    if (isNewParameter(v)) {
      void ctx.newParameter?.("numeric").then((def) => def && onEdit("Change setting", (b) => setAxis(b, k, { parameter: def.name }, withParameter(ctx, def))));
      return;
    }
    const a = blend.axes[k]!;
    onEdit("Change setting", (b) => setAxis(b, k, v === VOICE_TIME ? voiceTimeAxis("voiceTime" in a ? a.voiceTime : 2) : { parameter: v }, ctx));
  };
  const timeAxis = blend.axes.findIndex((a) => "voiceTime" in a) as -1 | 0 | 1;
  const time = timeAxis >= 0 ? (blend.axes[timeAxis as 0 | 1] as { voiceTime: number }).voiceTime : null;
  return (
    <>
      <IconSegments label="Blend dimensions" value={twoD ? "2" : "1"} options={DIMS} disabled={!writable} onChange={(v) => onEdit("Change setting", (b) => setDimensions(b, v === "2" ? 2 : 1, ctx))} />
      <label class="pl-tl">X<SelectBox label="Blend X axis" value={axisValue(blend.axes[0]!)} disabled={!writable} options={options} onValue={(v) => pick(0, v)} /></label>
      {twoD && <label class="pl-tl">Y<SelectBox label="Blend Y axis" value={axisValue(blend.axes[1]!)} disabled={!writable} options={options} onValue={(v) => pick(1, v)} /></label>}
      {time !== null && (
        <label class="pl-tl" title="How long voice time runs across the axis">
          <NumberBox class="pl-n44" label="Voice time length" value={time} min={0.2} max={30} step={0.1} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setAxis(b, timeAxis as 0 | 1, voiceTimeAxis(v), ctx))} />
          s
        </label>
      )}
      <span class="pl-vs" />
      {<IconSegments label="Fade" value={blend.fade} options={FADES} disabled={!writable} onChange={(v) => onEdit("Blend mode", (b) => setBlend(b, { fade: v }))} />}
      <IconSegments label="Gain curve" value={blend.curve} options={CURVES} disabled={!writable} onChange={(v) => onEdit("Gain curve", (b) => setBlend(b, { curve: v }))} />
      {(
        <>
          <span class="pl-vs" />
          <span class="pl-tl">While playing</span>
          <IconSegments label="While playing" value={blend.follow === "hold" ? "hold" : "follow"} options={FOLLOWS} disabled={!writable}
            onChange={(v) => onEdit(`While playing: ${v === "hold" ? "Hold" : "Follow"}`, (b) => setBlend(b, { follow: v === "hold" ? "hold" : { glideMs: typeof blend.follow === "object" ? blend.follow.glideMs : 120 } }))} />
          {blend.follow !== "hold" && (
            <label class="pl-tl">
              Glide
              <NumberBox class="pl-n56" label="Glide" value={blend.follow.glideMs} min={0} max={5000} step={10} digits={0} disabled={!writable} onValue={(v) => onEdit("Glide", (b) => setBlend(b, { follow: { glideMs: v } }))} />
              ms
            </label>
          )}
        </>
      )}
    </>
  );
}

