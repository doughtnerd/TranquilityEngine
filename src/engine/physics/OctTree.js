
class OctTree {

  static LEAF_CAPACITY = 4;


}

class Node {

  isLeafNode = true;
  items = [];
  OctTree = [];

  addItem(item) {
    debugger;
    if (this.isLeafNode) {
      if (this.items.length === OctTree.LEAF_CAPACITY) {
        this.isLeafNode = false;
        this.children = [
          new Node(),
          new Node(),
          new Node(),
          new Node(),
          new Node(),
          new Node(),
          new Node(),
          new Node(),
        ];
        this.items.forEach(item => this.addItem(item));
        return this.addItem(item);
      }
      else {
        this.items.push(item);

        return true;
      }

    }
    else {
      let result = false;
      for (let i = 0; i < this.children.length; i++) {
        const child = this.children[i];

        if (child.addItem(item)) {
          result = true;
          break;
        }
      }
      return result;
    }
  }
}


module.exports = Node;

