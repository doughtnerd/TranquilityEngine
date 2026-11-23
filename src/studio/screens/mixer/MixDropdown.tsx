// The Mixer's in-app dropdown (owner's prototype `.ddb`/`.ddm`, spec §4.3.8 "All dropdowns are in-app floating lists
// (no native pickers)"): a 26 px button showing the choice and a chevron; pressing it opens the shared menu under it
// (`ContextMenu`: the keys a menu has, Escape closes) with a ✓ on the current choice and each item's note at the right
// (a parameter's type, "already"). Extra entries after a separator (+ New parameter…) run their own action.
import { useRef, useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { Icon } from "../../components/Icon";

export interface DropdownOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Muted, at the right of the item (a type, "already"). */
  readonly note?: string;
  readonly disabled?: boolean;
  readonly title?: string;
}

export interface MixDropdownProps<T extends string> {
  readonly value: T;
  readonly options: readonly DropdownOption<T>[];
  /** Its accessible name ("Parameter"). */
  readonly label: string;
  /** What the button shows when `value` isn't an option ("depth (missing)"). */
  readonly fallback?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly class?: string;
  /** Entries after the options (+ New parameter…). */
  readonly extra?: readonly MenuEntry[];
  onChange(value: T): void;
}

export function MixDropdown<T extends string>(props: MixDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const chosen = props.options.find((o) => o.value === props.value);
  const entries: MenuEntry[] = props.options.map((o) => ({ id: `o:${o.value}`, label: o.label, note: o.note, checked: o.value === props.value, disabled: o.disabled, title: o.title, run: () => o.value !== props.value && props.onChange(o.value) }));
  if (props.extra && props.extra.length > 0) entries.push(SEPARATOR, ...props.extra);
  return (
    <>
      <button
        ref={button}
        type="button"
        class={`mx-dd${open ? " open" : ""}${props.class ? ` ${props.class}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${props.label}: ${chosen?.label ?? props.fallback ?? props.value}`}
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span class="mx-dd-text">{chosen?.label ?? props.fallback ?? props.value}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && button.current && (
        <ContextMenu
          entries={entries}
          at={button.current}
          label={props.label}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}
