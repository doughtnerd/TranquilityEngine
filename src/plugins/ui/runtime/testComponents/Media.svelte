<script lang="ts">
  // ADR 0426: <video> and <audio> under the engine's renderer: the media API on the nodes and Svelte's media bindings.
  let {
    log = () => {},
    onnode = () => {},
    paused = $bindable(true),
    volume = $bindable(1),
    currentTime = $bindable(0),
    duration = $bindable(0),
    muted = $bindable(false),
  }: {
    log?: (s: string) => void;
    onnode?: (key: string, node: unknown) => void;
    paused?: boolean;
    volume?: number;
    currentTime?: number;
    duration?: number;
    muted?: boolean;
  } = $props();

  let video: unknown = $state(null);
  let audio: unknown = $state(null);
  $effect(() => onnode("video", video));
  $effect(() => onnode("audio", audio));
</script>

<video id="clip" bind:this={video} src="asset:videos/intro.webm" loop width="320" height="180" bind:paused bind:volume bind:currentTime bind:duration bind:muted onended={() => log("ended")} onplay={() => log("play")}></video>
<audio id="theme" bind:this={audio} autoplay><source src="asset:sounds/theme.ogg" /></audio>
<p id="time">{currentTime.toFixed(1)}</p>
<p id="state">{paused} {volume} {muted} {duration}</p>
