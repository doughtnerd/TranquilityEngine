const screens = {};

function create({ resolution: { height, width } }) {
  const parent = document.createElement('div');
  parent.style = `maxWidth:${width}px; max-height:${height}px; position:relative;`
  
  const uiElement = document.createElement('div');
  uiElement.style = 'height: 100%; width: 100%; position: absolute; top: 0; left: 0; z-index: 1'
  
  
  const canvasElement = document.createElement("canvas");

  parent.appendChild(canvasElement);
  // parent.appendChild(uiElement);

  canvasElement.setAttribute("width", width);
  canvasElement.setAttribute("height", height);
  canvasElement.setAttribute("tabindex", 0);

  canvasElement.focus();
  canvasElement.addEventListener("click", () => canvasElement.focus());

  const glContext = canvasElement.getContext("webgl2", {
    // premultipliedAlpha: true,s
  });

  if (glContext === null) {
    alert("Unable to initialize WebGL. Your browser or machine may not support it.");
    return;
  }

  return { 
    glContext, 
    screen: {
      screenElement: parent,
      uiElement,
      canvasElement,
    } 
  };
}

function register(screenIndex, screen) {
  screens[screenIndex] = screen;
}

function getScreen(screenIndex) {
  return screens[screenIndex];
}

export default { create, register, getScreen };
