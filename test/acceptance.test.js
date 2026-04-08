/**
 * Acceptance test for ts-node-pack.
 *
 * 1. Pack the test fixture
 * 2. Install the resulting .tgz into a temp consumer project
 * 3. Verify it runs under Node (ESM)
 * 4. Verify TypeScript can typecheck against it
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "src", "cli.ts");
const FIXTURE = join(__dirname, "fixture");

describe("ts-node-pack acceptance", () => {
  let tmpDir;
  let tgzPath;
  let consumerDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ts-node-pack-test-"));
    consumerDir = join(tmpDir, "consumer");
    await mkdir(consumerDir);
    // Ensure the fixture has a local tsc so runTsc uses node_modules/.bin/tsc
    // rather than npx (which on macOS can resolve to /usr/bin/tsc, the
    // TeX/Smalltalk compiler). Cheap to run; npm no-ops if already installed.
    await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: FIXTURE,
    });
  }, 120_000);

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("packs the fixture into a .tgz", async () => {
    const { stdout } = await execFileAsync("node", [CLI, FIXTURE, "--verbose"], { cwd: tmpDir });
    tgzPath = stdout.trim().split("\n").pop();
    assert.ok(tgzPath.endsWith(".tgz"), `Expected .tgz path, got: ${tgzPath}`);
  });

  it("installs into a consumer project", async () => {
    assert.ok(tgzPath, "pack step must run first");
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", type: "module" }, null, 2),
    );
    await execFileAsync(
      "npm",
      ["install", "--no-audit", "--no-fund", tgzPath, "typescript@^5.7.0"],
      { cwd: consumerDir },
    );
  });

  it("runs under Node (ESM)", async () => {
    const script = `
      import { greet, createGreeting, formatGreeting } from 'test-ts-pkg';
      import { createGreeting as cg2 } from 'test-ts-pkg/utils';

      const result = greet('World');
      if (typeof result !== 'string' || !result.includes('Hello, World!')) {
        throw new Error('greet() returned unexpected: ' + result);
      }

      const g = cg2('test');
      if (typeof g.message !== 'string' || typeof g.timestamp !== 'number') {
        throw new Error('createGreeting() returned unexpected: ' + JSON.stringify(g));
      }

      console.log('Node execution OK');
    `;
    await writeFile(join(consumerDir, "test.mjs"), script);
    const { stdout } = await execFileAsync("node", ["test.mjs"], {
      cwd: consumerDir,
    });
    assert.match(stdout, /Node execution OK/);
  });

  it("typechecks against emitted .d.ts", async () => {
    const tsScript = `
      import { greet, createGreeting, formatGreeting } from 'test-ts-pkg';
      import type { Greeting, GreetFn } from 'test-ts-pkg';
      import { createGreeting as cg2 } from 'test-ts-pkg/utils';

      const result: string = greet('World');
      const g: Greeting = createGreeting('hi');
      const s: string = formatGreeting(g);
      const fn: GreetFn = (name: string) => createGreeting(name);
    `;
    await writeFile(join(consumerDir, "test-types.ts"), tsScript);
    await writeFile(
      join(consumerDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["test-types.ts"],
        },
        null,
        2,
      ),
    );
    const localTsc = join(consumerDir, "node_modules", ".bin", "tsc");
    await execFileAsync(localTsc, ["-p", join(consumerDir, "tsconfig.json")], {
      cwd: consumerDir,
    });
  });
});
