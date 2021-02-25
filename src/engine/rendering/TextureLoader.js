export default class TextureLoader {
  static load(imageSource, glContext) {
    const texture = glContext.createTexture();
    glContext.bindTexture(glContext.TEXTURE_2D, texture);

    const level = 0;
    const internalFormat = glContext.RGBA;
    const width = 1;
    const height = 1;
    const border = 0;
    const srcFormat = glContext.RGBA;
    const srcType = glContext.UNSIGNED_BYTE;
    const pixel = new Uint8Array([0, 0, 255, 255]); // opaque blue
    glContext.texImage2D(glContext.TEXTURE_2D, level, internalFormat, width, height, border, srcFormat, srcType, pixel);

    const image = new Image();
    image.onload = function () {
      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      glContext.texImage2D(glContext.TEXTURE_2D, level, internalFormat, srcFormat, srcType, image);

      if (TextureLoader.isPowerOf2(image.width) && TextureLoader.isPowerOf2(image.height)) {
        glContext.generateMipmap(glContext.TEXTURE_2D);
      } else {
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR);
      }
    };
    image.src = imageSource;

    return texture;
  }

  static isPowerOf2(value) {
    return (value & (value - 1)) == 0;
  }
}
