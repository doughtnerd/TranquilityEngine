// require('dotenv').config();

const path = require('path');
// const recursive = require("recursive-readdir");

const GameBehavior = require('./GameBehavior');
const GameObject = require('./GameObject');

class AssetDatabase {

  static gameObjects = {};
  static behaviors = {};
  static scenes = {};
  static sounds = {};

  // static async loadAssets() {
  //   const assetsRoot = process.env.ENGINE_ASSETS_FOLDER_PATH;
  //   const files = await recursive(assetsRoot, ['*.DS_Store']);

  //   files.forEach(file => {

  //     if (file.indexOf('.js') != -1) {
  //       const assetType = require(file);
  //       const instance = new (require(file));

  //       if (instance instanceof GameObject) {
  //         AssetDatabase.gameObjects[assetType] = file;
  //       }

  //       if (instance instanceof GameBehavior) {
  //         AssetDatabase.behaviors[assetType] = file;
  //       }
  //     }

  //   });

  //   // console.log(AssetDatabase.gameObjects, AssetDatabase.behaviors);
  // }

  static parseLoadPath(assetLoadPath) {
    if (assetLoadPath.indexOf('@assets') !== -1) {
      return assetLoadPath.replace('@assets', process.env.ENGINE_ASSETS_FOLDER_PATH);
    }
    if (assetLoadPath.indexOf('@engine') !== -1) {
      return assetLoadPath.replace('@engine', __dirname);
    }
    return assetLoadPath;
  }
}

module.exports = AssetDatabase;
