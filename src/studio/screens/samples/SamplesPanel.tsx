// The Samples panel (ADR 0342 "Samples are assets"; the prototype's library): the project's audio files and derived
// samples by folder in the editor's TreeView, a search that flattens the matches with their folders, folder
// operations (new, rename, move, delete moving the contents up), drag to move, context menus, Move to… (the kit's
// MoveToDialog), Copy / Paste here / Duplicate (Ctrl+C / V / D), audio files dropped from the OS (the import review),
// two-line rows with a filled 46×20 thumbnail, folder counts with a hover Delete, the split Add button (Import samples… /
// New folder), Collapse all, and with no samples the prototype's centred card over the dock ("No samples yet", Import
// samples…). Rename, move, new folder and both deletes are the Studio asset
// library's (`sampleFiles.ts`, ADR 0433), so references (playlists, scenes) follow and the file on disk is what changes;
// deleting a sample moves its file to the project's trash, and a folder's contents move up, with Undo on the toast.
import { openMixDocument } from "../mixer/mixerDocument";
import { applyEdit } from "../../../editor/sdk/editResult";
import { FOLDER_COLOURS, folderColour, folderColourCss, setFolderColour } from "./folderColours";
import { useRef, useState } from "preact/hooks";
import { createPortal } from "preact";
import { signal } from "@preact/signals";
import { isDerivedSamplePath, sampleEditsFromSidecar } from "../../../engine/audio/sample/format";
import { parseImportSettings, sidecarPath } from "../../../engine/scene/importSettings";
import { sampleFiles } from "./sampleFiles";
import { currentProject, docVersion, status } from "../../../editor/state";
import type { EditorProject } from "../../../editor/projects";
import { Chip } from "../../../editor/ui/Chip";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { MoveToDialog } from "../../../editor/ui/MoveToDialog";
import { Panel } from "../../../editor/ui/panel/Panel";
import { renameRow, TreeView, type TreeRow } from "../../../editor/ui/TreeView";
import { confirmInEditor } from "../../../editor/ui/ConfirmDialog";
import { parseDerivedSample } from "../../../engine/audio/sample/format";
import { Icon } from "../../components/Icon";
import { toasts } from "../../shell/studioServices";
import { allSamples, audioFolders, fileChip, folderOf, libraryTree, metaLine, nameOf, sampleName, searchSamples, type LibraryFolder } from "./sampleLibrary";
import { lengthOf, peaksOf, sampleSession } from "./sampleSession";
import { filesOfDrop } from "../../../editor/assetImportFiles";
import { deriveSample, freeSamplePath, stemOf, writeDerived } from "./sampleWrites";
import { SampleIcon } from "./sampleIcons";
import { dialog, openSample, openSamplePath } from "./samplesState";
import { envelopeRuns, waveColumns } from "../../components/waveformModel";

const TREE = "studio-samples";

function editsOf(project: EditorProject, path: string) {
  if (isDerivedSamplePath(path)) return { edits: null, derived: parseDerivedSample(project.assets.get(path), path).sample };
  const meta = sidecarPath(path);
  if (!project.files.includes(meta)) return { edits: null, derived: null };
  try {
    const s = parseImportSettings(project.assets.get(meta), meta).settings;
    return { edits: s.sample || s.loopStart !== null ? sampleEditsFromSidecar(s) : null, derived: null };
  } catch {
    return { edits: null, derived: null };
  }
}

/** The row's 46×20 thumbnail: the sample's filled envelope (the prototype's), once its peaks are read. */
function MiniWave(props: { project: EditorProject; path: string }) {
  const src = isDerivedSamplePath(props.path) ? (parseDerivedSample(props.project.assets.get(props.path), props.path).sample.source || null) : props.path;
  const mips = src ? peaksOf(props.project, src) : null;
  if (!mips) return <span class="smp-thumb" aria-hidden="true" />;
  const runs = envelopeRuns(waveColumns(mips, { start: 0, end: mips.frames / mips.rate }, 46));
  const d = runs.map((r) => {
    const top = r.amps.map((a, i) => `${r.x + i},${(10 - Math.max(0.4, a * 9)).toFixed(1)}`);
    const bottom = r.amps.map((a, i) => `${r.x + i},${(10 + Math.max(0.4, a * 9)).toFixed(1)}`).reverse();
    return `M${[...top, ...bottom].join("L")}Z`;
  }).join("");
  return (
    <svg class="smp-thumb" viewBox="0 0 46 20" aria-hidden="true" preserveAspectRatio="none">
      <path d={d} />
    </svg>
  );
}

