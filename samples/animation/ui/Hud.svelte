<script lang="ts">
  // The main scene's HUD (ADR 0423): station captions, controls, and the readouts scripts/behaviors/LabHud.ts passes in.
  let { sprout = "", lantern = "" }: { sprout?: string; lantern?: string } = $props();
</script>

<span id="title" text="Animation"></span>
<span id="keys" text={"Up / Down  speed     Space  hop     P  autopilot     2  sprites page"}></span>

<span class="caption" id="c1" text={"Graph\nskinned mesh, state machine, blend space"}></span>
<span class="caption" id="c2" text={"Property clip\ntransform, light colour, notifies"}></span>
<span class="caption" id="c3" text={"Tweens\nparallel, sequence, easings"}></span>
<span class="caption" id="c4" text={"Timeline\nTimelineDirector, activation"}></span>

<span class="readout" id="r1" text={sprout}></span>
<span class="readout" id="r2" text={lantern}></span>

<style>
  span {
    color: rgb(93%, 94%, 96%);
    raycast-target: false;
    white-space: pre-wrap;
    text-outline-color: rgb(8%, 9%, 11%);
    text-outline-width: 3px;
  }

  #title {
    position: absolute;
    top: 16px;
    left: 24px;
    font-size: 30px;
    font-weight: bold;
  }

  #keys {
    position: absolute;
    top: 24px;
    right: 24px;
    font-size: 16px;
  }

  .caption,
  .readout {
    position: absolute;
    width: 300px;
    text-align: center;
  }

  .caption {
    top: 90px;
    font-size: 17px;
  }

  .readout {
    bottom: 40px;
    font-size: 16px;
    text-align: left;
  }

  #c1, #r1 { left: 20px; }
  #c2, #r2 { left: 330px; }
  #c3 { left: 650px; }
  #c4 { left: 960px; }
  #r2 { text-align: center; }
</style>
