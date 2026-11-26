// Small view parts the Mixer's panels share: the automation opener (one undo step for every lane the curve editor
// applies), a dB field, a meter fed by the runtime, and the frame every panel's content sits in (it carries
// `data-asset-document`, so the History panel and Ctrl+Z act on `audio.json` while a Mixer panel has the focus).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { activeHistory } from "../../../editor/activeHistory";
import type { MenuEntry } from "../../../editor/ui/ContextMenu";
import { formatKeys, isMacPlatform } from "../../../editor/ui/keyCombo";
import { Meter } from "../../components/Meter";
import { formatDb, parseDb } from "../../components/faderModel";
import { peakDb } from "./boardModel";
import { openAutomationCurves } from "./curveEditor";
import { sessionParametersHost } from "./globalParametersHost";
import type { MixerSession } from "./mixerScreen";
import { askNewGlobalParameter } from "./newGlobalParameter";

/**
 * Open the curve editor on `name`'s automation (`only`: "volume", "send:<return>", "fx:<id>" is selected first); Apply is
 * one undo step. A project with no game parameter to drive it asks for one first (New parameter), then opens (J6.5).
 */
export function automate(session: MixerSession, name: string, only?: string): void {
  if (session.project.peek().parameters.length === 0 && !session.readOnly) {
    askNewGlobalParameter(sessionParametersHost(session), () => openAutomationCurves(session, name, only));
    return;
  }
  openAutomationCurves(session, name, only);
}

/** A level typed as text ("−6", "-inf"); commits on Enter or blur, Escape puts it back. */
export function DbField(props: { value: number; label: string; disabled?: boolean; title?: string; onCommit(db: number): void }) {
  const [text, setText] = useState(formatDb(props.value));
  useEffect(() => setText(formatDb(props.value)), [props.value]);
  const commit = () => {
    const db = parseDb(text);
    if (db === null || db === props.value) setText(formatDb(props.value));
    else props.onCommit(db);
  };
  return (
    <input
      class="mx-db"
      type="text"
      inputMode="decimal"
      value={text}
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") { setText(formatDb(props.value)); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

/** A meter on bus `name`, read from the runtime on each tick (silent when it isn't running). */
export function LiveMeter(props: { session: MixerSession; name: string; orientation?: "horizontal" | "vertical"; scale?: boolean }) {
  const { session, name } = props;
  void session.tick.value;
  const reading = session.deps.readBus?.(name) ?? null;
  const live = session.live;
  const tainted = !!live && (live.monitor.taint(name).length > 0 || live.compare.taintedFor(name));
  return <Meter peakDb={peakDb(reading)} orientation={props.orientation} scale={props.scale} label={`${name} meter`} tainted={tainted} frozen={session.levelsHeld()} />;
}

/**
 * A context menu's "Undo <last step>" (spec §4.3.2/§4.3.3): the history active when the menu opens (the row's
 * `audio.json`, as Ctrl+Z would act on), held so a press inside the menu doesn't change which history it is.
 */
export function undoEntry(): MenuEntry {
  const history = activeHistory.peek()?.history ?? null;
  const can = !!history?.canUndo;
  return { id: "undo", label: can && history!.undoLabel ? `Undo ${history!.undoLabel}` : "Undo", hint: formatKeys("Mod+Z", isMacPlatform()), disabled: !can, title: can ? undefined : "Nothing to undo", run: () => history?.undo() };
}

/** A Mixer panel's content frame. */
export function MixFrame(props: { session: MixerSession; class?: string; children: ComponentChildren; label?: string }) {
  return (
    <div class={`mx-frame ${props.class ?? ""}`} data-asset-document={props.session.deps.path} aria-label={props.label}>
      {props.children}
    </div>
  );
}
