// The Sample toolbar's Source version dropdown (spec §4.1.5, the prototype's layers button "v2 ▾"): the versions of
// the sample's audio this machine keeps (ADR 0342 "Source versions"), each with its length and when it came in, the
// flattened render as "F1 · flattened" when the sample plays one, then Re-import…. Picking a version restores it (one
// undo step: the edits stay and rebuild on that audio); picking the flattened render or the source moves the sample
// between them (Flatten's own step).
import { useEffect, useRef, useState } from "preact/hooks";
import type { SourceVersions } from "../../../engine/audio/sample/sourceVersions";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { toasts } from "../../shell/studioServices";
import { flatNumber, renderPathOf, unflattenSample } from "./sampleFlatten";
import { SampleIcon } from "./sampleIcons";
import { nameOf, shortLength } from "./sampleLibrary";
import { lengthOf, type SampleSession } from "./sampleSession";
import { readSourceVersions, restoreSourceVersion } from "./sampleVersions";
import { dialog } from "./samplesState";

const when = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  return d.toDateString() === today.toDateString() ? "today" : d.toLocaleDateString("en", { month: "short", day: "numeric" });
};

/** The button's text: "v2", "F1" while a render plays, "v1" with no versions kept. */
export function versionLabel(versions: SourceVersions, flat: number | null): string {
  if (flat !== null) return `F${flat}`;
  return `v${versions.current || 1}`;
}

export function VersionMenu(props: { session: SampleSession }) {
  const { session } = props;
  const [versions, setVersions] = useState<SourceVersions>({ current: 0, versions: [] });
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const e = session.edits.value;
  const source = session.source.value;
  // Re-read the list when the sample or its version changes (a re-import, an undo of one).
  useEffect(() => {
    let live = true;
    void readSourceVersions(session.project, session.path).then((v) => live && setVersions(v));
    return () => {
      live = false;
    };
  }, [session.path, e.sourceVersion, open]);
  const render = renderPathOf(session.project.files, source, e);
  const flat = render ? flatNumber(render) : null;
  const len = lengthOf(session.project, source);
  const derived = session.derived.value !== null;
  const restore = async (n: number) => {
    const r = await restoreSourceVersion(session, n, "seconds");
    if ("refused" in r) toasts.show({ text: `Can't switch to v${n}: ${r.refused}.` });
    else toasts.show({ text: `Switched ${nameOf(session.path)} to v${n} · edits rebuilt on it`, undo: () => session.undo() });
  };
  const rows: MenuEntry[] =
    versions.versions.length === 0
      ? [{ id: "v1", label: "v1", checked: flat === null, note: `the imported file${len !== null ? ` · ${shortLength(len)}` : ""}`, title: "The audio as imported; Re-import… keeps it as v1 and adds v2", run: () => flat !== null && unflattenSample(session) }]
      : versions.versions.map((v) => ({
          id: `v${v.n}`,
          label: `v${v.n}`,
          checked: flat === null && v.n === versions.current,
          note: [v.kind === "original" ? "imported" : "re-imported", when(v.at), v.length !== null ? shortLength(v.length) : ""].filter(Boolean).join(" · "),
          title: `${v.name} · switching is a step you can undo; your edits stay and rebuild on this audio`,
          run: () => (flat !== null && v.n === versions.current ? unflattenSample(session) : v.n !== versions.current && void restore(v.n)),
        }));
  const entries = tidyEntries([
    { kind: "group", label: `Source · ${nameOf(session.path)}` },
    ...rows,
    render !== null && { id: "flat", label: `F${flat ?? 1} · flattened`, checked: true, note: `from v${versions.current || 1} + ${e.effects.length} effect${e.effects.length === 1 ? "" : "s"}`, title: `Plays ${render}: the effects baked in`, run: () => undefined },
    SEPARATOR,
    { id: "reimport", label: "Re-import…", disabled: session.readOnly || derived, title: derived ? "A derived sample plays its parent's audio" : "Replace the audio with a new file, keeping the edits (the current audio is kept as a version)", run: () => (dialog.value = { kind: "reimport" }) },
  ]);
  const label = versionLabel(versions, flat);
  return (
    <>
      <button ref={button} type="button" class="smp-sbtn smp-strong" aria-label="Source version" aria-haspopup="menu" aria-expanded={open}
        title={`Source ${label}${versions.versions.length ? ` · ${versions.versions.length} version${versions.versions.length === 1 ? "" : "s"}` : ""} · click to switch takes or re-import`} onClick={() => setOpen(!open)}>
        <SampleIcon name="layers" size={14} />
        <span>{label}</span>
        <SampleIcon name="caret" size={9} />
      </button>
      {open && <ContextMenu entries={entries} at={button.current!} label="Source version" onClose={() => setOpen(false)} />}
    </>
  );
}
