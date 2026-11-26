<!-- A game component carrying a subtitle theme (ADR 0357 §5, 0419 wave B): its global rule sets the built-in display's variable. -->
<div id="hud"></div>

<style>
  :global(:root) {
    --subtitle-color: #00ff00;
  }
</style>
