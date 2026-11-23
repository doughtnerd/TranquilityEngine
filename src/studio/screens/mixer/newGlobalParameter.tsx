// "+ New parameter…" for the game's global parameters (UI pass J4.1, J5.1, J6.5): the New parameter dialog over a
// Global parameters host (the Mixer's session, or `audio.json`'s document on another screen), whose Create adds the
// parameter as one undo step of `audio.json` ("New parameter <name>") and hands its name to whoever asked, which picks
// it (a condition's parameter, an automation lane's input, a Blend axis, a Switch). `askNewGlobalParameter` opens it from
// code (Automate ◆ on a project with none); `NewGlobalParameterHost` is mounted once by a screen that asks.
import { signal } from "@preact/signals";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { NewParameterDialog } from "../../components/NewParameterDialog";
import type { NewParameterKind } from "../../components/newParameterModel";
import { addGlobalParameter } from "./globalParameters";
import type { GlobalParametersHost } from "./GlobalParametersPanel";

/** The dialog's note: where the parameter goes. */
export const GLOBAL_PARAMETER_NOTE = "A global parameter: the game sets it, and any playlist, bus or snapshot can read it.";

/** Add `def` to the host's global parameters as one undo step; whether it applied (a refusal is reported by the host). */
export function createGlobalParameter(host: GlobalParametersHost, def: ParameterDef): boolean {
  if (host.readOnly) return false;
  return host.commit(addGlobalParameter(host.project.peek(), def), `New parameter ${def.name}`);
}

export interface NewGlobalParameterDialogProps {
  readonly host: GlobalParametersHost;
  /** Only this kind (what the asking select reads). */
  readonly kind?: NewParameterKind;
  /** Created: its name (the asker picks it). */
  onCreated(name: string): void;
  onCancel(): void;
}

/** The New parameter dialog over a Global parameters host. */
export function NewGlobalParameterDialog(props: NewGlobalParameterDialogProps) {
  return (
    <NewParameterDialog
      existing={props.host.project.value.parameters.map((p) => p.name)}
      kind={props.kind}
      note={GLOBAL_PARAMETER_NOTE}
      onCancel={props.onCancel}
      onCreate={(def) => {
        if (createGlobalParameter(props.host, def)) props.onCreated(def.name);
      }}
    />
  );
}

const asked = signal<{ host: GlobalParametersHost; kind?: NewParameterKind; then(name: string): void; cancelled?(): void } | null>(null);

/** Open the dialog from code; `then` runs with the new parameter's name once it is added, `cancelled` if it isn't. */
export function askNewGlobalParameter(host: GlobalParametersHost, then: (name: string) => void, kind?: NewParameterKind, cancelled?: () => void): void {
  asked.peek()?.cancelled?.();
  asked.value = { host, kind, then, cancelled };
}

/** The same as a promise of the new parameter (null: cancelled), for the curve editor's "+ New parameter…". */
export function newGlobalParameter(host: GlobalParametersHost, kind?: NewParameterKind): Promise<ParameterDef | null> {
  return new Promise((resolve) =>
    askNewGlobalParameter(host, (name) => resolve(host.project.peek().parameters.find((p) => p.name === name) ?? null), kind, () => resolve(null)),
  );
}

/** Mounted once by a screen that calls `askNewGlobalParameter`. */
export function NewGlobalParameterHost() {
  const a = asked.value;
  if (!a) return null;
  return (
    <NewGlobalParameterDialog
      host={a.host}
      kind={a.kind}
      onCancel={() => {
        asked.value = null;
        a.cancelled?.();
      }}
      onCreated={(name) => {
        asked.value = null;
        a.then(name);
      }}
    />
  );
}
