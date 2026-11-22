// Small view parts the Mixer's panels share: the automation opener (one undo step for every lane the curve editor
// applies), a dB field, a meter fed by the runtime, and the frame every panel's content sits in (it carries
// `data-asset-document`, so the History panel and Ctrl+Z act on `audio.json` while a Mixer panel has the focus).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { AudioProject, MixAutomation } from "../../../engine/audio/project/types";
import { Meter } from "../../components/Meter";
import { formatDb, parseDb } from "../../components/faderModel";
import { automatableLanes, peakDb } from "./boardModel";
import { openCurveEditor } from "./curveEditor";
import { labelOn, setAutomation } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";

/** Open the curve editor on `name`'s lanes (`only`: "volume", "send:<return>", "fx:<id>"); Apply is one undo step. */
export function automate(session: MixerSession, name: string, only?: string): void {
  const p = session.project.peek();
  const lanes = automatableLanes(p, name, only);
  if (p.parameters.length === 0) return session.refuse(labelOn("Edit automation", name), "the project has no game parameters to drive automation yet");
  openCurveEditor({
    title: `Automate ${name}`,
    lanes,
    parameters: p.parameters,
    onApply(results) {
      let next: AudioProject = session.project.peek();
      for (const r of results) {
        const step = setAutomation(next, { on: name, target: r.target as MixAutomation["target"] }, r.lane);
        if ("refused" in step) return session.refuse(labelOn("Edit automation", name), step.refused);
        next = step.next;
      }
      session.commit({ next }, labelOn("Edit automation", name));
    },
  });
}

/** A level typed as text ("−6", "-inf"); commits on Enter or blur, Escape puts it back. */
export function DbField(props: { value: number; label: string; disabled?: boolean; onCommit(db: number): void }) {
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
  return <Meter peakDb={peakDb(reading)} orientation={props.orientation} scale={props.scale} label={`${name} meter`} tainted={tainted} />;
}

/** A Mixer panel's content frame. */
export function MixFrame(props: { session: MixerSession; class?: string; children: ComponentChildren; label?: string }) {
  return (
    <div class={`mx-frame ${props.class ?? ""}`} data-asset-document={props.session.deps.path} aria-label={props.label}>
      {props.children}
    </div>
  );
}
