// Creating Svelte components (ADR 0419): the `svelte` kind's `create` (the Assets panel's New… menu) writes
// a starter component, which compiles with the project's scripts (the editor reloads them for a new UI
// source) and a UIView's `component` field can then pick.
import { editor } from "../../../editor/sdk";

/** A new component's text: a prop with a default, a panel filling the view, and a scoped style. */
const NEW_SVELTE_COMPONENT = `<script lang="ts">
  // Game UI as a Svelte component (ADR 0419). Mount it with a UIView; scripts pass data in through view.props.
  let { title = "New Component" }: { title?: string } = $props();
</script>

<div class="panel">
  <h1>{title}</h1>
</div>

<style>
  .panel {
    width: 100%;
    height: 100%;
    justify-content: center;
    align-items: center;
  }

  h1 {
    font-size: 32px;
  }
</style>
`;

/** Create `NewComponent.svelte` (or `NewComponent 2.svelte`…) in `folder`. Its path, or null when nothing was written. */
export function createSvelteComponent(folder: string): Promise<string | null> {
  return editor.project.createFile({
    folder,
    name: "NewComponent.svelte",
    what: "Svelte components",
    write: (project, path) => project.writeFile(path, NEW_SVELTE_COMPONENT),
  });
}
