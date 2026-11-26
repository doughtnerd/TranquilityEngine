<script lang="ts">
  // The Sound Lab's main page text (ADR 0419): the page's heading lines and its readouts. The look is in lab.css,
  // shared by every page; the scripts on the scene's nodes pass the readouts in through the HUD's UIView props.
  import "./lab.css";
  let { loudness = "" }: { loudness?: string } = $props();
</script>

<div id="hud">
  <span id="loudness" class="readout" text={loudness}></span>
</div>
