// The Voice button (the prototype's `.cvw`): a curve glyph and the use's gain ("−4 dB"), outlined in the accent when the
// use changes gain or pitch, a dot when it has running curves. A click opens the entry's curves in the curve editor; a
// right-click (or the context-menu key) opens the curve menu: Edit curves…, Copy curves, Paste curves, Turn automation
// off or on, Clear all automation (spec 2.6.3; pasting curves of another kind of target is refused).
import { useState } from "preact/hooks";
import type { EntryUse } from "../../../engine/audio/playlist/types";
import { ContextMenu, SEPARATOR } from "../../../editor/ui/ContextMenu";
import { copiedCurves, pasteRefusal } from "./curveClipboard";
import { allBypassed, bypassAll, voiceSummary, type VoiceCurveMap } from "./entryRowModel";
import { CurveGlyph } from "./glyphs";

export interface VoiceButtonProps {
  readonly use: Pick<EntryUse, "volume" | "pitch" | "curves">;
  /** Whose voice ("dirt_02"), for its name and menu title. */
  readonly name: string;
  readonly writable: boolean;
  /** Its text instead of the use's gain (a Switch label's own gain). */
  readonly text?: string;
  onOpen(): void;
  /** Write the curves (one undo step labelled `label`). */
  onCurves(curves: VoiceCurveMap, label: string): void;
}

export function VoiceButton(props: VoiceButtonProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const v = voiceSummary(props.use);
  const curves = props.use.curves;
  const has = Object.values(curves).some(Boolean);
  const off = allBypassed(curves);
  const refusal = pasteRefusal("voice");
  return (
    <>
      <button
        type="button"
        class={`pl-cvw${v.set ? " set" : ""}${v.shaped ? " shp" : ""}`}
        aria-label={`${props.name} voice: ${props.text ?? v.text}`}
        title={v.title}
        onClick={(e) => (e.stopPropagation(), props.onOpen())}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
          e.preventDefault();
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom });
        }}
      >
        <CurveGlyph />
        <span>{props.text ?? v.text}</span>
      </button>
      {menu && (
        <ContextMenu
          at={menu}
          label={`${props.name} curves`}
          onClose={() => setMenu(null)}
          entries={[
            { kind: "group", label: `${props.name} curves` },
            { id: "edit", label: "Edit curves…", hint: "Click", run: props.onOpen },
            SEPARATOR,
            { id: "copy", label: "Copy curves", disabled: !has, title: has ? undefined : "No curves to copy", run: () => (copiedCurves.value = { kind: "voice", from: props.name, curves }) },
            {
              id: "paste",
              label: copiedCurves.value && !refusal ? `Paste curves from ${copiedCurves.value.from}` : "Paste curves",
              disabled: !props.writable || refusal !== null,
              title: refusal ?? undefined,
              run: () => props.onCurves(structuredClone(copiedCurves.peek()!.curves) as VoiceCurveMap, `Paste curves · ${props.name}`),
            },
            {
              id: "bypass",
              label: off ? "Turn automation on" : "Turn automation off",
              disabled: !props.writable || !has,
              title: has ? "Keeps the curves; the voice plays as if it had none" : "No curves yet",
              run: () => props.onCurves(bypassAll(curves, !off), `${off ? "Automation on" : "Automation off"} · ${props.name}`),
            },
            { id: "clear", label: "Clear all automation", danger: true, disabled: !props.writable || !has, title: has ? undefined : "No curves yet", run: () => props.onCurves({}, `Clear curves · ${props.name}`) },
          ]}
        />
      )}
    </>
  );
}
