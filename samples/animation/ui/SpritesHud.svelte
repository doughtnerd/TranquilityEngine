<script lang="ts">
  // The sprites page's HUD (ADR 0423): a caption and the key back to the main scene.
</script>

<span id="title" text="Sprites"></span>
<span id="caption" text={"Flipbooks from a sliced sheet (images/critter.png), moved by tweens.\n1  back to the main scene"}></span>

<style>
  span {
    color: white;
    raycast-target: false;
    white-space: pre-wrap;
    text-outline-color: rgb(12%, 20%, 30%);
    text-outline-width: 3px;
  }

  #title {
    position: absolute;
    top: 16px;
    left: 24px;
    font-size: 30px;
    font-weight: bold;
  }

  #caption {
    position: absolute;
    top: 60px;
    left: 24px;
    font-size: 17px;
  }
</style>
