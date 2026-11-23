// The Mixer's one door to the shared curve editor (ADR 0346 "one curve editor"; the prototype's Bus curves): Automate ◆
// on a level, a send or an effect opens the dialog on every automatable property of that bus or return
// (`automationCurves.ts`), with the asked-for lane selected; Apply is one labelled undo step of `audio.json`.
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import { parameterInputs } from "../curveInputs";
import { applyAutomationResult, automationDialog } from "./automationCurves";
import { sessionParametersHost } from "./globalParametersHost";
import { newGlobalParameter } from "./newGlobalParameter";
import { labelOn } from "./mixEdits";
import type { MixerSession } from "./mixerScreen";

/** Open the curve editor on `name`'s automation (`only`: "volume", "send:<return>", "fx:<id>" is selected first). */
export function openAutomationCurves(session: MixerSession, name: string, only?: string, doc: Document = document): void {
  const label = labelOn("Edit automation", name);
  const dialog = automationDialog(session.project.peek(), name, only, session.testValues.peek());
  if ("refused" in dialog) return session.refuse(label, dialog.refused);
  const d = dialog.next;
  openCurveEditorDialog(doc, {
    ...d.spec,
    title: d.title,
    target: name,
    context: "Driven by game parameters",
    initialLane: d.initialLane,
    histogram: d.histogram,
    // "+ New parameter…" in Driven by: a new global parameter (one undo step of audio.json), then the curve follows it.
    newInput: session.readOnly ? undefined : async () => {
      const def = await newGlobalParameter(sessionParametersHost(session));
      return def ? parameterInputs([def], session.testValues.peek())[0]! : null;
    },
    onCancel: () => {},
    onApply(result) {
      if (session.readOnly) return session.refuse(label, "the mix is read-only");
      const r = applyAutomationResult(session.project.peek(), d, result);
      if ("refused" in r) return session.refuse(label, r.refused);
      if (r.next) session.commit({ next: r.next.project }, r.next.label);
    },
  });
}
