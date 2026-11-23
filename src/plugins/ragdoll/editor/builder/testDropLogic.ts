// The builder's Test drop (ADR 0373 "a test button drops the character in the viewport"; T55).
//
// **What it does, and why not "enter play mode".** The editor SDK has no call to start play mode (the Play button is the
// shell's), and a Ragdoll is saved with `mode: "off"` (the character animates; it ragdolls when gameplay says so). So Test
// drop works on a game that is **already playing**: it sets the selected character's live Ragdoll to `"ragdoll"` (limp, under
// gravity: the character drops) as a live write that the scene never saves, and **Reset** puts the mode back to what it was.
// While not playing, the button is off and says to press Play first.
import type { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { listNodes } from "../../../../engine/editor";
import type { RagdollMode } from "../../runtime/Ragdoll";

/** The modes a test drop moves between. */
export const DROP_MODE: RagdollMode = "ragdoll";

/** What the Test drop button shows and does given the editor's play state and the live Ragdoll's mode. */
export interface TestDropState {
  readonly label: "Test Drop" | "Reset";
  readonly disabled: boolean;
  /** Why it's off, or what it does. */
  readonly title: string;
}

/** The button's state: off until the game plays and the character is in it; "Reset" while it ragdolls from a test. */
export function testDropState(playState: "edit" | "starting" | "playing", live: { readonly mode: RagdollMode } | null, dropped: boolean): TestDropState {
  if (playState !== "playing") return { label: "Test Drop", disabled: true, title: "Press Play first: Test Drop drops the character in the running game (nothing is saved)." };
  if (!live) return { label: "Test Drop", disabled: true, title: "The selected node isn't in the running game's scene." };
  if (dropped && live.mode === DROP_MODE) return { label: "Reset", disabled: false, title: "Put the Ragdoll's mode back to what it was." };
  return { label: "Test Drop", disabled: false, title: `Set the running character's Ragdoll to "${DROP_MODE}": it goes limp and drops under gravity.` };
}

/** The mode to write when the button is pressed: the drop mode, or (for Reset) the mode before the test. */
export const nextDropMode = (dropped: boolean, before: RagdollMode): RagdollMode => (dropped ? before : DROP_MODE);

/** The node of `world` that shows the scene-file node `id` (the selected node's last path id), or null when none or several do. */
export function liveNodeFor(world: World, id: string): GameObject | null {
  const found = listNodes(world).filter((n) => n.id === id);
  return found.length === 1 ? found[0]!.node : null;
}
