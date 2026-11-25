// Minimal Node typings so the package builds without @types/node.
declare module "node:module" {
  export function createRequire(url: string): (id: string) => unknown;
}
