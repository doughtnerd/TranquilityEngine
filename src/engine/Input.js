const Renderer = require("./Renderer");

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (Input.activeInputs.hasOwnProperty(key)) return;
  Input.activeInputs[key] = Input.InputPhase.InputDownCaptured;
});

document.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  Input.activeInputs[key] = Input.InputPhase.InputUpCaptured;
});

Renderer.canvas.addEventListener(
  "mousedown",
  (event) => {
    if (Input.activeInputs["mouse"] === Input.InputPhase.InputDownCaptured)
      return;
    Input.activeInputs["mouse"] = Input.InputPhase.InputDownCaptured;
    event.preventDefault();
  },
  false
);

Renderer.canvas.addEventListener(
  "mouseup",
  (event) => {
    Input.activeInputs["mouse"] = Input.InputPhase.InputUpCaptured;
    event.preventDefault();
  },
  false
);

Renderer.canvas.addEventListener(
  "mouseout",
  (event) => {
    Input.mouseAxis = { x: 0, y: 0 };
    event.preventDefault();
  },
  false
);

Renderer.canvas.addEventListener(
  "mouseenter",
  (event) => {
    Input.mouseAxis = { x: 0, y: 0 };
    event.preventDefault();
  },
  false
);

Renderer.canvas.addEventListener(
  "mousemove",
  (event) => {
    Input.mouseAxis.x =
      ((event.pageX - Input.mousePosition.x) * 2 * Math.PI) /
      Renderer.canvas.width;
    Input.mouseAxis.y = -(
      ((event.pageY - Input.mousePosition.y) * 2 * Math.PI) /
      Renderer.canvas.height
    );

    Input.mousePosition.x = event.pageX;
    Input.mousePosition.y = event.pageY;

    const yPosPercentage = Input.mousePosition.y / Renderer.canvas.height;

    event.preventDefault();
  },
  false
);

var drag = false;

class Input {
  static mousePosition = {
    x: 0,
    y: 0,
  };

  static mouseAxis = {
    x: 0,
    y: 0,
  };

  static activeInputs = {};

  static InputPhase = {
    InputDownCaptured: 0,
    InputDownHappening: 1,
    InputDownHappened: 2,
    InputUpCaptured: 3,
    InputUpHappening: 4,
    InputUpHappened: 5,
  };

  static processKeyboardInput() {
    for (const key in Input.activeInputs) {
      if (Input.activeInputs[key] === Input.InputPhase.InputUpHappened) {
        delete Input.activeInputs[key];
      }

      if (Input.activeInputs[key] === Input.InputPhase.InputUpHappening) {
        Input.activeInputs[key] = Input.InputPhase.InputUpHappened;
      }

      if (Input.activeInputs[key] === Input.InputPhase.InputUpCaptured) {
        Input.activeInputs[key] = Input.InputPhase.InputUpHappening;
      }

      if (Input.activeInputs[key] === Input.InputPhase.InputDownHappening) {
        Input.activeInputs[key] = Input.InputPhase.InputDownHappened;
      }

      if (Input.activeInputs[key] === Input.InputPhase.InputDownCaptured) {
        Input.activeInputs[key] = Input.InputPhase.InputDownHappening;
      }
    }
  }

  static processMouseInput() {}

  static getMouseDown() {
    return Input.activeInputs["mouse"] === Input.InputPhase.InputDownHappening;
  }

  static getMouse() {
    return Input.activeInputs["mouse"] === Input.InputPhase.InputDownHappened;
  }

  /**
   * Returns true during the frame the key is down
   * @param {*} keyName
   */
  static getKeyDown(keyName) {
    const key = keyName.toLowerCase();
    return Input.activeInputs[key] === Input.InputPhase.InputDownHappening;
  }

  /**
   * Returns true as long as the key is held down
   * @param {*} keyName
   */
  static getKey(keyName) {
    const key = keyName.toLowerCase();
    return Input.activeInputs[key] === Input.InputPhase.InputDownHappened;
  }

  /**
   * Returns true during the frame the key is released
   * @param {*} keyName
   */
  static getKeyUp(keyName) {
    const key = keyName.toLowerCase();
    return Input.activeInputs[key] === Input.InputPhase.InputUpHappening;
  }
}

module.exports = Input;
