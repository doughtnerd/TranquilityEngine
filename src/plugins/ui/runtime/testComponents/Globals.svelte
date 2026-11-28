<svelte:options css="injected" />

<script lang="ts">
  import { t } from "myco";

  type Node = { id: string; nodeName: string };
  let { log, onnode, name = "Ada" }: { log: (entry: string) => void; onnode: (name: string, node: unknown) => void; name?: string } = $props();
  let width = $state(0);
  let height = $state(0);
  let ratio = $state(0);
  let active: Node | null = $state(null);
  let title = $state("Main menu");
  let clicks = $state(0);

  // An action using the Element subset, as a web library's would.
  function tip(node: {
    dataset: Record<string, string | undefined>;
    style: Record<string, string>;
    closest(s: string): Node | null;
    matches(s: string): boolean;
    parentElement: { contains(n: unknown): boolean; firstElementChild: Node | null };
    getAttribute(n: string): string | null;
  }) {
    node.dataset.tipText = "hi";
    node.style.backgroundColor = "#ff0000";
    log(`tip ${node.closest("#root")?.id} ${node.matches("button.tip")} ${node.parentElement.contains(node)} ${node.getAttribute("data-tip-text")} ${node.parentElement.firstElementChild?.id}`);
    onnode("tip", node);
  }

  function grab(node: unknown, key: string) {
    onnode(key, node);
  }
</script>

<svelte:window
  bind:innerWidth={width}
  bind:innerHeight={height}
  bind:devicePixelRatio={ratio}
  onkeydown={(e: { key: string; code: string }) => {
    log(`window ${e.key} ${e.code}`);
    if (e.key === "Enter") title = "Pressed";
  }}
  onresize={() => log("resize")}
/>
<svelte:document bind:activeElement={active} onkeydown={(e: { key: string }) => log(`document ${e.key}`)} />
<svelte:body
  onkeydown={(e: { key: string; stopPropagation(): void }) => {
    log(`body ${e.key}`);
    if (e.key === "Escape") e.stopPropagation();
  }}
/>
<svelte:head>
  <title>{title}</title>
  <meta name="description" content="A menu" />
</svelte:head>

<div id="root" flex-direction="column">
  <p id="size">{width}x{height} @{ratio}</p>
  <p id="greeting">{t("menu.hello", { name })}</p>
  <button id="tip" class="tip" use:tip onclick={() => clicks++}>{clicks}</button>
  <p id="active">{active?.id || active?.nodeName}</p>
  <div id="box" style="width: 100px; height: 50px; transform: rotate(90deg)" use:grab={"box"}></div>
</div>

<style>
  p {
    color: #00ff00;
  }
</style>
