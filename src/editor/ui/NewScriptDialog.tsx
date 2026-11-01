import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { SCRIPT_KINDS, scriptId, scriptName, whyNotScriptName, type ScriptKind } from "../scriptTemplates";

interface Request {
  /** The kinds to offer (the first is chosen to start with). */
  kinds: readonly ScriptKind[];
  /** Folder the script goes in, under `scripts/`. */
  folder: string;
  /** The project's scripts, to check the name against. */
  scripts: ReadonlyMap<string, string>;
  resolve: (r: { kind: ScriptKind; name: string } | null) => void;
}

const pending = signal<Request | null>(null);

/** Ask for a new script's kind and name (ADR 0030). Resolves null if cancelled. */
export function askNewScript(options: Omit<Request, "resolve">): Promise<{ kind: ScriptKind; name: string } | null> {
  pending.value?.resolve(null);
  return new Promise((resolve) => (pending.value = { ...options, resolve }));
}

/** The New Script dialog: a kind, a name, and what file and id that makes. Enter creates, Escape cancels. */
export function NewScriptDialog() {
  const p = pending.value;
  const [kind, setKind] = useState<ScriptKind>("behavior");
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!p) return;
    setKind(p.kinds[0]);
    setTyped("");
    input.current?.focus();
  }, [p]);
  if (!p) return null;
  const name = scriptName(typed);
  const problem = typed.trim() ? whyNotScriptName(name, p.folder, p.scripts) : null;
  const close = (create: boolean) => {
    pending.value = null;
    p.resolve(create ? { kind, name } : null);
  };
  const canCreate = typed.trim() !== "" && problem === null;
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div
        class="dialog new-script"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-script-title"
        onKeyDown={(e) => {
          e.stopPropagation(); // keep editor shortcuts out while typing a name
          if (e.key === "Escape") {
            e.preventDefault();
            close(false);
          } else if (e.key === "Enter" && canCreate) {
            e.preventDefault();
            close(true);
          }
        }}
      >
        <h2 id="new-script-title">New script</h2>
        {p.kinds.length > 1 && (
          <fieldset class="new-script-kinds">
            <legend>Make a</legend>
            {SCRIPT_KINDS.filter((k) => p.kinds.includes(k.kind)).map((k) => (
              <label key={k.kind} title={k.hint}>
                <input type="radio" name="script-kind" checked={kind === k.kind} onChange={() => setKind(k.kind)} />
                {k.label}
              </label>
            ))}
          </fieldset>
        )}
        <label class="new-script-name">
          Name
          <input ref={input} type="text" aria-label="Script name" placeholder="EnemySpawner" value={typed} onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <p class={`new-script-preview${problem ? " problem" : ""}`} aria-live="polite">
          {problem ?? (name ? `${p.folder}/${name}.ts · registers ${scriptId(name)}` : SCRIPT_KINDS.find((k) => k.kind === kind)!.hint)}
        </p>
        <div class="dialog-buttons">
          <button onClick={() => close(false)}>Cancel</button>
          <button class="primary" disabled={!canCreate} onClick={() => close(true)}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
