// The Input dialog's view of an action set (ADR 0417): its name (the id), name in system queries and file; its actions
// A to Z with name, type, consume and where each is mapped (one click to the mapping), an action no context maps
// flagged with Map it in default; and Networking: send to the server, resent ticks, the precision of each analog
// action and the upload it costs. A code-defined set shows the same, read-only. The dialog makes every edit (one
// history step, across files when a type change converts mappings).
import { useState } from "preact/hooks";
import { actionSetProblems, type ActionSetFile } from "../../../engine/input/actionAssets";
import type { ActionKind } from "../../../engine/input/actions";
import {
  ACTION_KINDS,
  ACTION_KIND_LABELS,
  DEFAULT_REDUNDANCY,
  PRECISIONS,
  defaultKey,
  setActionConsume,
  setNetworked,
  setPrecision,
  setRedundancy,
  setSetKey,
  sortedActions,
  uploadEstimate,
  whyNotActionName,
  whyNotSetId,
} from "../../actionSetModel";
import { unmappedActions, type MappedIn, type SetEntry } from "../../inputDialogModel";
import { useDraftText } from "../draftText";

export interface ActionSetViewProps {
  readonly entry: SetEntry;
  /** Every set id in the list, for the id check. */
  readonly ids: readonly string[];
  readonly mapped: ReadonlyMap<string, readonly MappedIn[]>;
  /** The project can't be saved to. */
  readonly projectReadOnly: boolean;
  onEdit(next: ActionSetFile, label: string): void;
  onRenameSet(id: string): void;
  onAddAction(): void;
  onRenameAction(from: string, to: string): void;
  onRetype(name: string, to: ActionKind): void;
  onRemoveAction(name: string): void;
  onMapInDefault(name: string): void;
  onJump(path: string, index: number): void;
}

