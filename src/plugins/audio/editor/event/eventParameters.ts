// The Event editor's parameters (ADR 0158 §2): the event's own parameter list as a holder of the one parameter list
// (ADR 0304), and the audition values the sliders hold. A rename goes through the event references module
// (`engine/audio/eventReferences.ts`, ADR 0299) so every use follows; a remove keeps the uses, which then read a global
// parameter of that name or warn, as the parser says.
import { MAX_LOCAL_PARAMETERS, isLabelled, type AudioEventAsset, type ParameterDef } from "../../../../engine/audio/eventFormat";
import { renameEventName } from "../../../../engine/audio/eventReferences";
import { parameterList } from "../parameterList";

/** The event's own parameters (at most `MAX_LOCAL_PARAMETERS`). */
export const eventParameterList = parameterList<AudioEventAsset>({
  read: (event) => event.parameters,
  write: (event, parameters) => ({ ...event, parameters }),
  limit: MAX_LOCAL_PARAMETERS,
  rename: (event, from, to) => renameEventName(event, "parameter", "local", from, to),
  remove: (event, name) => ({ ...event, parameters: event.parameters.filter((p) => p.name !== name) }),
});

/**
 * The audition values for `parameters`: each parameter's value in `current` when it is still valid for it (a number in
 * range for a numeric one, one of its labels for a labelled one), else its default (a number, or the default label).
 */
export function auditionValues(parameters: readonly ParameterDef[], current: Readonly<Record<string, number | string>>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of parameters) {
    const v = current[p.name];
    if (isLabelled(p)) out[p.name] = typeof v === "string" && p.labels.includes(v) ? v : p.default;
    else out[p.name] = typeof v === "number" && v >= p.min && v <= p.max ? v : p.default;
  }
  return out;
}
