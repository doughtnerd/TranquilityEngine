<script lang="ts">
  // The engine's UI tests' generic component (`src/engine/tests/uiMarkup.ts`): it renders a tree of elements given as
  // data, each an HTML tag with its attributes as written, through the engine's renderer, so a test writes its element
  // tree as markup and builds it the one way game UI is built (ADR 0423: a UIView mounting a Svelte component).
  import Tree from "./Tree.svelte";

  type TreeNode = { readonly text: string } | { readonly tag: string; readonly attributes: Record<string, string>; readonly children: TreeNode[] };

  let { nodes = [] }: { nodes?: TreeNode[] } = $props();

  // HTML's void elements, which have no children (an element keeps its branch when children are added later).
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
</script>

{#each nodes as node}
  {#if "text" in node}{node.text}{:else if VOID.has(node.tag)}<svelte:element this={node.tag} {...node.attributes} />{:else}<svelte:element this={node.tag} {...node.attributes}><Tree nodes={node.children} /></svelte:element>{/if}
{/each}
