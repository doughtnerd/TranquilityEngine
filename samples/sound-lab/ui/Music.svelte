<script lang="ts">
  // The Sound Lab's music page text (ADR 0423): the page's heading lines and its readouts. The look is in lab.css,
  // shared by every page; the scripts on the scene's nodes pass the readouts in through the HUD's UIView props.
  import "./lab.css";
  let { music = "" }: { music?: string } = $props();
</script>

<div id="hud">
  <span class="title">Sound Lab: interactive music (B goes back to the tour)</span>
  <span class="title">Click the game view first. One tempo, 120 bpm: every change lands on a bar line.</span>
  <span id="music" class="readout" text={music}></span>
</div>
