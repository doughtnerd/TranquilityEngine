// The Bake dialog (ADR 0360 §6, §9): length (an endless generator becomes a loop of it), variations, folder, a Queue
// over the variations, and Replace uses; Bake calls G5's `bakeGenerator(path, options)` on the open project. When
// Bake can't run (no project, a read-only one, an embedded generator) the form shows and Bake is off with why. Escape
// or Cancel closes. A view over props.
import { useEffect, useRef, useState } from "preact/hooks";
import { cleanBakeOptions, type Availability, type BakeOptions } from "./bakeModel";

export interface BakeDialogProps {
  /** The generator's name ("coin"). */
  readonly name: string;
  readonly initial: BakeOptions;
  readonly availability: Availability;
  /** A bake is running. */
  readonly busy?: boolean;
  onBake(options: BakeOptions): void;
  onClose(): void;
}

export function BakeDialog(props: BakeDialogProps) {
  const [o, setO] = useState<BakeOptions>(props.initial);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const clean = cleanBakeOptions(o);
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
  const files = clean.variations === 1 ? "1 file" : `${clean.variations} files`;
  return (
    <div class="pl-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="pl-dialog" role="dialog" aria-modal="true" aria-label={`Bake ${props.name}`} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2 class="pl-dialog-title">Bake {props.name}</h2>
        <p class="pl-note">Renders the generator to 32-bit float mono WAV at 48 kHz beside it, with a sidecar that remembers where it came from.</p>
        <div class="gen-fields">
          {o.length !== undefined && (
            <>
              <label for="gen-bake-length">Length (s)</label>
              <input id="gen-bake-length" ref={first} type="number" min={0.05} max={60} step={0.05} value={o.length} onChange={(e) => setO({ ...o, length: num(e) })} />
            </>
          )}
          <label for="gen-bake-variations">Variations</label>
          <input id="gen-bake-variations" ref={o.length === undefined ? first : undefined} type="number" min={1} max={64} step={1} value={o.variations} onChange={(e) => setO({ ...o, variations: num(e) })} />
          <label for="gen-bake-folder">Folder</label>
          <input id="gen-bake-folder" type="text" value={o.folder} placeholder="Project folder" onChange={(e) => setO({ ...o, folder: (e.currentTarget as HTMLInputElement).value.trim() })} />
        </div>
        <label>
          <input type="checkbox" checked={clean.queue} disabled={clean.variations < 2} onChange={(e) => setO({ ...o, queue: (e.currentTarget as HTMLInputElement).checked })} /> Make a Queue playlist of the variations (random, avoid repeat)
        </label>
        <label>
          <input type="checkbox" checked={o.replaceUses} onChange={(e) => setO({ ...o, replaceUses: (e.currentTarget as HTMLInputElement).checked })} /> Replace uses: point the playlists that play the generator at the baked sample
        </label>
        {!props.availability.enabled && <p class="gen-off-reason" role="note">{props.availability.reason}</p>}
        <div class="pl-dialog-foot">
          <span class="pl-faint">{files}{clean.queue ? " and a Queue" : ""}</span>
          <button type="button" onClick={props.onClose}>Cancel</button>
          <button type="button" class="pl-primary" disabled={!props.availability.enabled || props.busy} title={props.availability.reason ?? undefined} onClick={() => props.onBake(clean)}>
            {props.busy ? "Baking…" : "Bake"}
          </button>
        </div>
      </div>
    </div>
  );
}
