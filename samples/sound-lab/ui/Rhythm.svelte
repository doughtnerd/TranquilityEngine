<script lang="ts">
  // The Sound Lab's rhythm page text (ADR 0419): the page's heading lines and its readouts. The look is in lab.css,
  // shared by every page; the scripts on the scene's nodes pass the readouts in through the HUD's UIView props.
  import "./lab.css";
  let { rhythm = "" }: { rhythm?: string } = $props();
</script>

<div id="hud">
  <span class="title">Sound Lab: rhythm (B goes back to the tour)</span>
  <span class="title">Click the game view first. Tap SPACE or press the view: C calibrates on a click track, G is the tap game.</span>
  <span id="rhythm" class="readout" text={rhythm}></span>
</div>
