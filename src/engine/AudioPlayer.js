import GameBehavior from "./GameBehavior";
import Howler from "howler";
import EventEmitter from "events";

export default class AudioPlayer extends GameBehavior {
  playOnStart = false;
  audioPath = "";
  loop = false;
  eventEmitter = new EventEmitter();
  audio;

  start() {
    if (this.playOnStart) {
      this.play(this.audioPath);
    }
  }

  stop() {}

  play(audioPath) {
    // this.stop();
    this.audio = new Howler.Howl({
      src: audioPath,
      autoplay: this.playOnStart,
      loop: this.loop,
      volume: 1,
    });
  }

  playOnce(audioPath) {
    // player.play(AssetDatabase.parseLoadPath(audioPath), (err) => {
    //   if (err) {
    //     console.error(err);
    //     throw err;
    //   }
    // });
  }
}
