const player = require('play-sound')(opt = {})
const EventEmitter = require('events');
const GameBehavior = require('./GameBehavior');

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
    if (this.audio) {
      this.audio.kill();
    }
    this.eventEmitter.removeAllListeners()
  }

  play(audioPath) {
    this.stop();
    if (this.loop) {
      this.eventEmitter.on('AudioEnded', () => this._play(audioPath));
    }
    this._play(audioPath);
  }

  _play(audioPath) {
    this.audio = player.play(audioPath, (err) => {
      this.eventEmitter.emit('AudioEnded');
      if (err) {
        console.error(err);
        throw err;
      }
    });
  }

  playOnce(audioPath) {
    player.play(audioPath, (err) => {
      if (err) {
        console.error(err);
        throw err;
      }
    });
  }
}

module.exports = AudioPlayer;
