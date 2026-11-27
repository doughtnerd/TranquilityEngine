<script lang="ts">
  // The navigation sample's status panel (ADR 0419): one text block, which scripts/behaviors/Hud.ts passes in
  // through its UIView's props.
  let { status = "" }: { status?: string } = $props();
</script>

<span id="status" text={status}></span>

<style>
  /* White text with a black outline, top left, in reference pixels. */
  #status {
    position: absolute;
    top: 16px;
    left: 16px;
    text-align: left;
    font-size: 18px;
    font-weight: bold;
    color: white;
    text-outline-color: black;
    text-outline-width: 3px;
    /* A label over the game lets the pointer through to it (ADR 0385). */
    raycast-target: false;
    /* Scripts build these labels with line breaks and aligned spaces: keep them (ADR 0428 white-space). */
    white-space: pre-wrap;
  }
</style>
