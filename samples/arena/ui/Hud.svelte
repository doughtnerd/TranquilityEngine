<script lang="ts">
  // The arena's heads-up display (ADR 0419): the replicated scores along the top and the controls along the bottom.
  // scripts/behaviors/Hud.ts passes them in through its UIView's props.
  let { scores = "", help = "" }: { scores?: string; help?: string } = $props();
</script>

<span id="scoreboard" text={scores}></span>
<span id="help" text={help}></span>

<style>
  /* Positions are in reference pixels. */
  #scoreboard {
    position: absolute;
    top: 6px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 24px;
    font-weight: bold;
    color: #e8eaf0;
  }

  #help {
    position: absolute;
    bottom: 8px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 16px;
    color: #9aa0ad;
  }

  /* Labels over the game let the pointer through to it (ADR 0385). */
  span {
    raycast-target: false;
  }
</style>