/** A text box committed on Enter or leaving it, with the reason its draft can't be used under it. */
function CheckedText(props: { label: string; value: string; placeholder?: string; readOnly: boolean; check(v: string): string | null; onCommit(v: string): void; mono?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const draft = useDraftText(props.value, (v) => {
    const t = v.trim();
    if (t === props.value) return setError(null);
    const why = props.check(t);
    setError(why);
    if (!why) props.onCommit(t);
  });
  return (
    <span class="input-checked">
      <input
        type="text"
        aria-label={props.label}
        aria-invalid={error ? true : undefined}
        class={props.mono ? "mono" : undefined}
        placeholder={props.placeholder}
        spellcheck={false}
        disabled={props.readOnly}
        {...draft.input}
        onInput={(e) => {
          draft.input.onInput(e);
          setError(null);
        }}
      />
      {error && <span class="input-field-error">{error}</span>}
    </span>
  );
}

export function ActionSetView(props: ActionSetViewProps) {
  const { entry } = props;
  const spec = entry.spec;
  const readOnly = props.projectReadOnly || entry.source === "code";
  const problems = spec ? actionSetProblems(spec) : [];
  const unmapped = new Set(unmappedActions(entry, props.mapped));
  const actions = spec ? sortedActions(spec).map((a) => ({ name: a.name, kind: a.type, consume: a.consume })) : [...entry.actions].sort((a, b) => a.name.localeCompare(b.name));
  const others = props.ids.filter((id) => id !== entry.id);
  const estimate = spec ? uploadEstimate(spec) : null;
  return (
    <section class="input-view" aria-label={`Action set ${entry.id}`}>
      {entry.source === "code" && (
        <p class="input-note">
          Defined in a script with <code>defineActions</code>, so it is read-only here. Change it in the script, or map its actions in a context.
        </p>
      )}
      {entry.clash && (
        <p class="input-warning" role="note">
          {entry.source === "asset" ? `A script also defines ${entry.id} with defineActions. This asset's set is the one used; delete one of them.` : `An action set asset also defines ${entry.id}, and the asset's set is the one used; delete one of them.`}
        </p>
      )}
      <div class="input-fields">
        <label class="input-field">
          <span>Name</span>
          {spec ? <CheckedText label="Set name" value={entry.id} readOnly={readOnly} mono check={(v) => whyNotSetId(v, others)} onCommit={props.onRenameSet} /> : <code>{entry.id}</code>}
        </label>
        {spec && (
          <label class="input-field">
            <span>Name in system queries</span>
            <CheckedText label="Name in system queries" value={spec.key ?? ""} placeholder={defaultKey(spec.id)} readOnly={readOnly} mono check={(v) => (v === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? null : "Use letters, digits and underscores.")} onCommit={(v) => props.onEdit(setSetKey(spec, v), "Set Name in System Queries")} />
          </label>
        )}
        <div class="input-field">
          <span>Asset path</span>
          <code class="input-path">{entry.path ?? "(a script)"}</code>
        </div>
      </div>
      {problems.length > 0 && (
        <ul class="input-problems" aria-label="Problems">
          {problems.map((p) => (
            <li key={p.field + p.message}>{p.field ? `${p.field}: ${p.message}` : p.message}</li>
          ))}
        </ul>
      )}

      <div class="input-section-head">
        <h3>Actions</h3>
        <span class="input-count">{actions.length}</span>
        {spec && (
          <button class="input-add" disabled={readOnly} onClick={props.onAddAction}>
            Add action
          </button>
        )}
      </div>
      {actions.length === 0 && <p class="input-note">No actions yet.</p>}
      <ul class="input-actions" aria-label="Actions">
        {actions.map((a) => {
          const where = props.mapped.get(`${entry.id}:${a.name}`) ?? [];
          return (
            <li key={a.name} class={`input-action${unmapped.has(a.name) ? " unmapped" : ""}`} aria-label={`Action ${a.name}`}>
              <div class="input-action-row">
                {spec ? <CheckedText label="Action name" value={a.name} readOnly={readOnly} mono check={(v) => whyNotActionName(spec, v, a.name)} onCommit={(v) => props.onRenameAction(a.name, v)} /> : <code class="input-action-name">{a.name}</code>}
                <select aria-label="Type" disabled={readOnly} value={a.kind} onChange={(e) => props.onRetype(a.name, e.currentTarget.value as ActionKind)}>
                  {ACTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ACTION_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Consume"
                  title="A performing mapping takes its controls, so lower-priority contexts don't see them"
                  disabled={readOnly}
                  value={a.consume === undefined ? "" : String(a.consume)}
                  onChange={(e) => {
                    if (!spec) return;
                    const v = e.currentTarget.value;
                    props.onEdit(setActionConsume(spec, a.name, v === "" ? undefined : v === "true"), "Set Consume");
                  }}
                >
                  <option value="">Consume (default)</option>
                  <option value="true">Consume</option>
                  <option value="false">Don't consume</option>
                </select>
                {spec && (
                  <button class="danger" disabled={readOnly} aria-label={`Remove ${a.name}`} title="Remove the action (its mappings stay, naming an action that's gone)" onClick={() => props.onRemoveAction(a.name)}>
                    ✕
                  </button>
                )}
              </div>
              {where.length > 0 ? (
                <div class="input-mapped-in" aria-label={`${a.name} is mapped in`}>
                  <span class="input-mapped-label">Mapped in</span>
                  {where.map((w) => (
                    <button key={`${w.path}:${w.index}:${w.fromScript ? "s" : ""}`} class="input-chip" title={`Go to ${w.context}${w.index >= 0 ? `, mapping ${w.index + 1}` : ""}`} onClick={() => props.onJump(w.path, w.index)}>
                      <span class="input-chip-context">{w.context}</span>
                      {w.controls.length > 0 ? w.controls.map((c) => <kbd key={c}>{c.replace(/^<(\w+)>\//, "$1 ")}</kbd>) : <em>no controls</em>}
                      {w.fromScript && <span class="input-tag">script</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <div class="input-unmapped">
                  <span>No context maps this action yet, so nothing triggers it.</span>
                  <button disabled={props.projectReadOnly} onClick={() => props.onMapInDefault(a.name)}>
                    Map it in default
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {spec && estimate && (
        <>
          <div class="input-section-head">
            <h3>Networking</h3>
          </div>
          <label class="input-check">
            <input type="checkbox" disabled={readOnly} checked={spec.networked === true} onChange={(e) => props.onEdit(setNetworked(spec, e.currentTarget.checked), "Set Networked")} />
            Send to the server
          </label>
          <p class="input-note">Sent every tick, after modifiers and triggers. Gameplay reads it the same way online and offline.</p>
          {spec.networked && (
            <>
              <label class="input-field">
                <span>Resent ticks</span>
                <RedundancyInput value={spec.redundancy} readOnly={readOnly} onCommit={(v) => props.onEdit(setRedundancy(spec, v), "Set Resent Ticks")} />
              </label>
              <table class="input-net" aria-label="Upload">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Type</th>
                    <th>Precision</th>
                    <th>Upload</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedActions(spec).map((a) => {
                    const q = spec.encoding?.[a.name]?.quantize;
                    const known = PRECISIONS.some((p) => p.quantize === q);
                    return (
                      <tr key={a.name}>
                        <td>{a.name}</td>
                        <td>{a.type}</td>
                        <td>
                          {a.type === "button" ? (
                            <span class="input-muted">on/off</span>
                          ) : (
                            <select aria-label={`${a.name} precision`} disabled={readOnly} value={known ? String(q ?? "") : "custom"} onChange={(e) => props.onEdit(setPrecision(spec, a.name, e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value)), "Set Precision")}>
                              {PRECISIONS.map((p) => (
                                <option key={p.label} value={p.quantize === undefined ? "" : String(p.quantize)}>
                                  {p.label}
                                </option>
                              ))}
                              {!known && <option value="custom">Step {q}</option>}
                            </select>
                          )}
                        </td>
                        <td>{estimate.perAction.get(a.name) ?? 0} B</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p class="input-note">
                Up to {estimate.perInput} B per tick per player; each packet carries {estimate.redundancy + 1} ticks, up to {estimate.perPacket} B.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function RedundancyInput(props: { value: number | undefined; readOnly: boolean; onCommit(v: number | undefined): void }) {
  const shown = props.value === undefined ? "" : String(props.value);
  const draft = useDraftText(shown, (text) => {
    if (text === shown) return;
    if (text.trim() === "") return props.onCommit(undefined);
    const v = Number(text);
    if (Number.isInteger(v) && v >= 0) props.onCommit(v);
  });
  return <input type="number" aria-label="Resent ticks" min={0} step={1} placeholder={String(DEFAULT_REDUNDANCY)} disabled={props.readOnly} {...draft.input} />;
}
