import AudioPlayer from "../../engine/AudioPlayer";
import GameObject from "../../engine/GameObject";

export default class AudioHost extends GameObject {
  constructor(name = "audio") {
    super(name);
    this.addBehavior(AudioPlayer);
  }
}
