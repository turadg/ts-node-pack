#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { tsNodePack } from "./index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tsconfig: { type: "string" },
    "emit-only": { type: "boolean", default: false },
    "keep-temp": { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: ts-node-pack <packageDir> [options]

Options:
  --tsconfig <path>   Path to tsconfig (default: tsconfig.build.json or tsconfig.json)
  --emit-only         Emit compiled files without packing
  --keep-temp         Keep temporary staging directory
  -v, --verbose       Verbose output
  -h, --help          Show this help message
`);
  process.exit(values.help ? 0 : 1);
}

const packageDir = resolve(positionals[0]);

try {
  const result = await tsNodePack(packageDir, {
    tsconfig: values.tsconfig,
    emitOnly: values["emit-only"],
    keepTemp: values["keep-temp"],
    verbose: values.verbose,
  });
  console.log(result);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
