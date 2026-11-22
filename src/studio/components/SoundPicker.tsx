// The sound picker (ADR 0335 `SoundPicker`): a popover with a search box and the project's sounds in two sections,
// Playlists and Samples, each with its type badge and folder. Up and Down move through what is shown (skipping sounds
// that can't be picked here), Enter or a click picks, Escape or a click outside closes. The list comes from a provider
// the owner passes (the project's asset index); the picker returns a project path.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { usePopover, type PopoverPoint } from "../../editor/ui/popover";
import { flatItems, soundFolder, soundName, soundSections, stepActive, type SoundItem } from "./soundPickerModel";
import { TypeBadge } from "./TypeBadge";
import "./audioParts.css";

export interface SoundPickerProps {
  /** What it opens beside (the "Add…" button) or at (a point). */
  readonly at: Element | PopoverPoint;
  /** The sounds to offer: a list, or a promise of one. */
  list(): readonly SoundItem[] | Promise<readonly SoundItem[]>;
  /** Offer one kind only (a Clip playlist takes samples). */
  readonly only?: SoundItem["kind"];
  /** The dialog's name ("Add to Footsteps"). */
  readonly title?: string;
  onPick(path: string): void;
  onClose(): void;
}

export function SoundPicker(props: SoundPickerProps) {
  const [items, setItems] = useState<readonly SoundItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  usePopover(ref, true, { anchor: props.at, onDismiss: props.onClose, inside: props.at instanceof Element ? [props.at] : undefined, key: items === null });
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => props.list())
      .then((list) => live && setItems(list))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    search.current?.focus();
    return () => {
      live = false;
    };
  }, []);
  const sections = useMemo(() => soundSections(items ?? [], query, props.only), [items, query, props.only]);
  const shown = flatItems(sections);
  const current = shown.some((i) => i.path === active && !i.disabled) ? active : null;
  const pick = (item: SoundItem) => {
    if (item.disabled) return;
    props.onPick(item.path);
    props.onClose();
  };
  useEffect(() => {
    if (current) ref.current?.querySelector(`[data-path="${CSS.escape(current)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const listId = "studio-sound-list";
  return (
    <div ref={ref} class="studio-picker" role="dialog" aria-label={props.title ?? "Pick a sound"}>
      <input
        ref={search}
        type="search"
        class="studio-picker-search"
        placeholder="Search sounds"
        aria-label="Search sounds"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={current ? `studio-sound-${current}` : undefined}
        value={query}
        onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const item = shown.find((i) => i.path === current) ?? shown.find((i) => !i.disabled);
            if (item) {
              e.preventDefault();
              pick(item);
            }
            return;
          }
          const next = stepActive(shown, current, e.key);
          if (next === null) return;
          e.preventDefault();
          setActive(next);
        }}
      />
      <div class="studio-picker-list" id={listId} role="listbox" aria-label="Sounds">
        {items === null && !failed && <p class="studio-row-empty">Loading…</p>}
        {failed && <p class="studio-row-empty error">Couldn't list sounds: {failed}</p>}
        {items !== null && sections.length === 0 && <p class="studio-row-empty">{query ? `No sounds match "${query}".` : "No sounds in this project yet."}</p>}
        {sections.map((section) => (
          <div key={section.title} role="group" aria-label={section.title}>
            <div class="studio-picker-section">{section.title}</div>
            {section.items.map((item) => (
              <div
                key={item.path}
                id={`studio-sound-${item.path}`}
                data-path={item.path}
                role="option"
                aria-selected={item.path === current}
                aria-disabled={item.disabled ? true : undefined}
                class={`studio-picker-item${item.path === current ? " active" : ""}${item.disabled ? " disabled" : ""}`}
                title={item.disabled ? `${item.path}: ${item.disabled}` : item.path}
                onPointerMove={() => !item.disabled && item.path !== current && setActive(item.path)}
                onClick={() => pick(item)}
              >
                <TypeBadge code={item.badge} />
                <span class="studio-picker-name">{soundName(item)}</span>
                <span class="studio-picker-folder">{item.disabled ?? soundFolder(item)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
