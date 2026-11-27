<script lang="ts">
  // The Sound Lab's events page text (ADR 0423): the page's heading lines and its readouts. The look is in lab.css,
  // shared by every page; the scripts on the scene's nodes pass the readouts in through the HUD's UIView props.
  import "./lab.css";
  let { footsteps = "", engine = "", music = "" }: { footsteps?: string; engine?: string; music?: string } = $props();
</script>

<div id="hud">
  <span class="title">Sound Lab: audio events (B goes back to the tour)</span>
  <span class="title">Click the game view first. Footsteps, engine and music play together.</span>
  <span id="footsteps" class="readout" text={footsteps}></span>
  <span id="engine" class="readout" text={engine}></span>
  <span id="music" class="readout" text={music}></span>
</div>
