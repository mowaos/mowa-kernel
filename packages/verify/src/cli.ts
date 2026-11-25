#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { verifyBundle } from "./verify.js";

function usage(): void {
  console.error(
    [
      "Usage: mowa-verify <bundle.json | -> [--wasm <path>] [--json]",
      "",
      "Options:",
      "  --wasm <path>   Path to a custom mowa_wasm.js module",
      "  --json          Print machine-readable JSON verification report",
      "  -h, --help      Show this help message",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let target: string | null = null;
  let wasmPath: string | undefined;
  let jsonOut = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--json") {
      jsonOut = true;
    } else if (arg === "--wasm") {
      const next = args[i + 1];
      if (!next) {
        console.error("Missing value for --wasm.");
        usage();
        process.exit(2);
      }
      wasmPath = next;
      i += 1;
    } else if (arg.startsWith("-") && arg !== "-") {
      console.error(`Unknown option: ${arg}`);
      usage();
      process.exit(2);
    } else if (target === null) {
      target = arg;
    } else {
      console.error(`Unexpected extra argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }

  if (target === null) {
    usage();
    process.exit(2);
  }

  let raw = "";
  try {
    raw =
      target === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(target, "utf8");
  } catch (err) {
    console.error(
      `Failed to read '${target}': ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `Invalid JSON in '${target}': ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(2);
  }

  const report = await verifyBundle(parsed, { wasmPath });

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(
      `PASS: ${report.sessionsChecked} session(s), ${report.totalStepsVerified} step(s), ${report.flowsChecked} flow(s) verified (kernel ${report.verifierKernelVersion}).`
    );
    for (const s of report.sessions) {
      console.log(
        `  - ${s.sessionId}: ${s.stepsVerified} steps (v${s.finalVersion}, resultHash ${s.finalResultHash})`
      );
    }
  } else {
    console.error(
      `FAIL: ${report.errors.length} verification error(s) found.`
    );
    for (const err of report.errors) {
      const where = [
        err.scope,
        err.sessionId ? `session=${err.sessionId}` : null,
        err.stepIndex !== undefined ? `step=${err.stepIndex}` : null,
        err.flowHash ? `flow=${err.flowHash}` : null,
        err.field ? `field=${err.field}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      console.error(`  [${where}] ${err.message}`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
