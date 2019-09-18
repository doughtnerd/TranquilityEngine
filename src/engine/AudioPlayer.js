const Howler = require('howler');

const EventEmitter = require('events');
const GameBehavior = require('./GameBehavior');
// const AssetDatabase = require('../engine/AssetDatabase');

class AudioPlayer extends GameBehavior {

  playOnStart = false;
  audioPath = '';
  loop = false;
  eventEmitter = new EventEmitter();
  audio;

  start() {
    if (this.playOnStart) {
      this.play(this.audioPath);
    }
  }

  stop() {

  }

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

module.exports = AudioPlayer;
