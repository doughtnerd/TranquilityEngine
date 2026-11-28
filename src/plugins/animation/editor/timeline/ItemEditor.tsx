// The item editor (ADR 0373): the fields of the one item selected on the timeline, under the grid. Start moves the item and
// Length trims its end; a clip adds its source, offset, speed and eases; a camera cut or control its action and target;
// signals, audio, markers and activation spans reuse the Animation window's row editor (`RowEditor.tsx`) on the same
// tracks. Each change is one labelled undo step through the window's `onItems` and `onApply`; a refused change says why
// in the status bar and leaves the item as it was (`timelineEditLogic.ts`).
import { CONTROL_ACTIONS, type ControlAction } from "../../../../engine/animation/tracks";
import type { Timeline } from "../../../../engine/animation/timeline";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { AssetPicker, type EditResult, assetRefTarget } from "../../../../editor/sdk";
import { RowEditor, ROW_EDITOR_KINDS } from "../animationWindow/RowEditor";
import { BindingPicker } from "./BindingPicker";
import { asClip, fromClipEdit, moveItems, patchItem, trimItem, type ItemsResult } from "./timelineEditLogic";
import { isTimelineRef, itemSpan, keyedKeys, parseItemId, refName,} from "./timelineModelLogic";

export interface ItemEditorProps {
  readonly timeline: Timeline;
  /** The selected item's id. */
  readonly id: string;
  readonly root: GameObject | null;
  /** The timeline's own file (a clip can't be itself). */
  readonly file: string | null;
  onItems(result: EditResult<ItemsResult>, label: string): void;
  onApply(result: EditResult<Timeline>, label: string): void;
  /** Open the nested timeline `ref`. */
  onOpen(ref: string): void;
}

const value = (e: Event) => (e.currentTarget as HTMLInputElement).value;
const num = (e: Event) => Number(value(e));
const sec = (t: number) => Math.round(t * 1000) / 1000;

export function ItemEditor(props: ItemEditorProps) {
  const { timeline: tl, id, root } = props;
  const ref = parseItemId(id);
  const span = itemSpan(tl, id);
  const track = ref && tl.tracks[ref.track];
  if (!ref || !span || !track) return null;
  const key = ref.kind === "key" ? keyedKeys(track)?.[ref.index] : undefined;
  const ranged = !!key && key.end !== undefined && (key.end > key.time || track.kind === "subclip" || track.kind === "activation");
  const timing = (
    <>
      <label>
        Start (s)
        <input type="number" min={0} max={tl.duration} step={1 / tl.rate} value={sec(span[0])} onChange={(e) => props.onItems(moveItems(tl, [id], num(e) - span[0]), "Set start")} />
      </label>
      {ranged && (
        <label>
          Length (s)
          <input type="number" min={1 / tl.rate} max={tl.duration} step={1 / tl.rate} value={sec(span[1] - span[0])} onChange={(e) => props.onItems(trimItem(tl, id, "end", span[0] + num(e)), "Set length")} />
        </label>
      )}
    </>
  );

  if (track.kind === "subclip" && key) {
    const clip = String(key.clip);
    const patch = (p: Parameters<typeof patchItem>[2], label: string) => props.onApply(patchItem(tl, id, p, props.file ?? undefined), label);
    return (
      <div class="aw-row-editor" role="group" aria-label="Clip">
        <span class="aw-re-head">
          Clip <b>{refName(clip)}</b>
        </span>
        {timing}
        <label>
          Clip
          <AssetPicker value={clip} kinds={["animclip", "timeline"]} label="Clip source" none={null} accepts={(p) => p !== props.file} onCommit={(v) => patch({ clip: v }, "Set clip")} />
        </label>
        <label>
          Offset (s)
          <input type="number" min={0} step={1 / tl.rate} value={sec(key.offset as number)} onChange={(e) => patch({ offset: num(e) }, "Set clip offset")} />
        </label>
        <label>
          Speed
          <input type="number" step={0.1} value={key.speed as number} onChange={(e) => patch({ speed: num(e) }, "Set clip speed")} />
        </label>
        <label title="Fade in over the start of the clip; where clips overlap this is the crossfade.">
          Ease in (s)
          <input type="number" min={0} step={1 / tl.rate} value={sec(key.blendIn as number)} onChange={(e) => patch({ blendIn: num(e) }, "Set ease-in")} />
        </label>
        <label>
          Ease out (s)
          <input type="number" min={0} step={1 / tl.rate} value={sec(key.blendOut as number)} onChange={(e) => patch({ blendOut: num(e) }, "Set ease-out")} />
        </label>
        {isTimelineRef(clip) && (
          <button type="button" class="aw-tb" title="Open this nested timeline in the window" onClick={() => props.onOpen(assetRefTarget(clip))}>
            Open timeline
          </button>
        )}
      </div>
    );
  }

  if (track.kind === "control" && key) {
    const action = key.action as ControlAction;
    const target = (key.target as string | undefined) ?? "";
    return (
      <div class="aw-row-editor" role="group" aria-label="Control item">
        <span class="aw-re-head">{action === "cameraCut" ? "Camera cut" : "Control"}</span>
        {timing}
        <label>
          Action
          <select aria-label="Action" value={action} onChange={(e) => props.onApply(patchItem(tl, id, { action: value(e) as ControlAction }), "Set control action")}>
            {CONTROL_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a === "cameraCut" ? "Camera cut" : a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target
          <BindingPicker path={target} root={root} label="Control target" onPick={(p) => props.onApply(patchItem(tl, id, { target: p }), "Set control target")} />
        </label>
      </div>
    );
  }

  if (ref.kind === "key" && ROW_EDITOR_KINDS.has(track.kind)) {
    return (
      <>
        <div class="aw-row-editor" role="group" aria-label="Timing">
          {timing}
        </div>
        <RowEditor clip={asClip(tl)} track={ref.track} index={ref.index} onApply={(r, label) => props.onApply(fromClipEdit(tl, r), label)} />
      </>
    );
  }

  return (
    <div class="aw-row-editor" role="group" aria-label="Key">
      <span class="aw-re-head">Key</span>
      {timing}
    </div>
  );
}
