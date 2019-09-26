

class Texture {

  imageSource;

  constructor(imageSource) {
    this.imageSource = imageSource;
  }

  load(glContext) {
    const texture = glContext.createTexture();
    glContext.bindTexture(glContext.TEXTURE_2D, texture);

    const level = 0;
    const internalFormat = glContext.RGBA;
    const width = 1;
    const height = 1;
    const border = 0;
    const srcFormat = glContext.RGBA;
    const srcType = glContext.UNSIGNED_BYTE;
    const pixel = new Uint8Array([0, 0, 255, 255]);  // opaque blue
    glContext.texImage2D(glContext.TEXTURE_2D, level, internalFormat,
      width, height, border, srcFormat, srcType,
      pixel);

    const image = new Image();
    image.onload = function () {
      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      glContext.texImage2D(glContext.TEXTURE_2D, level, internalFormat,
        srcFormat, srcType, image);

      // WebGL1 has different requirements for power of 2 images
      // vs non power of 2 images so check if the image is a
      // power of 2 in both dimensions.
      if (Texture.isPowerOf2(image.width) && Texture.isPowerOf2(image.height)) {
        // Yes, it's a power of 2. Generate mips.
        glContext.generateMipmap(glContext.TEXTURE_2D);
      } else {
        // No, it's not a power of 2. Turn off mips and set
        // wrapping to clamp to edge
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR);
      }
    };
    image.src = this.imageSource;

    return texture;
  }

  static isPowerOf2(value) {
    return (value & (value - 1)) == 0;
  }
}

module.exports = Texture;