/** The sample copied with Ctrl+C or the menu's Copy (Paste here makes a duplicate of it). */
const copied = signal<string | null>(null);

/** ADR 0362 item 4: set or clear a folder's colour, one step of `audio.json`'s history. */
function editFolderColour(folder: string, colour: string | null): void {
  const doc = openMixDocument(currentProject.peek());
  if (!doc) return;
  const before = doc.value.peek();
  applyEdit(setFolderColour(before, folder, colour), colour === null ? "Clear folder colour" : "Folder colour", (next, label) => doc.edit(next, { label }), before);
}

export function SamplesPanel() {
  docVersion.value; // follow writes and moves
  const project = currentProject.value;
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [folderSel, setFolderSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; label: string } | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [osDrop, setOsDrop] = useState(false);
  const addCaret = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  const mixDoc = openMixDocument(project);
  const mixValue = mixDoc?.value.value ?? null;
  const folders = audioFolders(project.folders, project.files);
  const tree = libraryTree(project.files, folders);
  const count = allSamples(tree).length;
  const open = openSamplePath.value;
  const readOnly = !project.canSave;

  const meta = (path: string) => {
    const { edits, derived } = editsOf(project, path);
    return { line: metaLine(path, edits, derived ? null : lengthOf(project, path), derived), chip: fileChip(edits) };
  };

  // Owner decision 2: no question first; the file goes to the project's trash and the toast's Undo brings it back.
  const deleteSample = (path: string) => void sampleFiles.deleteFile(path);

  const deleteFolder = async (folder: string) => {
    const plan = sampleFiles.folderDeletePlan(folder);
    const ok = await confirmInEditor({
      title: `Delete folder ${nameOf(folder)}?`,
      message: plan.items ? `Its ${plan.items} item${plan.items === 1 ? "" : "s"} move up to ${plan.to || project.name}; nothing is removed from the project.` : "It's empty.",
      confirmLabel: "Delete folder",
    });
    if (ok.ok) await sampleFiles.deleteFolder(folder);
  };

  const addFolder = async (parent: string) => {
    const path = await sampleFiles.newFolder(parent);
    if (path) {
      setClosed((c) => new Set([...c].filter((f) => f !== parent)));
      setTimeout(() => renameRow(TREE, `f:${path}`), 0);
    }
  };

  /** A duplicate of `path` in `folder`: a new sample with the same edits; no audio is copied (Paste here, Duplicate). */
  const duplicateInto = async (path: string, folder: string) => {
    const session = sampleSession(project, path);
    const to = freeSamplePath(project, folder, `${stemOf(path)}_copy`);
    try {
      await writeDerived(project, to, deriveSample("duplicate", path, session.source.peek(), session.edits.peek()));
      toasts.show({ text: `Duplicated ${nameOf(path)} as ${nameOf(to)}${folder !== folderOf(path) ? ` in ${folder ? folder.split("/").join(" › ") : "the top level"}` : ""}` });
      openSample(to);
    } catch (err) {
      status.value = { kind: "error", text: `Couldn't duplicate ${nameOf(path)}: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const copy = (path: string) => {
    copied.value = path;
    toasts.show({ text: `Copied ${nameOf(path)} · Paste here (Ctrl+V) makes a duplicate` });
  };
  const sampleMenu = (path: string, x: number, y: number) =>
    setMenu({
      x, y, label: `${nameOf(path)} menu`,
      entries: tidyEntries([
        { kind: "group", label: sampleName(path) },
        { id: "rename", label: "Rename", hint: "F2", disabled: readOnly, title: "Renames the file; references follow", run: () => renameRow(TREE, `s:${path}`) },
        { id: "settings", label: "Import settings…", title: "Its Load and encoding settings, in the Inspector", run: () => openSample(path) },
        { id: "disk", label: "Show on disk", title: "Where the file is in the project folder", run: () => toasts.show({ text: `On disk: ${project.root ? `${project.root}/` : ""}${isDerivedSamplePath(path) ? path : path}` }) },
        SEPARATOR,
        { id: "copy", label: "Copy", hint: "Ctrl+C", run: () => copy(path) },
        { id: "paste", label: "Paste here", hint: "Ctrl+V", disabled: readOnly || !copied.value, title: copied.value ? `A duplicate of ${nameOf(copied.value)} in this folder` : "Copy a sample first", run: () => copied.value && void duplicateInto(copied.value, folderOf(path)) },
        { id: "duplicate", label: "Duplicate", hint: "Ctrl+D", disabled: readOnly, title: "A new sample with the same edits; no audio is copied", run: () => void duplicateInto(path, folderOf(path)) },
        { id: "fork", label: "Fork as new sample…", hint: "Ctrl+Shift+S", disabled: readOnly, run: () => (openSample(path), (dialog.value = { kind: "fork", mode: "fork" })) },
        SEPARATOR,
        { id: "move", label: "Move to…", disabled: readOnly, run: () => setMoving([path]) },
        folderOf(path) !== "" && { id: "top", label: "Move to top level", disabled: readOnly, run: () => void sampleFiles.move([path], "") },
        SEPARATOR,
        { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: readOnly, title: "Moves it to the project's trash; Undo brings it back", run: () => void deleteSample(path) },
      ]),
    });

  const folderMenu = (folder: string, x: number, y: number) =>
    setMenu({
      x, y, label: `${nameOf(folder)} folder menu`,
      entries: tidyEntries([
        { kind: "group", label: nameOf(folder) },
        { id: "rename", label: "Rename", hint: "F2", disabled: readOnly, run: () => renameRow(TREE, `f:${folder}`) },
        { id: "new", label: "New folder inside", disabled: readOnly, run: () => void addFolder(folder) },
        { id: "paste", label: "Paste here", hint: "Ctrl+V", disabled: readOnly || !copied.value, title: copied.value ? `A duplicate of ${nameOf(copied.value)} in this folder` : "Copy a sample first", run: () => copied.value && void duplicateInto(copied.value, folder) },
        { id: "move", label: "Move to…", disabled: readOnly, run: () => setMoving([folder]) },
        {
          id: "colour", label: "Colour", disabled: readOnly || !mixDoc, run: () => {},
          submenu: [
            { id: "colour-none", label: "Default", checked: folderColour(mixValue, folder) === null, run: () => editFolderColour(folder, null) },
            ...FOLDER_COLOURS.map((c) => ({ id: `colour-${c.colour}`, label: c.name, checked: folderColour(mixValue, folder) === c.colour, run: () => editFolderColour(folder, c.colour) })),
          ],
        },
        folderOf(folder) !== "" && { id: "top", label: "Move to top level", disabled: readOnly, run: () => void sampleFiles.move([folder], "") },
        SEPARATOR,
        { id: "delete", label: "Delete folder", hint: "Del", danger: true, disabled: readOnly, run: () => void deleteFolder(folder) },
      ]),
    });

  /** Drag a row onto a folder row (or the top-level target) to move it. */
  const startDrag = (path: string) => (e: PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    let target: string | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      started = true;
      setDragging(path);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drop-folder]");
      target = el ? el.dataset.dropFolder! : null;
      if (target !== null && (target === path || target.startsWith(`${path}/`) || folderOf(path) === target)) target = null;
      setDropOn(target);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragging(null);
      setDropOn(null);
      // A touch that turned into a scroll is cancelled and moves nothing (the row's menu has Move to… for touch).
      if (ev.type === "pointerup" && started && target !== null) {
        void sampleFiles.move([path], target);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const sampleRow = (path: string, withPath = false): TreeRow => {
    const m = meta(path);
    return {
      key: `s:${path}`,
      label: sampleName(path),
      expandable: false,
      open: false,
      selected: open === path,
      className: "smp-row",
      attrs: { "data-sample": path },
      title: `${path} · drag onto a folder to move it · right-click for more · F2 renames`,
      icon: <MiniWave project={project} path={path} />,
      trailing: (
        <span class="smp-row-meta">
          <span class="smp-muted smp-ellipsis">{withPath ? `${folderOf(path) ? folderOf(path).split("/").join(" › ") : "Top level"} · ${m.line}` : m.line}</span>
          {m.chip && <Chip tone="success" title={`Read from the WAV: ${m.chip}. The file isn't changed unless you use Write to file`}>cues</Chip>}
        </span>
      ),
      dragging: dragging === path,
      setOpen: () => undefined,
      select: () => {
        setFolderSel(null);
        openSample(path);
      },
      menu: (x, y) => sampleMenu(path, x, y),
      activate: () => openSample(path),
      rename: readOnly
        ? null
        : {
            value: nameOf(path),
            label: "Sample name",
            selectTo: nameOf(path).length - (nameOf(path).toLowerCase().endsWith(".sample.json") ? 12 : (nameOf(path).match(/\.[^.]+$/)?.[0].length ?? 0)),
            // The typed name keeps the file's extension (the library's rule).
            commit: (name) => void sampleFiles.renameFile(path, name),
          },
      remove: readOnly ? undefined : () => void deleteSample(path),
      drag: startDrag(path),
    };
  };

  const folderRow = (f: LibraryFolder): TreeRow => ({
    key: `f:${f.path}`,
    label: f.name,
    expandable: true,
    open: !closed.has(f.path),
    selected: folderSel === f.path,
    className: "smp-folder",
    attrs: { "data-drop-folder": f.path },
    title: `${f.path} · double-click to rename · drop samples here · right-click for its colour`,
    icon: folderColourCss(mixValue, f.path) ? <span class="smp-folder-colour" style={{ color: folderColourCss(mixValue, f.path)! }}><Icon name="folder" size={13} /></span> : <Icon name="folder" size={13} />,
    trailing: (
      <span class="smp-folder-tail">
        <span class="smp-fcount">{allSamples(f).length}</span>
        {!readOnly && (
          <button type="button" class="smp-fdel" aria-label={`Delete folder ${f.name}`} title="Delete folder (what's inside moves up a level)"
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => (e.stopPropagation(), void deleteFolder(f.path))}>
            <SampleIcon name="trash" size={11} />
          </button>
        )}
      </span>
    ),
    drop: dropOn === f.path ? "into" : null,
    dragging: dragging === f.path,
    children: [...f.folders.map(folderRow), ...f.samples.map((s) => sampleRow(s))],
    setOpen: (o) => setClosed((c) => (o ? new Set([...c].filter((x) => x !== f.path)) : new Set([...c, f.path]))),
    select: () => setFolderSel(f.path),
    menu: (x, y) => folderMenu(f.path, x, y),
    activate: () => renameRow(TREE, `f:${f.path}`),
    rename: readOnly
      ? null
      : {
          value: f.name,
          label: "Folder name",
          commit: (name) => void sampleFiles.renameFolder(f.path, name),
        },
    remove: readOnly ? undefined : () => void deleteFolder(f.path),
    drag: startDrag(f.path),
  });

  const found = query.trim() ? searchSamples(project.files, query) : null;
  const rows = found ? found.map((p) => sampleRow(p, true)) : [...tree.folders.map(folderRow), ...tree.samples.map((s) => sampleRow(s))];

  const onTreeKeys = (e: KeyboardEvent) => {
    const row = (e.target as HTMLElement).closest?.("[role=treeitem]")?.querySelector<HTMLElement>("[data-sample], [data-drop-folder]");
    if (!row) return;
    const sample = row.dataset.sample ?? null;
    const folder = sample ? folderOf(sample) : row.dataset.dropFolder ?? "";
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "c" && sample) copy(sample);
    else if (mod && !e.shiftKey && e.key.toLowerCase() === "v" && copied.value && !readOnly) void duplicateInto(copied.value, folder);
    else if (mod && !e.shiftKey && e.key.toLowerCase() === "d" && sample && !readOnly) void duplicateInto(sample, folder);
    else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      const r = row.getBoundingClientRect();
      if (sample) sampleMenu(sample, r.left + 24, r.bottom);
      else folderMenu(folder, r.left + 24, r.bottom);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const dropTarget = (e: DragEvent) => !readOnly && !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  return (
    <Panel
      class={`smp-library${osDrop ? " os-drop" : ""}`}
      toolbar={
        <div class="smp-library-bar">
          <input type="search" placeholder={`Search ${count.toLocaleString("en")} sample${count === 1 ? "" : "s"}`} aria-label="Search samples" title="Search samples by name; results show each sample's folder" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
          <span class="smp-adsp" role="group" aria-label="Add">
            <button type="button" class="smp-adb" aria-label="Import samples…" title={readOnly ? "Open a project folder to import" : "Import samples… (or drop audio files on this panel)"} disabled={readOnly} onClick={() => (dialog.value = { kind: "import", into: folderSel ?? "" })}>
              <Icon name="plus" size={12} />
            </button>
            <button ref={addCaret} type="button" class="smp-adb caret" aria-label="More ways to add" aria-haspopup="menu" title="More: Import samples…, New folder" disabled={readOnly}
              onClick={() => {
                const r = addCaret.current!.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 2, label: "Add", entries: [
                  { id: "import", label: "Import samples…", title: "Add audio files to the selected folder", run: () => (dialog.value = { kind: "import", into: folderSel ?? "" }) },
                  SEPARATOR,
                  { id: "folder", label: "New folder", title: "Inside the selected folder, or at the top level", run: () => void addFolder(folderSel ?? "") },
                ] });
              }}>
              <SampleIcon name="caret" size={9} />
            </button>
          </span>
          <button type="button" class="smp-ibtn smp-plain" aria-label="Collapse all" title="Collapse all folders" onClick={() => setClosed(new Set(project.folders))}>
            <SampleIcon name="collapseAll" size={14} />
          </button>
        </div>
      }
    >
      {count === 0 && !found ? (
        <>
          <EmptyState compact title="No samples yet" body="Drop audio files here, or use +." />
          <EmptyProjectCard readOnly={readOnly} />
        </>
      ) : found && found.length === 0 ? (
        <p class="smp-muted smp-pad" role="status">No sample's name holds “{query.trim()}”.</p>
      ) : (
        <>
          {dragging && (
            <div class={`smp-toplevel${dropOn === "" ? " drop" : ""}`} data-drop-folder="">
              <Icon name="chevronUp" /> Top level
            </div>
          )}
          <div class="smp-tree" onKeyDown={onTreeKeys}
        onDragOver={(e) => {
          if (!dropTarget(e)) return;
          e.preventDefault();
          setOsDrop(true);
        }}
        onDragLeave={() => setOsDrop(false)}
        onDrop={(e) => {
          if (!dropTarget(e)) return;
          e.preventDefault();
          setOsDrop(false);
          const into = (e.target as HTMLElement).closest<HTMLElement>("[data-drop-folder]")?.dataset.dropFolder ?? folderSel ?? "";
          void filesOfDrop(e.dataTransfer!).then((dropped) => (dialog.value = { kind: "import", dropped, into }));
        }}>
        <TreeView tree={TREE} label="Samples" rows={rows} />
      </div>
        </>
      )}
      {menu && <ContextMenu entries={menu.entries} at={{ x: menu.x, y: menu.y }} label={menu.label} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveToDialog
          items={moving.map((p) => ({ path: p, folder: project.folders.includes(p) }))}
          folders={folders}
          noun="sample"
          rootName={project.name}
          onCancel={() => setMoving(null)}
          onMove={(folder) => {
            const items = moving;
            setMoving(null);
            void sampleFiles.move(items, folder);
          }}
        />
      )}
    </Panel>
  );
}

/**
 * The empty project (the prototype's trial board, spec §4.1.2): a centred card over the whole dock area, one line and
 * one button. Drawn into the dock (the Samples panel can't reach past its own box otherwise).
 */
function EmptyProjectCard(props: { readOnly: boolean }) {
  const dock = typeof document === "undefined" ? null : document.querySelector(".studio-dock");
  if (!dock) return null;
  return createPortal(
    <div class="smp-empty-overlay">
      <EmptyState
        title="No samples yet"
        icon={<Icon name="samples" size={28} />}
        body="Import audio files, or drop them on the Samples panel."
        action={{ label: "Import samples…", autoFocus: true, disabled: props.readOnly, title: props.readOnly ? "Open a project folder to import" : undefined, run: () => (dialog.value = { kind: "import" }) }}
      />
    </div>,
    dock,
  );
}
