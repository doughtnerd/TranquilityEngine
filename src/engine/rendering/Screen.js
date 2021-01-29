
function create({resolution: {height, width}}) {

    const screenElement = document.createElement('canvas');

    screenElement.setAttribute('width', width);
    screenElement.setAttribute('height', height);
    screenElement.setAttribute('tabindex', 0);

    screenElement.focus();
    screenElement.addEventListener('click', () => screenElement.focus())

    const glContext = screenElement.getContext("webgl2", {
      premultipliedAlpha: false 
    });

    if (glContext === null) {
      alert("Unable to initialize WebGL. Your browser or machine may not support it.");
      return;
    }

    return {glContext, screenElement};
}

module.exports = {
    create
}