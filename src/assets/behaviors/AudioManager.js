import AudioPlayer from "../../engine/AudioPlayer";
import GameBehavior from "../../engine/GameBehavior";
import townMusic from '../music/town.mp3'

export default class AudioManager extends GameBehavior {
  start() {
    this.gameObject.getBehavior(AudioPlayer).play(townMusic);
  }
}
