<script>
  // ADR 0425: inline runs in a text element, links, {@html} and contenteditable.
  let { log = () => {}, html = "Hi <b>there</b>", label = "world", width = "auto" } = $props();
  const block = "<div class='box'><p>block <b>x</b></p></div><scr" + "ipt>alert(1)</scr" + "ipt><span onclick=\"evil()\">ok</span>";
  let plain = $state("Edit me");
  let rich = $state("a <i>b</i>");
</script>

<div id="col">
  <p id="para" style:width={width}>Hello <b id="bold">{label}</b> and <a id="link" href="#x" onclick={(e) => log(`click ${e.target.id} on ${e.currentTarget.id} ${e.currentTarget.getAttribute("href")}`)}>a <em id="em">link</em></a>!</p>
  <p id="chem">H<sub id="two">2</sub>O and E=mc<sup id="sq">2</sup><br />next <code id="code">line</code> <mark id="mark">marked</mark> <img id="pic" src="pic.png" width="12" height="12" alt="" /></p>
  <p id="html">{@html html}</p>
  <div id="htmlblock">{@html block}</div>
  <p id="edit" contenteditable bind:textContent={plain}></p>
  <p id="richedit" contenteditable bind:innerHTML={rich}></p>
  <span id="plain">{plain}</span>
  <span id="rich">{rich}</span>
</div>

<style>
  #col { flex-direction: column; }
  b { color: rgb(0, 255, 0); }
</style>
