<script lang="ts">
  // The arena's menu (ADR 0419): the title, the two choices and a status line. scripts/behaviors/Menu.ts passes
  // `join` (the Join item's text) and `status` (the message line) in through its UIView's props.
  let { join = "", status = "" }: { join?: string; status?: string } = $props();
</script>

<span id="title">ARENA</span>
<span id="subtitle">a two-player netcode sample</span>
<div id="choices">
  <span class="choice" text={"[H]  Host a game"}></span>
  <span class="choice" text={join}></span>
</div>
<span id="status" text={status}></span>

<style>
  /* Positions are in reference pixels. */
  #title {
    position: absolute;
    top: 110px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 84px;
    font-weight: bold;
    color: #e8eaf0;
  }

  #subtitle {
    position: absolute;
    top: 200px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 22px;
    color: #9aa0ad;
  }

  /* The two choices sit one above the other, centred on the screen and a little below its middle. */
  #choices {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    padding-top: 80px;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 18px;
  }

  .choice {
    font-size: 34px;
    font-weight: bold;
    color: #ffffff;
  }

  #status {
    position: absolute;
    bottom: 70px;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 20px;
    color: #9aa0ad;
  }

  /* Labels over the game let the pointer through to it (ADR 0385). */
  span {
    raycast-target: false;
    /* Scripts build these labels with line breaks and aligned spaces: keep them (ADR 0428 white-space). */
    white-space: pre-wrap;
  }
</style>
