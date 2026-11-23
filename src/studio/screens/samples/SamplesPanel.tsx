// The Samples panel (ADR 0342 "Samples are assets"; the prototype's library): the project's audio files and derived
// samples by folder in the editor's TreeView, a search that flattens the matches with their folders, folder
// operations (new, rename, move, delete moving the contents up), drag to move, context menus, Move to… (the kit's
// MoveToDialog), and the empty state with Import samples…. Rename and move are the engine's asset operations, so
// references (playlists, scenes) follow and the file on disk is what changes; deleting a sample moves its file to the
// project's trash, with Undo on the toast (`sampleTrash.ts`).
import { useState } from "preact/hooks";
import { isDerivedSamplePath, sampleEditsFromSidecar } from "../../../engine/audio/sample/format";
import { parseImportSettings, sidecarPath } from "../../../engine/scene/importSettings";
import { restoreSample, trashSample } from "./sampleTrash";
import { folderEntry } from "../../../editor/assetEntry";
import { moveAssets, newFolder, renameAsset, whyNotValidName } from "../../../editor/assetOps";
import { moveSourceVersions } from "./sampleVersions";
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
import { allSamples, audioFolders, cleanFolderName, fileChip, folderOf, libraryTree, metaLine, moveUpPlan, nameOf, searchSamples, usesOf, type LibraryFolder } from "./sampleLibrary";
import { lengthOf, peaksOf } from "./sampleSession";
import { dialog, openSample, openSamplePath } from "./samplesState";
import { waveColumns } from "../../components/waveformModel";

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

/** A tiny waveform (24 columns) from the peaks, once read. */
function MiniWave(props: { project: EditorProject; path: string }) {
  const src = isDerivedSamplePath(props.path) ? (parseDerivedSample(props.project.assets.get(props.path), props.path).sample.source || null) : props.path;
  const mips = src ? peaksOf(props.project, src) : null;
  if (!mips) return <span class="smp-mini" aria-hidden="true" />;
  const cols = waveColumns(mips, { start: 0, end: mips.frames / mips.rate }, 24);
  return (
    <svg class="smp-mini" viewBox="0 0 24 12" aria-hidden="true" preserveAspectRatio="none">
      {Array.from(cols.max, (hi, i) => (Number.isNaN(hi) ? null : <rect key={i} x={i} y={6 - hi * 6} width={0.8} height={Math.max(0.5, (hi - cols.min[i]) * 6)} />))}
    </svg>
  );
}

/** The engine's asset moves, then the moved samples' source versions with them (ADR 0342, per machine). */
async function moveSamples(moves: readonly (readonly [string, string])[], verb?: string): Promise<boolean> {
  const ok = await moveAssets(moves, verb);
  const project = currentProject.peek();
  if (ok && project) await moveSourceVersions(project, moves);
  return ok;
}

