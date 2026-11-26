// The few Node APIs this package uses, declared here so it builds without @types/node.

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdin: {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
    on(event: "end", listener: () => void): void;
  };
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
  exit(code?: number): never;
  exitCode: number | undefined;
  emitWarning: (warning: string | Error, ...rest: unknown[]) => void;
};

declare module "node:sqlite" {
  export type SqlValue = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Record<string, SqlValue>[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "node:path" {
  export function dirname(p: string): string;
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:crypto" {
  export function randomBytes(size: number): { toString(encoding: "hex"): string };
}
