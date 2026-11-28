// @mowaos/host-browser on MemoryStorage. The suite itself is in host-suite.mjs, shared
// with every other storage adapter (@mowaos/mcp runs it on SqliteStorage).
import { createRequire } from "node:module";

import * as lib from "../dist/index.js";
import { hostSuite } from "./host-suite.mjs";

const require = createRequire(import.meta.url);

hostSuite("MemoryStorage", {
  lib,
  wasmPkg: require("../../../pkg/mowa_wasm.js"),
  makeStorage: () => new lib.MemoryStorage(),
  clearSteps: (storage) => storage.steps.clear(),
});