/** The engine's rename of `entry` (a file, or a folder entry) to `name`; `from` → `to` are the project paths it changes. */
async function renameSample(entry: string, name: string, from: string, to: string): Promise<boolean> {
  const ok = await renameAsset(entry, name);
  const project = currentProject.peek();
  if (ok && project) await moveSourceVersions(project, [[from, to]]);
  return ok;
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
  if (!project) return null;
  const folders = audioFolders(project.folders, project.files);
  const tree = libraryTree(project.files, folders);
  const count = allSamples(tree).length;
  const open = openSamplePath.value;
  const readOnly = !project.canSave;

  const meta = (path: string) => {
    const { edits, derived } = editsOf(project, path);
    return { line: metaLine(path, edits, derived ? null : lengthOf(project, path), derived), chip: fileChip(edits) };
  };

  const deleteSample = async (path: string) => {
    // Owner decision 2: no question first; the file goes to the project's trash and the toast's Undo brings it back.
    const uses = usesOf(path, project.files, (p) => project.assets.get(p));
    const r = await trashSample(project, path).catch((err: unknown) => ({ refused: err instanceof Error ? err.message : String(err) }));
    if ("refused" in r) {
      status.value = { kind: "info", text: `Can't delete ${nameOf(path)}: ${r.refused}.` };
      return;
    }
    if (open === path) openSample(null);
    toasts.show({
      text: `Deleted ${nameOf(path)}${uses.length ? ` · ${uses.length} use${uses.length === 1 ? "" : "s"} left without audio until it's back` : ""}`,
      undo: () =>
        void restoreSample(project, r.trashed).then((back) => {
          if ("refused" in back) status.value = { kind: "info", text: `Can't bring ${nameOf(path)} back: ${back.refused}.` };
          else if (open === path) openSample(path);
        }),
    });
  };

  const deleteFolder = async (folder: string) => {
    const plan = moveUpPlan(folder, project.files, project.folders);
    const up = folderOf(folder) || project.name;
    const ok = await confirmInEditor({
      title: `Delete folder ${nameOf(folder)}?`,
      message: plan.length ? `Its ${plan.length} item${plan.length === 1 ? "" : "s"} move up to ${up}; nothing is removed from the project.` : "It's empty.",
      confirmLabel: "Delete folder",
    });
    if (!ok.ok) return;
    if (plan.length && !(await moveSamples(plan, "Moved"))) return;
    try {
      await project.deleteFolder(folder);
      docVersion.value++;
      toasts.show({ text: `Deleted folder ${nameOf(folder)}` });
    } catch (err) {
      status.value = { kind: "error", text: `Couldn't delete ${folder}: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const addFolder = async (parent: string) => {
    const path = await newFolder(parent);
    if (path) {
      setClosed((c) => new Set([...c].filter((f) => f !== parent)));
      setTimeout(() => renameRow(TREE, `f:${path}`), 0);
    }
  };

  const sampleMenu = (path: string, x: number, y: number) =>
    setMenu({
      x, y, label: `${nameOf(path)} menu`,
      entries: tidyEntries([
        { id: "open", label: "Open", run: () => openSample(path) },
        { id: "rename", label: "Rename", hint: "F2", disabled: readOnly, title: "Renames the file; references follow", run: () => renameRow(TREE, `s:${path}`) },
        SEPARATOR,
        { id: "duplicate", label: "Duplicate", disabled: readOnly, title: "A new sample with the same edits; no audio is copied", run: () => (openSample(path), (dialog.value = { kind: "fork", mode: "duplicate" })) },
        { id: "fork", label: "Fork as new sample…", disabled: readOnly, run: () => (openSample(path), (dialog.value = { kind: "fork", mode: "fork" })) },
        { id: "move", label: "Move to…", disabled: readOnly, run: () => setMoving([path]) },
        SEPARATOR,
        { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: readOnly, title: "Moves it to the project's trash; Undo brings it back", run: () => void deleteSample(path) },
      ]),
    });

  const folderMenu = (folder: string, x: number, y: number) =>
    setMenu({
      x, y, label: `${nameOf(folder)} folder menu`,
      entries: tidyEntries([
        { id: "new", label: "New folder", disabled: readOnly, run: () => void addFolder(folder) },
        { id: "rename", label: "Rename", hint: "F2", disabled: readOnly, run: () => renameRow(TREE, `f:${folder}`) },
        { id: "move", label: "Move to…", disabled: readOnly, run: () => setMoving([folder]) },
        folderOf(folder) !== "" && { id: "top", label: "Move to top level", disabled: readOnly, run: () => void moveSamples([[folder, nameOf(folder)]]) },
        SEPARATOR,
        { id: "delete", label: "Delete folder", danger: true, disabled: readOnly, run: () => void deleteFolder(folder) },
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
        const to = target ? `${target}/${nameOf(path)}` : nameOf(path);
        void moveSamples([[path, to]]).then((ok) => {
          if (ok) {
            toasts.show({ text: `${nameOf(path)} → ${target ? target.split("/").join(" › ") : "top level"}` });
            if (open === path) openSample(to);
          }
        });
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
      label: nameOf(path),
      expandable: false,
      open: false,
      selected: open === path,
      className: "smp-row",
      attrs: { "data-sample": path },
      title: path,
      icon: <MiniWave project={project} path={path} />,
      trailing: (
        <span class="smp-row-meta">
          <span class="smp-muted">{withPath ? `${folderOf(path) || "top level"} · ${m.line}` : m.line}</span>
          {m.chip && <Chip tone="success" title={`From the file: ${m.chip}. The file isn't changed unless you use Write to file`}>cues</Chip>}
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
            commit: (name) => {
              const keepExt = nameOf(path).match(/(\.sample\.json|\.[^.]+)$/i)?.[0] ?? "";
              const next = name.toLowerCase().endsWith(keepExt.toLowerCase()) ? name : `${name}${keepExt}`;
              if (next === nameOf(path)) return;
              const bad = whyNotValidName(next);
              if (bad) return void (status.value = { kind: "info", text: `Can't rename: ${bad}.` });
              const to = folderOf(path) ? `${folderOf(path)}/${next}` : next;
              void renameSample(path, next, path, to).then((ok) => ok && open === path && openSample(to));
            },
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
          commit: (name) => {
            const clean = cleanFolderName(name);
            if (clean && clean !== f.name) void renameSample(folderEntry(f.path), clean, f.path, folderOf(f.path) ? `${folderOf(f.path)}/${clean}` : clean);
          },
        },
    remove: readOnly ? undefined : () => void deleteFolder(f.path),
    drag: startDrag(f.path),
  });

  const found = query.trim() ? searchSamples(project.files, query) : null;
  const rows = found ? found.map((p) => sampleRow(p, true)) : [...tree.folders.map(folderRow), ...tree.samples.map((s) => sampleRow(s))];

  return (
    <Panel
      class="smp-library"
      toolbar={
        <div class="smp-library-bar">
          <input type="search" placeholder={`Search ${count} sample${count === 1 ? "" : "s"}`} aria-label="Search samples" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
          <button class="smp-tool smp-icon-button" title="New folder (inside the selected folder)" aria-label="New folder" disabled={readOnly} onClick={() => void addFolder(folderSel ?? "")}>
            <Icon name="folderPlus" />
          </button>
          <button class="smp-tool smp-tool-icon" title={readOnly ? "Open a project folder to import" : "Import samples… (files or a folder)"} aria-label="Import…" disabled={readOnly} onClick={() => (dialog.value = { kind: "import" })}>
            <Icon name="import" />
            <span class="smp-hide-narrow">Import…</span>
          </button>
        </div>
      }
    >
      {count === 0 && !found ? (
        <EmptyState
          title="No samples yet"
          icon={<Icon name="samples" size={28} />}
          body={<p>Import WAV, OGG, MP3 or FLAC files, or a folder of them. Their cue points, loops, tempo and root note come along.</p>}
          action={{ label: "Import samples…", disabled: readOnly, title: readOnly ? "Open a project folder to import" : undefined, run: () => (dialog.value = { kind: "import" }) }}
        />
      ) : found && found.length === 0 ? (
        <p class="smp-muted smp-pad" role="status">No sample's name holds “{query.trim()}”.</p>
      ) : (
        <>
          {dragging && (
            <div class={`smp-toplevel${dropOn === "" ? " drop" : ""}`} data-drop-folder="">
              <Icon name="chevronUp" /> Top level
            </div>
          )}
          <TreeView tree={TREE} label="Samples" rows={rows} />
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
            void moveSamples(items.map((p) => [p, folder ? `${folder}/${nameOf(p)}` : nameOf(p)] as const)).then((ok) => {
              if (ok && open && items.includes(open)) openSample(folder ? `${folder}/${nameOf(open)}` : nameOf(open));
            });
          }}
        />
      )}
    </Panel>
  );
}
