import AudioPlayer from "../../engine/AudioPlayer";
import GameBehavior from "../../engine/GameBehavior";

export default class AudioManager extends GameBehavior {
  start() {
    this.gameObject.getBehavior(AudioPlayer).loop("./assets/music/town.mp3");
  }
}
