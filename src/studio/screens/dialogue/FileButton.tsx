// A button that opens the file chooser (ADR 0361): a real, focusable button in front of a hidden file input, since a
// label around a hidden input can't be reached with the keyboard. The input keeps its name for assistive tech.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { Icon, type IconName } from "../../components/Icon";

export function FileButton(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly accept: string;
  readonly multiple?: boolean;
  readonly folder?: boolean;
  readonly disabled?: boolean;
  readonly class?: string;
  readonly title?: string;
  readonly children?: ComponentChildren;
  onFiles(files: File[]): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class={props.class} disabled={props.disabled} title={props.title} onClick={() => input.current?.click()}>
        <Icon name={props.icon} /> {props.children ?? props.label}
      </button>
      <input ref={input} type="file" hidden tabIndex={-1} multiple={props.multiple} accept={props.accept} aria-label={props.label} disabled={props.disabled}
        {...(props.folder ? { webkitdirectory: "" } : {})}
        onChange={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          const files = [...(el.files ?? [])];
          el.value = "";
          props.onFiles(files);
        }} />
    </>
  );
}
