const GameBehavior = require('./GameBehavior');
// const ScreenBuffer = require('terminal-kit').ScreenBuffer;

class Renderer extends GameBehavior {

  spriteFilePath;
  // buffer = new ScreenBuffer();

  render(terminalBuffer) {
    // this.buffer.clear();

    // // this.buffer.put({
    // //   x: this.gameObject.transform.position.x,
    // //   y: this.gameObject.transform.position.y
    // // }, 'P');

    // this.buffer.loadImage

    // this.buffer.draw({
    //   dst: terminalBuffer,
    //   x: this.gameObject.transform.position.x,
    //   y: this.gameObject.transform.position.y
    // })
  }

}

module.exports = Renderer;
