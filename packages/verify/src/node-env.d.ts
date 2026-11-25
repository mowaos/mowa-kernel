declare const process: {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
};

declare const Buffer: {
  from(input: string, encoding?: string): Uint8Array;
  compare(a: Uint8Array, b: Uint8Array): number;
};

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string, encoding?: string): { digest(encoding: "hex"): string };
  };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}

declare module "node:module" {
  export function createRequire(url: string): (id: string) => unknown;
}

declare module "node:path" {
  export function dirname(p: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:util" {
  export function isDeepStrictEqual(a: unknown, b: unknown): boolean;
}
