// Q5: which Svelte features compile with `experimental.customRenderer` (svelte 5.59.2), and which
// runtime helpers each pulls in. Run: node probe.mjs
import { compile } from "svelte/compiler";

const FEATURES = {
  "bind:value": `<script>let v=$state("")</script><input-field bind:value={v}/>`,
  "bind:this": `<script>let el</script><panel bind:this={el}/>`,
  "bind:clientWidth": `<script>let w=$state(0)</script><panel bind:clientWidth={w}/>`,
  "bind:group": `<script>let g=$state(1)</script><input-field type="radio" bind:group={g} value={1}/>`,
  "transition:": `<script>import {fade} from "svelte/transition"; let s=$state(true)</script>{#if s}<panel transition:fade/>{/if}`,
  "in:/out:": `<script>import {fly} from "svelte/transition"; let s=$state(true)</script>{#if s}<panel in:fly out:fly/>{/if}`,
  "animate:": `<script>import {flip} from "svelte/animate"; let xs=$state([1])</script>{#each xs as x (x)}<panel animate:flip/>{/each}`,
  "use: (action)": `<script>function act(n){}</script><panel use:act/>`,
  "{@attach}": `<script>const att=(n)=>{}</script><panel {@attach att}/>`,
  "style: directive": `<script>let w=$state(1)</script><panel style:width="{w}px" style:--x="1"/>`,
  "class: directive": `<script>let on=$state(true)</script><panel class:on/>`,
  "spread attributes": `<script>let a={gap:4}</script><panel {...a}/>`,
  "on…capture": `<panel onclickcapture={()=>{}}/>`,
  "<svelte:window>": `<svelte:window onkeydown={()=>{}}/>`,
  "<svelte:document>": `<svelte:document onvisibilitychange={()=>{}}/>`,
  "<svelte:body>": `<svelte:body onclick={()=>{}}/>`,
  "<svelte:head>": `<svelte:head><title>x</title></svelte:head>`,
  "<svelte:element>": `<script>let t=$state("panel")</script><svelte:element this={t}/>`,
  "<svelte:boundary>": `<svelte:boundary><panel/>{#snippet failed()}<text>x</text>{/snippet}</svelte:boundary>`,
  "{@html}": `<panel>{@html "<b>x</b>"}</panel>`,
  "{#await}": `<script>let p=Promise.resolve(1)</script>{#await p}<text>…</text>{:then v}<text>{v}</text>{/await}`,
  "{#key}": `<script>let k=$state(1)</script>{#key k}<panel/>{/key}`,
  "css: injected": `<panel class="a"/><style>.a{gap:1px}</style>`,
};

for (const [name, src] of Object.entries(FEATURES)) {
  try {
    const r = compile(src, { filename: "P.svelte", runes: true, css: name === "css: injected" ? "injected" : "external", experimental: { customRenderer: "/renderer.js" } });
    const helpers = [...new Set(r.js.code.match(/\$\.[a-z_]+/g))].filter((h) => !["$.push_renderer", "$.pop_renderer", "$.is_crossing", "$.cross", "$.append", "$.from_tree"].includes(h));
    const note = name === "css: injected" ? ` (CSS in output: ${/append_styles|gap: ?1px/.test(r.js.code) ? "yes" : "no, silently dropped"})` : "";
    console.log(`compiles    ${name}: ${helpers.join(" ")}${note}`);
  } catch (e) {
    console.log(`REJECTED    ${name}: ${e.message.split("\n")[0]}`);
  }
}
