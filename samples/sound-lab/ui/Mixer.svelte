<script lang="ts">
  // The Sound Lab's mixer page text (ADR 0423): the page's heading lines and its readouts. The look is in lab.css,
  // shared by every page; the scripts on the scene's nodes pass the readouts in through the HUD's UIView props.
  import "./lab.css";
  let { mixer = "", loudness = "" }: { mixer?: string; loudness?: string } = $props();
</script>

<div id="hud">
  <span class="title">Sound Lab: mixer (B goes back to the tour)</span>
  <span class="title">Click the game view first. Music and an ambience bed play; the voice and bursts duck them.</span>
  <span id="mixer" class="readout" text={mixer}></span>
  <span id="loudness" class="readout" text={loudness}></span>
</div>
