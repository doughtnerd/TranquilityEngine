import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { canOpenFolders } from "../projectFs";
import { listSamples, type SampleInfo } from "../samples";
import { startActions } from "../startActions";
import { StartFooter, StartHeader } from "./StartBrand";
import { StartProjects } from "./StartProjects";

/** The samples served beside the editor, once listed (null while loading). */
const samples = signal<SampleInfo[] | null>(null);
/** The sample being opened or copied, so its buttons show it. */
const busy = signal<string | null>(null);

const sizeOf = (s: SampleInfo) => {
  const bytes = s.files.reduce((n, f) => n + f.size, 0);
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

async function run(id: string, action: () => Promise<void>): Promise<void> {
  busy.value = id;
  try {
    await action();
  } finally {
    busy.value = null;
  }
}

/**
 * What the editor shows with no project open (ADR 0031, 0038): the projects section (New
 * Project…, Open Project…, recent projects; `StartProjects`) and the samples that ship beside the
 * editor, to open read-only or (where folders open) copy into a folder to edit.
 * `chrome` is extra content laid over the card (the Projects window's own title controls).
 */
export function StartScreen({ chrome }: { chrome?: ComponentChildren } = {}) {
  useEffect(() => {
    if (samples.value === null) void listSamples().then((list) => (samples.value = list));
  }, []);
  const desktop = canOpenFolders(); // the desktop editor, or a browser that can open folders (ADR 0038)
  const list = samples.value;
  return (
    <div class="start-screen" role="dialog" aria-label="Start">
      <div class="start-card">
        {chrome}
        <StartHeader />
        <StartProjects />
        <section>
          <h2>Samples</h2>
          {list === null ? (
            <p class="start-note">Looking for samples…</p>
          ) : list.length === 0 ? (
            <p class="start-note">No samples ship with this editor.</p>
          ) : (
            <ul class="sample-list" aria-label="Samples">
              {list.map((s) => (
                <li key={s.id} class="sample">
                  <div class="sample-text">
                    <span class="sample-name">{s.name}</span>
                    {s.description && <span class="sample-description">{s.description}</span>}
                    <span class="sample-meta">
                      {s.files.length} files · {sizeOf(s)}
                    </span>
                  </div>
                  <div class="sample-actions">
                    <button disabled={busy.value !== null} title={`Open ${s.name} read-only`} onClick={() => void run(s.id, () => startActions().openSample(s))}>
                      {busy.value === s.id ? "Opening…" : "Open"}
                    </button>
                    {desktop && (
                      <button disabled={busy.value !== null} title={`Copy ${s.name} into a folder and open the copy to edit it`} onClick={() => void run(s.id, () => startActions().copySampleToFolder(s))}>
                        Make a Copy…
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <StartFooter />
      </div>
    </div>
  );
}
