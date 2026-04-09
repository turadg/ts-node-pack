#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { tsNodePack } from "./index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tsconfig: { type: "string" },
    "skip-pack": { type: "boolean", default: false },
    "stage-to": { type: "string" },
    force: { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: ts-node-pack <packageDir> [options]

Options:
  --tsconfig <path>   Path to tsconfig (default: tsconfig.build.json or tsconfig.json)
  --stage-to <dir>    Stage into <dir> instead of an auto-created temp dir.
                      Caller owns cleanup. Errors if <dir> is non-empty unless --force.
  --skip-pack         Skip the final \`npm pack\` step. Requires --stage-to.
  --force             With --stage-to, clear <dir> if it already has contents.
  -v, --verbose       Log each pipeline phase to stderr.
  -h, --help          Show this help message.
`);
  process.exit(values.help ? 0 : 1);
}

const packageDir = resolve(positionals[0]);

try {
  const result = await tsNodePack(packageDir, {
    tsconfig: values.tsconfig,
    skipPack: values["skip-pack"],
    stageTo: values["stage-to"],
    force: values.force,
    verbose: values.verbose,
  });
  console.log(result);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
