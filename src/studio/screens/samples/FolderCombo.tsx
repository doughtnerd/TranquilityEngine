// The folder combo (the prototype's `.fdd`/`.fddm`, spec §3.11: no native pickers in dialogs), shared by Import's Into
// folder and the Fork / Save snippet dialogs' Folder: a 26 px trigger (folder icon, the value, a caret) opening a menu
// with a search ("Search folders or type a new one"), Top level and the folders indented by depth. Typing filters to
// paths ("Vehicles › HoverBike") and offers + New folder "…" when nothing matches exactly; Enter picks the first match
// or makes the new folder. ↑ ↓ move, Escape closes.
import { useRef, useState } from "preact/hooks";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { usePopover } from "../../../editor/ui/popover";
import { Icon } from "../../components/Icon";
import { SampleIcon } from "./sampleIcons";
import { folderChoices } from "./sampleLibrary";

const crumbs = (path: string) => (path ? path.split("/").join(" › ") : "Top level");

export function FolderCombo(props: { value: string; folders: readonly string[]; label: string; onChange(folder: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setQuery("");
    setHi(0);
  };
  usePopover(pop, open, { anchor: button.current, inside: [button], onDismiss: close });
  const { folders, create } = folderChoices(props.folders, query);
  const rows: { folder: string; isNew: boolean }[] = [...folders.map((f) => ({ folder: f, isNew: false })), ...(create ? [{ folder: create, isNew: true }] : [])];
  const pick = (f: string) => {
    props.onChange(f);
    close();
    button.current?.focus();
  };
  const isNew = props.value !== "" && !props.folders.includes(props.value);
  return (
    <>
      <button ref={button} type="button" class="smp-fddb" aria-haspopup="listbox" aria-expanded={open} aria-label={`${props.label}: ${crumbs(props.value)}`} title="Browse or type to search" onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="folder" size={13} />
        <span class="smp-ellipsis smp-fddv">{crumbs(props.value)}{isNew ? " (new)" : ""}</span>
        <SampleIcon name="caret" size={9} />
      </button>
      {open && (
        <FloatingPortal>
          <div ref={pop} class="smp-popover smp-fddm" role="dialog" aria-label={props.label}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => (rows.length ? (h + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const r = rows[hi] ?? rows[0];
                if (r) pick(r.folder);
              }
            }}>
            <input type="search" class="smp-fxq" placeholder="Search folders or type a new one" aria-label="Search folders or type a new one" autoFocus value={query} onInput={(e) => (setQuery((e.currentTarget as HTMLInputElement).value), setHi(0))} />
            <div role="listbox" aria-label="Folders" class="smp-fdd-list">
              {rows.length === 0 && <p class="smp-tci-line smp-muted">No folders match</p>}
              {rows.map((r, i) => {
                const depth = query.trim() || r.folder === "" ? 0 : r.folder.split("/").length - 1;
                return (
                  <button key={`${r.isNew}${r.folder}`} type="button" role="option" aria-selected={!r.isNew && r.folder === props.value} class={`smp-tci${i === hi ? " hi" : ""}`} style={{ paddingLeft: `${8 + depth * 12}px` }}
                    onPointerEnter={() => setHi(i)} onClick={() => pick(r.folder)}>
                    {r.isNew ? <Icon name="folderPlus" size={13} /> : r.folder === "" ? <Icon name="chevronUp" size={13} /> : <Icon name="folder" size={13} />}
                    <span class="smp-tci-label">{r.isNew ? `New folder “${crumbs(r.folder)}”` : query.trim() ? crumbs(r.folder) : r.folder === "" ? "Top level" : r.folder.split("/").pop()}</span>
                    {!r.isNew && r.folder === props.value && <span class="smp-tci-check">✓</span>}
                  </button>
                );
              })}
            </div>
            {!query.trim() && <p class="smp-tci-line smp-muted">Type a name or path to make a new folder</p>}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
