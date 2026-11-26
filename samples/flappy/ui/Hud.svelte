<script lang="ts">
  // Flappy's HUD (ADR 0419): the score, the ready / game over message and the music readout, which
  // scripts/behaviors/GameManager.ts passes in through its UIView's props.
  let { score = "", message = "", music = "" }: { score?: string; message?: string; music?: string } = $props();
</script>

<span id="score" text={score}></span>
<span id="message" text={message}></span>
<span id="music" text={music}></span>

<style>
  /* Brown-outlined white text over the sky. Positions are in reference pixels. */
  span {
    color: white;
    font-weight: bold;
    text-outline-color: rgb(23%, 17%, 10%);
    /* Labels over the game let the pointer through to it (ADR 0385). */
    raycast-target: false;
  }

  #score {
    position: absolute;
    top: 40px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 72px;
    text-outline-width: 6px;
  }

  #message {
    position: absolute;
    top: 150px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 34px;
    text-outline-width: 5px;
  }

  #music {
    position: absolute;
    top: 12px;
    left: 12px;
    text-align: left;
    font-size: 18px;
    text-outline-width: 4px;
  }
</style>
