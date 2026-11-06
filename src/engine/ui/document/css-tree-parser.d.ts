// css-tree's parser-only entry (no lexer and property data), which @types/css-tree doesn't declare.
declare module "css-tree/parser" {
  import type { CssNode, ParseOptions } from "css-tree";
  const parse: (text: string, options?: ParseOptions) => CssNode;
  export default parse;
}
