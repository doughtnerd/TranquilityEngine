// The flipbook views the shell hosts (ADR 0373 "2D tools"; T56): a card of an image's Import Settings (the draft's
// `flipbooks`, written by the shell's one Apply like the rest of the sidecar) and the Sprite Editor's Flipbooks tab (an
// undo step of the editor's history, written by its Apply). Both are `FlipbookEditor` over where the host keeps the flipbooks.
import type { ImportSettingsViewProps, SpriteEditorToolProps } from "../../../../editor/sdk";
import { FlipbookEditor } from "./FlipbookEditor";

/** The Flipbooks card of an image's Import Settings. */
export function FlipbooksCard(props: ImportSettingsViewProps) {
  const url = props.project.assets.get(props.path);
  if (typeof url !== "string") return <p class="flip-note">This image can't be shown.</p>;
  return <FlipbookEditor url={url} slices={props.draft.sprites} flipbooks={props.draft.flipbooks} readOnly={props.readOnly} onChange={(next) => props.set({ flipbooks: { ...next } })} />;
}

/** The Sprite Editor's Flipbooks tab: slices are the editor's, as edited so far (so a slice just drawn can be a frame). */
export function FlipbooksTool(props: SpriteEditorToolProps) {
  return (
    <div class="flip-tool">
      <FlipbookEditor url={props.url} slices={props.slices} flipbooks={props.flipbooks} readOnly={props.readOnly} onChange={(next) => props.edit({ flipbooks: next })} />
    </div>
  );
}
